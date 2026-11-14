"use strict";

/* ---------- State ---------- */
const TOKEN_KEY = "mitti_token";
const state = { token: null, user: null, cart: { items: [], count: 0, total_cents: 0 }, config: null };
let pendingNotice = null;
let afterLogin = null;
let lastOrder = null;
let searchTimer;
let productToken = 0;

try { state.token = localStorage.getItem(TOKEN_KEY); } catch { /* storage unavailable */ }

/* ---------- Helpers ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const money = (cents) => "$" + (cents / 100).toFixed(2);
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text; // textContent: user and product text can never run as HTML
  return node;
}
function when(createdAt) {
  const d = new Date(createdAt.replace(" ", "T") + "Z");
  return isNaN(d) ? createdAt : d.toLocaleString();
}
function showNotice(message, isError = false) {
  const n = $("#notice");
  n.textContent = message || "";
  n.hidden = !message;
  n.classList.toggle("is-error", Boolean(isError));
}
function go(hash, notice, isError) {
  if (notice) pendingNotice = { message: notice, isError };
  if (location.hash === hash) route(); else location.hash = hash;
}

/* ---------- API ---------- */
async function api(path, options = {}) {
  const headers = {};
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (state.token) headers.Authorization = "Bearer " + state.token;
  const res = await fetch("/api" + path, {
    method: options.method || "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (res.status === 401 && state.token && !path.startsWith("/auth/login")) {
    logout("Your session ended. Please log in again.");
    throw new Error("Please log in.");
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || "Request failed (" + res.status + ").");
    err.status = res.status;
    throw err;
  }
  return data;
}

/* ---------- Auth state ---------- */
function setSession(token, user) {
  state.token = token; state.user = user;
  try { if (token) localStorage.setItem(TOKEN_KEY, token); else localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
  renderNav();
}
function logout(notice) {
  setSession(null, null);
  state.cart = { items: [], count: 0, total_cents: 0 };
  renderCartCount();
  go("#/login", notice || "You have been logged out.");
}
function renderNav() {
  const loggedIn = Boolean(state.user);
  $("#nav-login").hidden = loggedIn;
  $("#nav-orders").hidden = !loggedIn;
  $("#logout").hidden = !loggedIn;
  $("#who").hidden = !loggedIn;
  $("#who").textContent = loggedIn ? state.user.name : "";
}
function renderCartCount() { $("#cart-count").textContent = state.cart.count; }

async function refreshCart() {
  if (!state.user) { state.cart = { items: [], count: 0, total_cents: 0 }; renderCartCount(); return; }
  state.cart = await api("/cart");
  renderCartCount();
}

/* ---------- Views ---------- */
const VIEWS = ["shop", "cart", "checkout", "receipt", "orders", "login", "register"];
const PROTECTED = ["cart", "checkout", "orders", "receipt"];

async function route() {
  let name = (location.hash.replace(/^#\/?/, "") || "shop").split("?")[0];
  if (!VIEWS.includes(name)) name = "shop";

  if (PROTECTED.includes(name) && !state.user) {
    afterLogin = "#/" + name;
    pendingNotice = { message: "Please log in to continue.", isError: false };
    name = "login";
    if (location.hash !== "#/login") history.replaceState(null, "", "#/login");
  }

  VIEWS.forEach((v) => { $("#view-" + v).hidden = v !== name; });
  document.querySelectorAll("[data-nav]").forEach((a) => a.classList.toggle("is-current", a.dataset.nav === name));
  if (pendingNotice) { showNotice(pendingNotice.message, pendingNotice.isError); pendingNotice = null; } else showNotice("");

  try {
    if (name === "shop") await loadProducts();
    if (name === "cart") { await refreshCart(); renderCart(); }
    if (name === "checkout") { await refreshCart(); if (!state.cart.items.length) return go("#/cart", "Your cart is empty."); renderCheckout(); }
    if (name === "orders") await loadOrders();
    if (name === "receipt") { if (!lastOrder) return go("#/orders"); renderReceipt(lastOrder); }
  } catch (err) {
    showNotice(err.message, true);
  }
  window.scrollTo(0, 0);
}

/* ----- Shop ----- */
async function loadProducts() {
  const token = ++productToken;
  const term = $("#search").value.trim();
  const list = await api("/products" + (term ? "?q=" + encodeURIComponent(term) : ""));
  if (token !== productToken) return;
  const ul = $("#products");
  ul.replaceChildren(...list.map(renderProduct));
  $("#no-products").hidden = list.length > 0;
}

function renderProduct(p) {
  const li = el("li", "product");
  li.dataset.id = p.id;
  li.append(el("span", "emoji", p.emoji));
  li.append(el("h3", "", p.name));
  li.append(el("p", "", p.description));
  li.append(el("p", "price", money(p.price_cents)));
  const stockClass = p.stock === 0 ? "out" : p.stock <= 5 ? "low" : "";
  li.append(el("p", "stock " + stockClass, p.stock === 0 ? "Out of stock" : p.stock <= 5 ? "Only " + p.stock + " left" : "In stock"));
  const add = el("button", "btn btn-primary", "Add to cart");
  add.type = "button";
  add.disabled = p.stock === 0;
  add.addEventListener("click", () => addToCart(p));
  li.append(add);
  return li;
}

async function addToCart(p) {
  if (!state.user) { afterLogin = "#/shop"; return go("#/login", "Log in to add items to your cart."); }
  try {
    state.cart = await api("/cart/items", { method: "POST", body: { productId: p.id, quantity: 1 } });
    renderCartCount();
    showNotice("Added " + p.name + " to your cart.");
  } catch (err) { showNotice(err.message, true); }
}

/* ----- Cart ----- */
function renderCart() {
  const { items, total_cents } = state.cart;
  $("#cart-empty").hidden = items.length > 0;
  $("#cart-foot").hidden = items.length === 0;
  $("#cart-total").textContent = money(total_cents);
  $("#cart-lines").replaceChildren(...items.map(renderLine));
}

function renderLine(item) {
  const li = el("li", "line");
  li.dataset.id = item.product_id;
  li.append(el("span", "emoji", item.emoji));
  const info = el("div");
  info.append(el("h3", "", item.name));
  info.append(el("p", "sub", money(item.price_cents) + " each"));
  if (!item.available) info.append(el("p", "warn", item.stock === 0 ? "Out of stock. Remove it to continue." : "Only " + item.stock + " in stock. Lower the quantity."));
  li.append(info);
  li.append(el("p", "line-total", money(item.line_total_cents)));

  const controls = el("div", "controls");
  const qty = el("div", "qty");
  const minus = el("button", "mini", "\u2212"); minus.type = "button"; minus.setAttribute("aria-label", "Decrease quantity of " + item.name);
  const out = el("output", "", String(item.quantity));
  const plus = el("button", "mini", "+"); plus.type = "button"; plus.setAttribute("aria-label", "Increase quantity of " + item.name);
  minus.addEventListener("click", () => setQty(item.product_id, item.quantity - 1));
  plus.addEventListener("click", () => setQty(item.product_id, item.quantity + 1));
  qty.append(minus, out, plus);
  const remove = el("button", "mini", "Remove"); remove.type = "button";
  remove.addEventListener("click", () => setQty(item.product_id, 0));
  controls.append(qty, remove);
  li.append(controls);
  return li;
}

async function setQty(productId, quantity) {
  try {
    state.cart = await api("/cart/items/" + productId, { method: "PUT", body: { quantity } });
    renderCartCount(); renderCart(); showNotice("");
  } catch (err) { showNotice(err.message, true); }
}

$("#clear-cart").addEventListener("click", async () => {
  try { state.cart = await api("/cart", { method: "DELETE" }); renderCartCount(); renderCart(); }
  catch (err) { showNotice(err.message, true); }
});
$("#to-checkout").addEventListener("click", (e) => {
  if (state.cart.items.some((i) => !i.available)) { e.preventDefault(); showNotice("Fix the items marked in red before checking out.", true); }
});

/* ----- Checkout ----- */
function renderCheckout() {
  $("#summary-lines").replaceChildren(...state.cart.items.map((i) => {
    const li = el("li");
    li.append(el("span", "", i.quantity + " \u00D7 " + i.name), el("span", "", money(i.line_total_cents)));
    return li;
  }));
  $("#summary-total").textContent = money(state.cart.total_cents);
  $("#pay-btn").textContent = "Pay " + money(state.cart.total_cents);
  $("#pay-error").textContent = "";
  if (state.config) {
    $("#mode-badge").textContent = state.config.payment === "stripe"
      ? "Stripe test mode: no real money is charged."
      : "Sandbox mode: no real money is charged.";
    $("#test-cards").replaceChildren(...state.config.testCards.map((c) => {
      const li = el("li"); li.append(el("strong", "", c.number), document.createTextNode(" \u2013 " + c.result)); return li;
    }));
  }
}

$("#card-number").addEventListener("input", (e) => {
  const digits = e.target.value.replace(/\D/g, "").slice(0, 19);
  e.target.value = digits.replace(/(.{4})/g, "$1 ").trim();
});
$("#card-exp").addEventListener("input", (e) => {
  let d = e.target.value.replace(/\D/g, "").slice(0, 4);
  e.target.value = d.length > 2 ? d.slice(0, 2) + "/" + d.slice(2) : d;
});
$("#card-cvc").addEventListener("input", (e) => { e.target.value = e.target.value.replace(/\D/g, "").slice(0, 4); });

$("#pay-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target.elements;
  const err = $("#pay-error");
  err.textContent = "";
  const card = { number: form.number.value, exp: form.exp.value, cvc: form.cvc.value };
  if (!card.number.trim() || !card.exp.trim() || !card.cvc.trim()) { err.textContent = "Fill in the card number, expiry date and security code."; return; }
  const btn = $("#pay-btn");
  btn.disabled = true; btn.textContent = "Processing...";
  try {
    lastOrder = await api("/checkout", { method: "POST", body: { card } });
    form.number.value = ""; form.exp.value = ""; form.cvc.value = "";
    await refreshCart();
    go("#/receipt");
  } catch (e2) {
    err.textContent = e2.message;
    form.cvc.value = "";
    if (e2.status === 409 || e2.status === 402 || e2.status === 502) { try { await refreshCart(); } catch { /* ignore */ } }
    btn.textContent = "Pay " + money(state.cart.total_cents);
    if (e2.status === 409) { go("#/cart", e2.message, true); }
  } finally {
    btn.disabled = false;
  }
});

/* ----- Receipt and orders ----- */
function renderReceipt(order) {
  const box = $("#receipt");
  const dl = el("dl");
  const add = (k, v) => { dl.append(el("dt", "", k), el("dd", "", v)); };
  add("Order number", "#" + order.id);
  add("Status", order.status === "paid" ? "Paid" : order.status);
  add("Total", money(order.total_cents));
  add("Paid with", order.card_brand + " ending " + order.card_last4);
  const items = el("ul");
  order.items.forEach((i) => {
    const li = el("li");
    li.append(el("span", "", i.quantity + " \u00D7 " + i.name), el("span", "", money(i.unit_price_cents * i.quantity)));
    items.append(li);
  });
  box.replaceChildren(dl, items);
}

async function loadOrders() {
  const orders = await api("/orders");
  $("#orders-empty").hidden = orders.length > 0;
  $("#orders").replaceChildren(...orders.map((o) => {
    const li = el("li", "order");
    li.dataset.id = o.id;
    const head = el("header");
    head.append(el("h3", "", "Order #" + o.id), el("span", "status " + o.status, o.status));
    li.append(head);
    const list = el("ul");
    o.items.forEach((i) => {
      const row = el("li");
      row.append(el("span", "", i.quantity + " \u00D7 " + i.name), el("span", "", money(i.unit_price_cents * i.quantity)));
      list.append(row);
    });
    li.append(list);
    li.append(el("p", "", "Total " + money(o.total_cents)));
    let meta = when(o.created_at);
    if (o.card_last4) meta += " \u00B7 " + o.card_brand + " ending " + o.card_last4;
    if (o.status === "failed" && o.failure_reason) meta += " \u00B7 " + o.failure_reason;
    li.append(el("p", "meta", meta));
    return li;
  }));
}

/* ----- Auth forms ----- */
async function submitAuth(form, path, errorEl, fields) {
  errorEl.textContent = "";
  const body = {};
  fields.forEach((f) => { body[f] = form.elements[f].value; });
  try {
    const { token, user } = await api(path, { method: "POST", body });
    setSession(token, user);
    form.reset();
    await refreshCart();
    const dest = afterLogin || "#/shop";
    afterLogin = null;
    go(dest, "Welcome, " + user.name + ".");
  } catch (err) { errorEl.textContent = err.message; }
}
$("#login-form").addEventListener("submit", (e) => {
  e.preventDefault();
  submitAuth(e.target, "/auth/login", $("#login-error"), ["email", "password"]);
});
$("#register-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = e.target.elements, err = $("#register-error");
  if (!f.name.value.trim()) { err.textContent = "Enter your name."; return; }
  if (f.password.value.length < 8) { err.textContent = "Password must be at least 8 characters."; return; }
  submitAuth(e.target, "/auth/register", err, ["name", "email", "password"]);
});
$("#logout").addEventListener("click", () => logout());

$("#search").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => loadProducts().catch((e) => showNotice(e.message, true)), 250); });
window.addEventListener("hashchange", route);

/* ---------- Start ---------- */
(async function init() {
  try { state.config = await api("/config"); } catch { /* checkout hints are optional */ }
  if (state.token) {
    try { state.user = (await api("/auth/me")).user; renderNav(); await refreshCart(); }
    catch { setSession(null, null); }
  }
  renderNav();
  await route();
})();
