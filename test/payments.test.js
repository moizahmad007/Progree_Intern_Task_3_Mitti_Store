"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createSandboxProvider, createStripeProvider, createProviderFromEnv, luhn } = require("../payments");

const good = { number: "4242424242424242", exp: "12/99", cvc: "123" };

test("luhn check", () => {
  assert.ok(luhn("4242424242424242"));
  assert.ok(luhn("4000000000000002"));
  assert.ok(!luhn("4242424242424241"));
});

test("sandbox: success, declines and brand detection", async () => {
  const p = createSandboxProvider();
  const ok = await p.charge({ card: good, orderId: 7 });
  assert.ok(ok.ok && ok.brand === "Visa" && ok.last4 === "4242" && ok.reference.startsWith("sbx_7_"));
  const mc = await p.charge({ card: { ...good, number: "5555555555554444" }, orderId: 8 });
  assert.equal(mc.brand, "Mastercard");
  const d = await p.charge({ card: { ...good, number: "4000000000000002" }, orderId: 9 });
  assert.ok(!d.ok && d.declined && /declined/i.test(d.error));
  const nsf = await p.charge({ card: { ...good, number: "4000000000009995" }, orderId: 10 });
  assert.match(nsf.error, /insufficient/i);
  assert.ok(p.validateCard({ ...good, exp: "01/20" }).error);
  assert.ok(p.validateCard(good).ok);
});

test("stripe: sends a correct test-mode PaymentIntent request and handles success", async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return { ok: true, status: 200, json: async () => ({ id: "pi_123", status: "succeeded" }) }; };
  const p = createStripeProvider({ secretKey: "sk_test_abc", fetchImpl });
  const r = await p.charge({ amountCents: 2450, currency: "usd", card: good, orderId: 42 });
  assert.deepEqual([r.ok, r.reference, r.last4], [true, "pi_123", "4242"]);
  assert.equal(seen.url, "https://api.stripe.com/v1/payment_intents");
  assert.equal(seen.init.method, "POST");
  assert.equal(seen.init.headers.Authorization, "Bearer sk_test_abc");
  assert.equal(seen.init.headers["Idempotency-Key"], "order-42");
  const body = new URLSearchParams(seen.init.body);
  assert.equal(body.get("amount"), "2450");
  assert.equal(body.get("currency"), "usd");
  assert.equal(body.get("payment_method"), "pm_card_visa");
  assert.equal(body.get("confirm"), "true");
  assert.ok(!seen.init.body.toString().includes("4242424242424242"), "raw card number is never sent");
});

test("stripe: card error becomes a decline, other errors throw", async () => {
  const decline = async () => ({ ok: false, status: 402, json: async () => ({ error: { type: "card_error", message: "Your card was declined." } }) });
  const p = createStripeProvider({ secretKey: "sk_test_abc", fetchImpl: decline });
  const r = await p.charge({ amountCents: 100, currency: "usd", card: { ...good, number: "4000000000000002" }, orderId: 1 });
  assert.ok(!r.ok && r.declined);
  const boom = async () => ({ ok: false, status: 500, json: async () => ({ error: { message: "api down" } }) });
  const p2 = createStripeProvider({ secretKey: "sk_test_abc", fetchImpl: boom });
  await assert.rejects(() => p2.charge({ amountCents: 100, currency: "usd", card: good, orderId: 2 }), /Stripe error/);
});

test("stripe: only test cards allowed, live keys refused", () => {
  const p = createStripeProvider({ secretKey: "sk_test_abc", fetchImpl: async () => {} });
  assert.ok(p.validateCard({ ...good, number: "4111111111111111" }).error);
  assert.throws(() => createStripeProvider({ secretKey: "sk_live_abc" }), /sk_test_/);
  assert.equal(createProviderFromEnv({}).name, "sandbox");
  assert.equal(createProviderFromEnv({ STRIPE_SECRET_KEY: "sk_test_x" }).name, "stripe");
});
