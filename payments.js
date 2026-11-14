"use strict";
/*
  Payment sandbox. Two providers share one interface:
    validateCard(card)  -> { error } | { ok: true }      (checked BEFORE any stock is reserved)
    charge({ amountCents, currency, card, orderId })     -> { ok, reference, brand, last4 } | { ok:false, declined:true, error }

  "sandbox" runs fully offline with Stripe's well-known test card numbers.
  "stripe"  calls the Stripe API in test mode when STRIPE_SECRET_KEY (sk_test_...) is set.
  Card numbers and CVC are used only inside charge() and are never stored or logged.
*/

const TEST_CARDS = {
  "4242424242424242": { outcome: "success", stripe: "pm_card_visa" },
  "5555555555554444": { outcome: "success", stripe: "pm_card_mastercard" },
  "4000000000000002": { outcome: "declined", message: "Your card was declined.", stripe: "pm_card_chargeDeclined" },
  "4000000000009995": { outcome: "declined", message: "Your card has insufficient funds.", stripe: "pm_card_chargeDeclinedInsufficientFunds" },
  "4000000000000069": { outcome: "declined", message: "Your card has expired.", stripe: "pm_card_chargeDeclinedExpiredCard" }
};

function luhn(number) {
  let sum = 0, alt = false;
  for (let i = number.length - 1; i >= 0; i--) {
    let d = Number(number[i]);
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d; alt = !alt;
  }
  return sum % 10 === 0;
}

function brandOf(number) {
  if (/^4/.test(number)) return "Visa";
  if (/^(5[1-5]|2[2-7])/.test(number)) return "Mastercard";
  if (/^3[47]/.test(number)) return "Amex";
  return "Card";
}

function normalize(card) {
  if (!card || typeof card !== "object") return { error: "Card details are required." };
  const number = String(card.number ?? "").replace(/[\s-]/g, "");
  const cvc = String(card.cvc ?? "").trim();
  const exp = String(card.exp ?? "").trim();
  if (!/^\d{13,19}$/.test(number) || !luhn(number)) return { error: "Enter a valid card number." };
  const m = /^(\d{2})\s*\/\s*(\d{2})$/.exec(exp);
  if (!m || Number(m[1]) < 1 || Number(m[1]) > 12) return { error: "Enter the expiry date as MM/YY." };
  const now = new Date();
  const expYear = 2000 + Number(m[2]), expMonth = Number(m[1]);
  if (expYear < now.getFullYear() || (expYear === now.getFullYear() && expMonth < now.getMonth() + 1)) {
    return { error: "This card has expired." };
  }
  if (!/^\d{3,4}$/.test(cvc)) return { error: "Enter the 3 or 4 digit security code." };
  return { number, brand: brandOf(number), last4: number.slice(-4) };
}

function createSandboxProvider() {
  return {
    name: "sandbox",
    validateCard(card) { const c = normalize(card); return c.error ? { error: c.error } : { ok: true }; },
    async charge({ card, orderId }) {
      const c = normalize(card);
      if (c.error) return { ok: false, declined: false, error: c.error };
      const known = TEST_CARDS[c.number];
      if (known && known.outcome === "declined") {
        return { ok: false, declined: true, error: known.message, brand: c.brand, last4: c.last4 };
      }
      return { ok: true, reference: "sbx_" + orderId + "_" + Date.now().toString(36), brand: c.brand, last4: c.last4 };
    }
  };
}

function createStripeProvider({ secretKey, fetchImpl = fetch }) {
  if (!/^sk_test_/.test(secretKey || "")) throw new Error("STRIPE_SECRET_KEY must be a test key starting with sk_test_.");
  return {
    name: "stripe",
    validateCard(card) {
      const c = normalize(card);
      if (c.error) return { error: c.error };
      if (!TEST_CARDS[c.number]) return { error: "In Stripe test mode use one of the listed test card numbers." };
      return { ok: true };
    },
    async charge({ amountCents, currency, card, orderId }) {
      const c = normalize(card);
      if (c.error) return { ok: false, declined: false, error: c.error };
      const known = TEST_CARDS[c.number];
      if (!known) return { ok: false, declined: false, error: "In Stripe test mode use one of the listed test card numbers." };
      const body = new URLSearchParams({
        amount: String(amountCents),
        currency,
        payment_method: known.stripe,
        confirm: "true",
        "automatic_payment_methods[enabled]": "true",
        "automatic_payment_methods[allow_redirects]": "never",
        description: "Order " + orderId,
        "metadata[order_id]": String(orderId)
      });
      const res = await fetchImpl("https://api.stripe.com/v1/payment_intents", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + secretKey,
          "Content-Type": "application/x-www-form-urlencoded",
          "Idempotency-Key": "order-" + orderId
        },
        body
      });
      const data = await res.json();
      if (res.ok && data.status === "succeeded") return { ok: true, reference: data.id, brand: c.brand, last4: c.last4 };
      if (res.status === 402 || (data.error && data.error.type === "card_error")) {
        return { ok: false, declined: true, error: (data.error && data.error.message) || "Your card was declined.", brand: c.brand, last4: c.last4 };
      }
      throw new Error("Stripe error: " + ((data.error && data.error.message) || res.status));
    }
  };
}

function createProviderFromEnv(env = process.env) {
  return env.STRIPE_SECRET_KEY ? createStripeProvider({ secretKey: env.STRIPE_SECRET_KEY }) : createSandboxProvider();
}

module.exports = { createSandboxProvider, createStripeProvider, createProviderFromEnv, luhn, normalize, TEST_CARDS };
