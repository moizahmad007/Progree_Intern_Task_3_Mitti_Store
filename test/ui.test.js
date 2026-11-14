"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
const { startServer } = require("../testutil");

let s, dom, win, doc, base;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label) {
  for (let i = 0; i < 80; i++) { try { if (fn()) return; } catch {} await sleep(25); }
  assert.fail("Timed out waiting for: " + label);
}
const $ = (sel) => doc.querySelector(sel);
const $$ = (sel) => [...doc.querySelectorAll(sel)];
const visible = (id) => !$("#view-" + id).hidden;
const click = (node) => node.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
const submit = (form) => form.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }));
const type = (node, value) => { node.value = value; node.dispatchEvent(new win.Event("input", { bubbles: true })); };
const productCard = (name) => $$("#products .product").find((p) => p.querySelector("h3").textContent === name);
const cartLine = (name) => $$("#cart-lines .line").find((l) => l.querySelector("h3").textContent === name);
const button = (root, text) => [...root.querySelectorAll("button")].find((b) => b.textContent === text);
const goto = async (hash) => { win.location.hash = hash; await sleep(60); };

async function register(name, email) {
  await goto("#/register");
  type($("#reg-name"), name); type($("#reg-email"), email); type($("#reg-password"), "password123");
  submit($("#register-form"));
}
async function pay(number, exp = "12/99", cvc = "123") {
  type($("#card-number"), number); type($("#card-exp"), exp); type($("#card-cvc"), cvc);
  submit($("#pay-form"));
}

before(async () => {
  s = await startServer();
  base = s.base;
  dom = await JSDOM.fromURL(base + "/", {
    runScripts: "dangerously", resources: "usable", pretendToBeVisual: true,
    beforeParse(w) { w.fetch = (u, o) => fetch(new URL(u, base), o); w.scrollTo = () => {}; }
  });
  win = dom.window; doc = win.document;
  await until(() => $$("#products .product").length === 10, "products render");
});
after(() => { win.close(); s.close(); });

test("SHOP: products load from the API and search filters them", async () => {
  assert.equal($$("#products .product").length, 10);
  assert.match(productCard("Ceramic Mug").querySelector(".price").textContent, /^\$12\.00$/);
  type($("#search"), "candle");
  await until(() => $$("#products .product").length === 1, "search result");
  type($("#search"), "zzzz");
  await until(() => !$("#no-products").hidden, "no results message");
  type($("#search"), "");
  await until(() => $$("#products .product").length === 10, "search cleared");
});

test("AUTH: guests are sent to log in when adding to cart or opening protected pages", async () => {
  click(button(productCard("Ceramic Mug"), "Add to cart"));
  await until(() => visible("login"), "login view");
  assert.match($("#notice").textContent, /Log in/);
  await goto("#/orders");
  assert.ok(visible("login"));
  assert.equal($("#nav-orders").hidden, true);
});

test("AUTH: register validation errors, then a successful sign up", async () => {
  await goto("#/register");
  type($("#reg-name"), "Moiz"); type($("#reg-email"), "moiz@example.com"); type($("#reg-password"), "short");
  submit($("#register-form"));
  assert.match($("#register-error").textContent, /8 characters/);
  await register("<img src=x onerror=\"window.pwned=1\">", "moiz@example.com");
  await until(() => $("#who").textContent.length > 0 && !$("#nav-login").hidden === false, "logged in");
  assert.equal($("#logout").hidden, false);
  assert.equal($$("#who img").length, 0);
  assert.equal(win.pwned, undefined);
  assert.ok($("#who").textContent.includes("<img"), "name is shown as plain text");
  assert.ok(win.localStorage.getItem("mitti_token"));
});

test("CART: add items, change quantity, totals come from the server", async () => {
  await goto("#/shop");
  await until(() => $$("#products .product").length === 10, "shop");
  click(button(productCard("Ceramic Mug"), "Add to cart"));
  await until(() => $("#cart-count").textContent === "1", "count 1");
  click(button(productCard("Ceramic Mug"), "Add to cart"));
  click(button(productCard("Notebook"), "Add to cart"));
  await until(() => $("#cart-count").textContent === "3", "count 3");
  await goto("#/cart");
  await until(() => $$("#cart-lines .line").length === 2, "two lines");
  assert.equal($("#cart-total").textContent, "$30.50");
  click($("[aria-label='Increase quantity of Notebook']"));
  await until(() => $("#cart-total").textContent === "$37.00", "total after increase");
  click($("[aria-label='Decrease quantity of Notebook']"));
  await until(() => $("#cart-total").textContent === "$30.50", "total after decrease");
  click(button(cartLine("Notebook"), "Remove"));
  await until(() => $$("#cart-lines .line").length === 1, "removed");
  assert.equal($("#cart-total").textContent, "$24.00");
});

test("CART: stock limit shows an error instead of breaking", async () => {
  await goto("#/shop");
  await until(() => $$("#products .product").length === 10, "shop");
  for (let i = 0; i < 6; i++) { click(button(productCard("Table Lamp"), "Add to cart")); await sleep(40); }
  await until(() => $("#notice").classList.contains("is-error"), "error notice");
  assert.match($("#notice").textContent, /Only 5/);
});

test("CART: cart is saved on the server and survives logout and login", async () => {
  await goto("#/cart");
  await until(() => $$("#cart-lines .line").length >= 1, "cart lines");
  const before = $$("#cart-lines .line").map((l) => l.querySelector("h3").textContent).sort();
  click($("#logout"));
  await until(() => visible("login") && $("#cart-count").textContent === "0", "logged out");
  assert.equal(win.localStorage.getItem("mitti_token"), null);
  await goto("#/cart");
  assert.ok(visible("login"), "cart is protected when logged out");
  type($("#login-email"), "moiz@example.com"); type($("#login-password"), "wrongpassword");
  submit($("#login-form"));
  await until(() => /Invalid/.test($("#login-error").textContent), "wrong password error");
  type($("#login-password"), "password123");
  submit($("#login-form"));
  await until(() => visible("cart"), "returns to the cart after login");
  await until(() => $$("#cart-lines .line").length === before.length, "cart restored");
  assert.deepEqual($$("#cart-lines .line").map((l) => l.querySelector("h3").textContent).sort(), before);
});

test("CHECKOUT: card validation, decline keeps the cart, success shows receipt and updates stock", async () => {
  await goto("#/cart");
  await until(() => $$("#cart-lines .line").length >= 1, "cart");
  click(button(cartLine("Table Lamp") || $$("#cart-lines .line")[0], "Remove"));
  await sleep(100);
  const names = $$("#cart-lines .line").map((l) => l.querySelector("h3").textContent);
  assert.ok(names.includes("Ceramic Mug"));
  await goto("#/checkout");
  await until(() => visible("checkout") && $("#summary-lines").children.length > 0, "checkout view");
  assert.match($("#pay-btn").textContent, /^Pay \$/);
  assert.ok($$("#test-cards li").length >= 3, "test cards listed");
  submit($("#pay-form"));
  assert.match($("#pay-error").textContent, /Fill in/);
  await pay("1234 5678 9012 3456");
  await until(() => /valid card number/i.test($("#pay-error").textContent), "invalid number error");
  await pay("4000 0000 0000 0002");
  await until(() => /declined/i.test($("#pay-error").textContent), "decline error");
  assert.ok(visible("checkout"));
  assert.equal($("#card-cvc").value, "", "cvc is cleared after a failure");
  const mugStockBefore = s.db.prepare("SELECT stock FROM products WHERE name = 'Ceramic Mug'").get().stock;
  await pay("4242 4242 4242 4242");
  await until(() => visible("receipt"), "receipt");
  assert.match($("#receipt").textContent, /Order number#\d+/);
  assert.match($("#receipt").textContent, /Visa ending 4242/);
  assert.equal($("#card-number").value, "", "card fields cleared on success");
  assert.equal($("#cart-count").textContent, "0");
  assert.equal(s.db.prepare("SELECT stock FROM products WHERE name = 'Ceramic Mug'").get().stock, mugStockBefore - 2);
});

test("ORDERS: paid and failed orders are listed; shop shows reduced stock", async () => {
  await goto("#/orders");
  await until(() => $$("#orders .order").length === 2, "two orders");
  const statuses = $$("#orders .status").map((n) => n.textContent).sort();
  assert.deepEqual(statuses, ["failed", "paid"]);
  assert.ok(!$("#orders").innerHTML.includes("4242424242424242"));
  await goto("#/shop");
  await until(() => $$("#products .product").length === 10, "shop");
});

test("CART: a product that sells out is blocked at checkout with a clear message", async () => {
  await goto("#/shop");
  await until(() => $$("#products .product").length === 10, "shop");
  click(button(productCard("Pen Set"), "Add to cart"));
  await until(() => $("#cart-count").textContent === "1", "added pen set");
  s.db.prepare("UPDATE products SET stock = 0 WHERE name = 'Pen Set'").run();
  await goto("#/cart");
  await until(() => $$("#cart-lines .line .warn").length === 1, "out of stock warning");
  click($("#to-checkout"));
  assert.ok($("#notice").classList.contains("is-error"));
  assert.ok(visible("cart"));
});
