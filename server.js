"use strict";
const path = require("path");
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { openDb, seedProducts } = require("./db");
const { hashPassword, verifyPassword, fakeVerify, resolveSecret, signToken, requireAuth } = require("./auth");
const { createProviderFromEnv } = require("./payments");

const CURRENCY = "usd";
const MAX_QTY = 99;

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isInt = (v) => Number.isInteger(v);

function parseCredentials(body, { needName }) {
  if (!body || typeof body !== "object") throw new HttpError(400, "Request body must be JSON.");
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!EMAIL_RE.test(email) || email.length > 254) throw new HttpError(400, "Enter a valid email address.");
  if (needName) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name.length < 1 || name.length > 60) throw new HttpError(400, "Name must be 1 to 60 characters.");
    if (password.length < 8 || password.length > 128) throw new HttpError(400, "Password must be 8 to 128 characters.");
    return { name, email, password };
  }
  if (!password || password.length > 128) throw new HttpError(400, "Enter your password.");
  return { email, password };
}

function createApp(options = {}) {
  const db = options.db || openDb();
  seedProducts(db);
  const secret = resolveSecret(options.jwtSecret);
  const payments = options.payments || createProviderFromEnv();
  const authLimit = options.authLimit ?? 20;
  const apiLimit = options.apiLimit ?? 300;

  const app = express();
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(express.json({ limit: "10kb" }));
  app.use("/api", rateLimit({ windowMs: 60_000, limit: apiLimit, standardHeaders: true, legacyHeaders: false }));
  const authLimiter = rateLimit({
    windowMs: 15 * 60_000, limit: authLimit, standardHeaders: true, legacyHeaders: false,
    message: { error: "Too many attempts. Please try again in a few minutes." }
  });
  const auth = requireAuth(secret, db);

  /* Run fn inside a transaction (node:sqlite is synchronous, so nothing can interleave). */
  function tx(fn) {
    db.exec("BEGIN IMMEDIATE");
    try { const out = fn(); db.exec("COMMIT"); return out; }
    catch (e) { db.exec("ROLLBACK"); throw e; }
  }
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  const q = {
    userByEmail: db.prepare("SELECT * FROM users WHERE email = ?"),
    insertUser: db.prepare("INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)"),
    products: db.prepare("SELECT id, name, description, emoji, price_cents, stock FROM products ORDER BY id"),
    productsSearch: db.prepare("SELECT id, name, description, emoji, price_cents, stock FROM products WHERE name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' ORDER BY id"),
    product: db.prepare("SELECT id, name, description, emoji, price_cents, stock FROM products WHERE id = ?"),
    cartLines: db.prepare(`SELECT c.product_id, c.quantity, p.name, p.emoji, p.price_cents, p.stock
                           FROM cart_items c JOIN products p ON p.id = c.product_id
                           WHERE c.user_id = ? ORDER BY p.name`),
    cartQty: db.prepare("SELECT quantity FROM cart_items WHERE user_id = ? AND product_id = ?"),
    cartSet: db.prepare(`INSERT INTO cart_items (user_id, product_id, quantity) VALUES (?, ?, ?)
                         ON CONFLICT(user_id, product_id) DO UPDATE SET quantity = excluded.quantity`),
    cartAdd: db.prepare(`INSERT INTO cart_items (user_id, product_id, quantity) VALUES (?, ?, ?)
                         ON CONFLICT(user_id, product_id) DO UPDATE SET quantity = quantity + excluded.quantity`),
    cartDelete: db.prepare("DELETE FROM cart_items WHERE user_id = ? AND product_id = ?"),
    cartClear: db.prepare("DELETE FROM cart_items WHERE user_id = ?"),
    insertOrder: db.prepare("INSERT INTO orders (user_id, total_cents, status) VALUES (?, ?, 'pending')"),
    insertItem: db.prepare("INSERT INTO order_items (order_id, product_id, name, unit_price_cents, quantity) VALUES (?, ?, ?, ?, ?)"),
    takeStock: db.prepare("UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?"),
    giveStock: db.prepare("UPDATE products SET stock = stock + ? WHERE id = ?"),
    orderItems: db.prepare("SELECT product_id, name, unit_price_cents, quantity FROM order_items WHERE order_id = ? ORDER BY id"),
    markPaid: db.prepare("UPDATE orders SET status = 'paid', payment_ref = ?, card_brand = ?, card_last4 = ? WHERE id = ?"),
    markFailed: db.prepare("UPDATE orders SET status = 'failed', failure_reason = ?, card_brand = ?, card_last4 = ? WHERE id = ?"),
    order: db.prepare("SELECT id, total_cents, status, card_brand, card_last4, failure_reason, created_at FROM orders WHERE id = ? AND user_id = ?"),
    orders: db.prepare("SELECT id, total_cents, status, card_brand, card_last4, failure_reason, created_at FROM orders WHERE user_id = ? ORDER BY id DESC")
  };

  const cartView = (userId) => {
    const items = q.cartLines.all(userId).map((l) => ({
      product_id: l.product_id, name: l.name, emoji: l.emoji, price_cents: l.price_cents,
      quantity: l.quantity, stock: l.stock, line_total_cents: l.price_cents * l.quantity,
      available: l.quantity <= l.stock
    }));
    return {
      items,
      count: items.reduce((n, i) => n + i.quantity, 0),
      total_cents: items.reduce((n, i) => n + i.line_total_cents, 0),
      currency: CURRENCY
    };
  };
  const orderView = (row) => ({ ...row, currency: CURRENCY, items: q.orderItems.all(row.id) });

  function productIdParam(req) {
    const id = Number(req.params.productId);
    if (!isInt(id) || id < 1) throw new HttpError(400, "Invalid product id.");
    return id;
  }

  /* ---------- Public ---------- */
  app.get("/api/config", (req, res) => res.json({
    payment: payments.name, currency: CURRENCY,
    testCards: [
      { number: "4242 4242 4242 4242", result: "Payment succeeds" },
      { number: "4000 0000 0000 0002", result: "Card declined" },
      { number: "4000 0000 0000 9995", result: "Insufficient funds" }
    ]
  }));

  app.get("/api/products", (req, res) => {
    const term = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (!term) return res.json(q.products.all());
    const like = "%" + term.replace(/[\\%_]/g, "\\$&") + "%";
    res.json(q.productsSearch.all(like, like));
  });

  app.get("/api/products/:productId", (req, res) => {
    const product = q.product.get(productIdParam(req));
    if (!product) throw new HttpError(404, "Product not found.");
    res.json(product);
  });

  /* ---------- Auth (JWT) ---------- */
  app.post("/api/auth/register", authLimiter, wrap(async (req, res) => {
    const { name, email, password } = parseCredentials(req.body, { needName: true });
    if (q.userByEmail.get(email)) throw new HttpError(409, "An account with this email already exists.");
    const hash = await hashPassword(password);
    let id;
    try { id = Number(q.insertUser.run(name, email, hash).lastInsertRowid); }
    catch (e) { if (/UNIQUE/i.test(String(e.message))) throw new HttpError(409, "An account with this email already exists."); throw e; }
    const user = { id, name, email };
    res.status(201).json({ token: signToken(user, secret), user: { id, name, email } });
  }));

  app.post("/api/auth/login", authLimiter, wrap(async (req, res) => {
    const { email, password } = parseCredentials(req.body, { needName: false });
    const row = q.userByEmail.get(email);
    const ok = row ? await verifyPassword(password, row.password_hash) : (await fakeVerify(password), false);
    if (!ok) throw new HttpError(401, "Invalid email or password.");
    res.json({ token: signToken(row, secret), user: { id: row.id, name: row.name, email: row.email } });
  }));

  app.get("/api/auth/me", auth, (req, res) => res.json({ user: req.user }));

  /* ---------- Cart (saved per user in the database) ---------- */
  app.get("/api/cart", auth, (req, res) => res.json(cartView(req.user.id)));

  app.post("/api/cart/items", auth, (req, res) => {
    const { productId } = req.body || {};
    const quantity = req.body && req.body.quantity !== undefined ? req.body.quantity : 1;
    if (!isInt(productId) || productId < 1) throw new HttpError(400, "Invalid product id.");
    if (!isInt(quantity) || quantity < 1 || quantity > MAX_QTY) throw new HttpError(400, "Quantity must be a whole number from 1 to " + MAX_QTY + ".");
    const product = q.product.get(productId);
    if (!product) throw new HttpError(404, "Product not found.");
    const existing = q.cartQty.get(req.user.id, productId);
    const wanted = (existing ? existing.quantity : 0) + quantity;
    if (wanted > product.stock) throw new HttpError(409, product.stock === 0 ? product.name + " is out of stock." : "Only " + product.stock + " of " + product.name + " in stock.");
    if (wanted > MAX_QTY) throw new HttpError(400, "You can order at most " + MAX_QTY + " of one item.");
    q.cartAdd.run(req.user.id, productId, quantity);
    res.status(201).json(cartView(req.user.id));
  });

  app.put("/api/cart/items/:productId", auth, (req, res) => {
    const productId = productIdParam(req);
    const quantity = req.body && req.body.quantity;
    if (!isInt(quantity) || quantity < 0 || quantity > MAX_QTY) throw new HttpError(400, "Quantity must be a whole number from 0 to " + MAX_QTY + ".");
    if (quantity === 0) { q.cartDelete.run(req.user.id, productId); return res.json(cartView(req.user.id)); }
    const product = q.product.get(productId);
    if (!product) throw new HttpError(404, "Product not found.");
    if (quantity > product.stock) throw new HttpError(409, "Only " + product.stock + " of " + product.name + " in stock.");
    q.cartSet.run(req.user.id, productId, quantity);
    res.json(cartView(req.user.id));
  });

  app.delete("/api/cart/items/:productId", auth, (req, res) => {
    q.cartDelete.run(req.user.id, productIdParam(req));
    res.json(cartView(req.user.id));
  });

  app.delete("/api/cart", auth, (req, res) => { q.cartClear.run(req.user.id); res.json(cartView(req.user.id)); });

  /* ---------- Checkout ---------- */
  /* Step 1 (one transaction): check stock, create the order from the server-side prices,
     take the stock and move the cart into the order. Because the cart is emptied here,
     a double-click or a second tab cannot create a second order from the same cart. */
  function reserve(userId) {
    return tx(() => {
      const lines = q.cartLines.all(userId);
      if (!lines.length) throw new HttpError(400, "Your cart is empty.");
      for (const l of lines) {
        if (l.quantity > l.stock) {
          throw new HttpError(409, l.stock === 0 ? l.name + " is out of stock." : "Only " + l.stock + " of " + l.name + " in stock.");
        }
      }
      const total = lines.reduce((n, l) => n + l.price_cents * l.quantity, 0);
      const orderId = Number(q.insertOrder.run(userId, total).lastInsertRowid);
      for (const l of lines) {
        q.insertItem.run(orderId, l.product_id, l.name, l.price_cents, l.quantity);
        if (q.takeStock.run(l.quantity, l.product_id, l.quantity).changes !== 1) throw new HttpError(409, "Only " + l.stock + " of " + l.name + " in stock.");
      }
      q.cartClear.run(userId);
      return { orderId, total };
    });
  }

  /* Step 3 (payment failed): put the stock and the cart back, mark the order failed. */
  function release(userId, orderId, reason, card) {
    tx(() => {
      for (const it of q.orderItems.all(orderId)) {
        q.giveStock.run(it.quantity, it.product_id);
        q.cartAdd.run(userId, it.product_id, it.quantity);
      }
      q.markFailed.run(reason, (card && card.brand) || null, (card && card.last4) || null, orderId);
    });
  }

  app.post("/api/checkout", auth, wrap(async (req, res) => {
    const card = req.body && req.body.card;
    const check = payments.validateCard(card);
    if (check.error) throw new HttpError(400, check.error);

    const { orderId, total } = reserve(req.user.id);

    let result;
    try {
      result = await payments.charge({ amountCents: total, currency: CURRENCY, card, orderId });
    } catch (err) {
      console.error("Payment provider error:", err.message);
      release(req.user.id, orderId, "Payment provider error", null);
      throw new HttpError(502, "The payment service is unavailable. You were not charged. Please try again.");
    }

    if (!result.ok) {
      release(req.user.id, orderId, result.error, result);
      throw new HttpError(402, result.error, { order_id: orderId });
    }

    /* Step 2 (payment succeeded): the stock was already taken, so just confirm the order. */
    q.markPaid.run(result.reference, result.brand, result.last4, orderId);
    res.status(201).json(orderView(q.order.get(orderId, req.user.id)));
  }));

  /* ---------- Orders ---------- */
  app.get("/api/orders", auth, (req, res) => res.json(q.orders.all(req.user.id).map(orderView)));

  app.get("/api/orders/:id", auth, (req, res) => {
    const id = Number(req.params.id);
    if (!isInt(id) || id < 1) throw new HttpError(400, "Invalid order id.");
    const row = q.order.get(id, req.user.id); // scoped to the logged-in user
    if (!row) throw new HttpError(404, "Order not found.");
    res.json(orderView(row));
  });

  app.use("/api", (req, res) => res.status(404).json({ error: "Route not found." }));
  app.use(express.static(path.join(__dirname, "public")));

  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...(err.extra || {}) });
    if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Invalid JSON." });
    if (err.type === "entity.too.large") return res.status(413).json({ error: "Request body is too large." });
    console.error(err);
    res.status(500).json({ error: "Something went wrong on the server." });
  });

  app.locals.db = db;
  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, () => console.log("Shop running at http://localhost:" + port));
}

module.exports = { createApp };
