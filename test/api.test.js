"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const { startServer, SECRET, GOOD_CARD, DECLINE_CARD } = require("../testutil");

let s;
before(async () => { s = await startServer(); });
after(() => s.close());

const stockOf = (id) => s.db.prepare("SELECT stock FROM products WHERE id = ?").get(id).stock;

/* ---------------- Auth ---------------- */
test("AUTH: register returns token and user, password is hashed in the database", async () => {
  const r = await s.call("POST", "/api/auth/register", { body: { name: "Moiz", email: "Moiz@Example.com ", password: "supersecret1" } });
  assert.equal(r.status, 201);
  assert.ok(r.json.token);
  assert.equal(r.json.user.email, "moiz@example.com");
  assert.equal(r.json.user.password_hash, undefined);
  const row = s.db.prepare("SELECT password_hash FROM users WHERE email = ?").get("moiz@example.com");
  assert.notEqual(row.password_hash, "supersecret1");
  assert.match(row.password_hash, /^scrypt\$\d+\$/);
  assert.ok(!row.password_hash.includes("supersecret1"));
});

test("AUTH: same password gets a different hash each time (random salt)", async () => {
  await s.call("POST", "/api/auth/register", { body: { name: "A", email: "a1@example.com", password: "samepassword" } });
  await s.call("POST", "/api/auth/register", { body: { name: "B", email: "b1@example.com", password: "samepassword" } });
  const rows = s.db.prepare("SELECT password_hash FROM users WHERE email IN ('a1@example.com','b1@example.com')").all();
  assert.notEqual(rows[0].password_hash, rows[1].password_hash);
});

test("AUTH: register validation and duplicate email", async () => {
  const bad = [
    {}, { name: "x", email: "nope", password: "password123" }, { name: "", email: "c@example.com", password: "password123" },
    { name: "x", email: "c@example.com", password: "short" }, { name: "x".repeat(61), email: "c@example.com", password: "password123" },
    { name: "x", email: "c@example.com", password: "p".repeat(129) }, { name: "x", email: 5, password: "password123" }
  ];
  for (const body of bad) assert.equal((await s.call("POST", "/api/auth/register", { body })).status, 400, JSON.stringify(body).slice(0, 60));
  const dup = await s.call("POST", "/api/auth/register", { body: { name: "Dup", email: "MOIZ@example.com", password: "supersecret1" } });
  assert.equal(dup.status, 409);
});

test("AUTH: login success, wrong password and unknown email give the same message", async () => {
  const ok = await s.call("POST", "/api/auth/login", { body: { email: "moiz@example.com", password: "supersecret1" } });
  assert.equal(ok.status, 200);
  assert.ok(ok.json.token);
  const wrong = await s.call("POST", "/api/auth/login", { body: { email: "moiz@example.com", password: "wrongpassword" } });
  const unknown = await s.call("POST", "/api/auth/login", { body: { email: "ghost@example.com", password: "supersecret1" } });
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.equal(wrong.json.error, unknown.json.error);
  assert.equal((await s.call("POST", "/api/auth/login", { body: { email: "bad", password: "x" } })).status, 400);
});

test("AUTH: JWT is required, validated, and cannot be forged", async () => {
  const { token, user } = await s.signup();
  assert.equal((await s.call("GET", "/api/auth/me", { token })).json.user.id, user.id);
  assert.equal((await s.call("GET", "/api/auth/me")).status, 401);
  assert.equal((await s.call("GET", "/api/auth/me", { token: "garbage" })).status, 401);
  const forged = jwt.sign({ sub: String(user.id) }, "a-different-secret-a-different-secret-1");
  assert.equal((await s.call("GET", "/api/auth/me", { token: forged })).status, 401);
  const expired = jwt.sign({ sub: String(user.id) }, SECRET, { expiresIn: -10 });
  assert.equal((await s.call("GET", "/api/auth/me", { token: expired })).status, 401);
  const noneAlg = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url") + "." +
    Buffer.from(JSON.stringify({ sub: String(user.id) })).toString("base64url") + ".";
  assert.equal((await s.call("GET", "/api/auth/me", { token: noneAlg })).status, 401);
  const ghost = jwt.sign({ sub: "999999" }, SECRET);
  assert.equal((await s.call("GET", "/api/auth/me", { token: ghost })).status, 401);
  for (const [m, p] of [["GET", "/api/cart"], ["POST", "/api/checkout"], ["GET", "/api/orders"], ["DELETE", "/api/cart"]]) {
    assert.equal((await s.call(m, p)).status, 401, m + " " + p);
  }
});

/* ---------------- Products ---------------- */
test("PRODUCTS: public list, search and single product", async () => {
  const all = await s.call("GET", "/api/products");
  assert.equal(all.status, 200);
  assert.equal(all.json.length, 10);
  assert.equal((await s.call("GET", "/api/products?q=mug")).json.length, 1);
  assert.equal((await s.call("GET", "/api/products?q=%25")).json.length, 0);
  assert.equal((await s.call("GET", "/api/products/1")).json.name, "Ceramic Mug");
  assert.equal((await s.call("GET", "/api/products/9999")).status, 404);
  assert.equal((await s.call("GET", "/api/products/abc")).status, 400);
});

/* ---------------- Cart ---------------- */
test("CART: add, increase, set, remove and totals use server prices", async () => {
  const { token } = await s.signup();
  let r = await s.call("POST", "/api/cart/items", { token, body: { productId: 1, quantity: 2 } });
  assert.equal(r.status, 201);
  r = await s.call("POST", "/api/cart/items", { token, body: { productId: 1 } });
  assert.equal(r.json.items[0].quantity, 3);
  await s.call("POST", "/api/cart/items", { token, body: { productId: 4, quantity: 1 } });
  r = await s.call("GET", "/api/cart", { token });
  assert.equal(r.json.count, 4);
  assert.equal(r.json.total_cents, 3 * 1200 + 650);
  r = await s.call("PUT", "/api/cart/items/1", { token, body: { quantity: 1 } });
  assert.equal(r.json.total_cents, 1200 + 650);
  r = await s.call("PUT", "/api/cart/items/1", { token, body: { quantity: 0 } });
  assert.equal(r.json.items.length, 1);
  r = await s.call("DELETE", "/api/cart/items/4", { token });
  assert.equal(r.json.items.length, 0);
});

test("CART: validation, stock limits and client cannot set prices", async () => {
  const { token } = await s.signup();
  for (const body of [{}, { productId: "1" }, { productId: 1, quantity: 0 }, { productId: 1, quantity: 1.5 }, { productId: 1, quantity: 100 }, { productId: 1, quantity: -2 }]) {
    assert.equal((await s.call("POST", "/api/cart/items", { token, body })).status, 400, JSON.stringify(body));
  }
  assert.equal((await s.call("POST", "/api/cart/items", { token, body: { productId: 9999 } })).status, 404);
  assert.equal((await s.call("POST", "/api/cart/items", { token, body: { productId: 8, quantity: 6 } })).status, 409);
  assert.equal((await s.call("PUT", "/api/cart/items/8", { token, body: { quantity: 6 } })).status, 409);
  const r = await s.call("POST", "/api/cart/items", { token, body: { productId: 1, quantity: 1, price_cents: 1 } });
  assert.equal(r.json.items[0].price_cents, 1200);
});

test("CART: each user has a separate cart and it persists across logins", async () => {
  await s.call("POST", "/api/auth/register", { body: { name: "Keep", email: "keep@example.com", password: "password123" } });
  let login = await s.call("POST", "/api/auth/login", { body: { email: "keep@example.com", password: "password123" } });
  await s.call("POST", "/api/cart/items", { token: login.json.token, body: { productId: 3, quantity: 2 } });
  const other = await s.signup();
  assert.equal((await s.call("GET", "/api/cart", { token: other.token })).json.items.length, 0);
  login = await s.call("POST", "/api/auth/login", { body: { email: "keep@example.com", password: "password123" } });
  const cart = await s.call("GET", "/api/cart", { token: login.json.token });
  assert.equal(cart.json.items[0].quantity, 2);
});

/* ---------------- Checkout ---------------- */
test("CHECKOUT: success creates a paid order, reduces stock, empties cart", async () => {
  const { token } = await s.signup();
  const before1 = stockOf(1), before4 = stockOf(4);
  await s.call("POST", "/api/cart/items", { token, body: { productId: 1, quantity: 2 } });
  await s.call("POST", "/api/cart/items", { token, body: { productId: 4, quantity: 1 } });
  const r = await s.call("POST", "/api/checkout", { token, body: { card: GOOD_CARD } });
  assert.equal(r.status, 201);
  assert.equal(r.json.status, "paid");
  assert.equal(r.json.total_cents, 2 * 1200 + 650);
  assert.equal(r.json.card_last4, "4242");
  assert.equal(r.json.card_brand, "Visa");
  assert.equal(r.json.items.length, 2);
  assert.equal(stockOf(1), before1 - 2);
  assert.equal(stockOf(4), before4 - 1);
  assert.equal((await s.call("GET", "/api/cart", { token })).json.items.length, 0);
  const orders = await s.call("GET", "/api/orders", { token });
  assert.equal(orders.json.length, 1);
  assert.equal((await s.call("GET", "/api/orders/" + r.json.id, { token })).json.status, "paid");
});

test("CHECKOUT: full card number and CVC are never stored or returned", async () => {
  const { token } = await s.signup();
  await s.call("POST", "/api/cart/items", { token, body: { productId: 3 } });
  const r = await s.call("POST", "/api/checkout", { token, body: { card: { number: "5555 5555 5555 4444", exp: "01/99", cvc: "987" } } });
  assert.equal(r.status, 201);
  assert.equal(r.json.card_last4, "4444");
  const text = JSON.stringify(r.json);
  assert.ok(!text.includes("5555555555554444") && !text.includes("987"));
  const dump = JSON.stringify([
    s.db.prepare("SELECT * FROM orders").all(), s.db.prepare("SELECT * FROM order_items").all(), s.db.prepare("SELECT * FROM users").all()
  ]);
  assert.ok(!dump.includes("5555555555554444") && !dump.includes("4242424242424242"));
});

test("CHECKOUT: declined card restores stock and cart and marks the order failed", async () => {
  const { token } = await s.signup();
  const before2 = stockOf(2);
  await s.call("POST", "/api/cart/items", { token, body: { productId: 2, quantity: 3 } });
  const r = await s.call("POST", "/api/checkout", { token, body: { card: DECLINE_CARD } });
  assert.equal(r.status, 402);
  assert.match(r.json.error, /declined/i);
  assert.equal(stockOf(2), before2);
  const cart = await s.call("GET", "/api/cart", { token });
  assert.equal(cart.json.items[0].quantity, 3);
  const orders = await s.call("GET", "/api/orders", { token });
  assert.equal(orders.json[0].status, "failed");
  assert.equal(orders.json[0].card_last4, "0002");
  const retry = await s.call("POST", "/api/checkout", { token, body: { card: GOOD_CARD } });
  assert.equal(retry.status, 201);
  assert.equal(stockOf(2), before2 - 3);
});

test("CHECKOUT: invalid card input is rejected before any stock is taken", async () => {
  const { token } = await s.signup();
  const before5 = stockOf(5);
  await s.call("POST", "/api/cart/items", { token, body: { productId: 5, quantity: 2 } });
  const bad = [
    {}, { card: null }, { card: { number: "1234 5678 9012 3456", exp: "12/99", cvc: "123" } },
    { card: { number: "4242 4242 4242 4242", exp: "01/20", cvc: "123" } },
    { card: { number: "4242 4242 4242 4242", exp: "13/99", cvc: "123" } },
    { card: { number: "4242 4242 4242 4242", exp: "12/99", cvc: "12" } },
    { card: { number: "abcd", exp: "12/99", cvc: "123" } }
  ];
  for (const body of bad) assert.equal((await s.call("POST", "/api/checkout", { token, body })).status, 400, JSON.stringify(body).slice(0, 70));
  assert.equal(stockOf(5), before5);
  assert.equal((await s.call("GET", "/api/orders", { token })).json.length, 0);
});

test("CHECKOUT: empty cart is rejected", async () => {
  const { token } = await s.signup();
  assert.equal((await s.call("POST", "/api/checkout", { token, body: { card: GOOD_CARD } })).status, 400);
});

test("CHECKOUT: stock that disappears after adding to cart blocks the order", async () => {
  const { token } = await s.signup();
  await s.call("POST", "/api/cart/items", { token, body: { productId: 8, quantity: 4 } });
  s.db.prepare("UPDATE products SET stock = 2 WHERE id = 8").run();
  const r = await s.call("POST", "/api/checkout", { token, body: { card: GOOD_CARD } });
  assert.equal(r.status, 409);
  assert.equal(stockOf(8), 2);
  assert.equal((await s.call("GET", "/api/cart", { token })).json.items[0].quantity, 4);
  assert.equal((await s.call("GET", "/api/orders", { token })).json.length, 0);
});

test("CHECKOUT: double submit from one cart creates exactly one order", async () => {
  const { token } = await s.signup();
  const before10 = stockOf(10);
  await s.call("POST", "/api/cart/items", { token, body: { productId: 10, quantity: 2 } });
  const results = await Promise.all([1, 2, 3].map(() => s.call("POST", "/api/checkout", { token, body: { card: GOOD_CARD } })));
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal(stockOf(10), before10 - 2);
  assert.equal((await s.call("GET", "/api/orders", { token })).json.filter((o) => o.status === "paid").length, 1);
});

test("CHECKOUT: last item cannot be oversold to two buyers", async () => {
  s.db.prepare("UPDATE products SET stock = 1 WHERE id = 6").run();
  const a = await s.signup(), b = await s.signup();
  assert.equal((await s.call("POST", "/api/cart/items", { token: a.token, body: { productId: 6 } })).status, 201);
  assert.equal((await s.call("POST", "/api/cart/items", { token: b.token, body: { productId: 6 } })).status, 201);
  const [ra, rb] = await Promise.all([
    s.call("POST", "/api/checkout", { token: a.token, body: { card: GOOD_CARD } }),
    s.call("POST", "/api/checkout", { token: b.token, body: { card: GOOD_CARD } })
  ]);
  assert.deepEqual([ra.status, rb.status].sort(), [201, 409]);
  assert.equal(stockOf(6), 0);
  assert.equal((await s.call("POST", "/api/cart/items", { token: a.token, body: { productId: 6 } })).status, 409);
});

test("ORDERS: a user cannot read another user's order", async () => {
  const a = await s.signup(), b = await s.signup();
  await s.call("POST", "/api/cart/items", { token: a.token, body: { productId: 9 } });
  const order = await s.call("POST", "/api/checkout", { token: a.token, body: { card: GOOD_CARD } });
  assert.equal((await s.call("GET", "/api/orders/" + order.json.id, { token: b.token })).status, 404);
  assert.equal((await s.call("GET", "/api/orders", { token: b.token })).json.length, 0);
  assert.equal((await s.call("GET", "/api/orders/abc", { token: a.token })).status, 400);
});

/* ---------------- Security ---------------- */
test("SECURITY: headers, bad JSON, SQL injection text and unknown routes", async () => {
  const r = await s.call("GET", "/api/products");
  assert.equal(r.headers.get("x-powered-by"), null);
  assert.ok(r.headers.get("content-security-policy"));
  assert.equal((await s.call("POST", "/api/auth/login", { body: "{bad", raw: true })).status, 400);
  assert.equal((await s.call("GET", "/api/products?q=" + encodeURIComponent("' OR 1=1 --"))).json.length, 0);
  const inj = await s.call("POST", "/api/auth/login", { body: { email: "x@example.com' OR '1'='1", password: "x" } });
  assert.equal(inj.status, 400);
  assert.equal((await s.call("GET", "/api/nothing")).status, 404);
  assert.equal((await s.call("GET", "/api/products")).status, 200);
});

test("SECURITY: login and register are rate limited", async () => {
  const limited = await startServer({ authLimit: 3 });
  try {
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await limited.call("POST", "/api/auth/login", { body: { email: "a@example.com", password: "wrongpass" } })).status);
    assert.deepEqual(codes, [401, 401, 401, 429, 429]);
  } finally { limited.close(); }
});

test("PAYMENT FAILURE: provider outage releases stock and cart and reports 502", async () => {
  const broken = await startServer({ payments: { name: "broken", validateCard: () => ({ ok: true }), charge: async () => { throw new Error("network down"); } } });
  try {
    const { token } = await broken.signup();
    const before1 = broken.db.prepare("SELECT stock FROM products WHERE id = 1").get().stock;
    await broken.call("POST", "/api/cart/items", { token, body: { productId: 1, quantity: 2 } });
    const r = await broken.call("POST", "/api/checkout", { token, body: { card: GOOD_CARD } });
    assert.equal(r.status, 502);
    assert.equal(broken.db.prepare("SELECT stock FROM products WHERE id = 1").get().stock, before1);
    assert.equal((await broken.call("GET", "/api/cart", { token })).json.items[0].quantity, 2);
    assert.equal((await broken.call("GET", "/api/orders", { token })).json[0].status, "failed");
  } finally { broken.close(); }
});
