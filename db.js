"use strict";
const path = require("path");
const fs = require("fs");

/* Node's built-in SQLite (Node 22.13+). Nothing native to compile. */
function openDb(file) {
  const { DatabaseSync } = require("node:sqlite");
  const target = file || path.join(__dirname, "data", "shop.db");
  if (target !== ":memory:") fs.mkdirSync(path.dirname(target), { recursive: true });
  const db = new DatabaseSync(target);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL,
      email         TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS products (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      emoji       TEXT NOT NULL DEFAULT '',
      price_cents INTEGER NOT NULL CHECK (price_cents > 0),
      stock       INTEGER NOT NULL CHECK (stock >= 0)
    );
    CREATE TABLE IF NOT EXISTS cart_items (
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id),
      quantity   INTEGER NOT NULL CHECK (quantity > 0),
      PRIMARY KEY (user_id, product_id)
    );
    CREATE TABLE IF NOT EXISTS orders (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id        INTEGER NOT NULL REFERENCES users(id),
      total_cents    INTEGER NOT NULL,
      status         TEXT NOT NULL CHECK (status IN ('pending','paid','failed')),
      payment_ref    TEXT,
      card_brand     TEXT,
      card_last4     TEXT,
      failure_reason TEXT,
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS order_items (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id         INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id       INTEGER NOT NULL REFERENCES products(id),
      name             TEXT NOT NULL,
      unit_price_cents INTEGER NOT NULL,
      quantity         INTEGER NOT NULL CHECK (quantity > 0)
    );
  `);
  return db;
}

const SEED_PRODUCTS = [
  ["Ceramic Mug", "Hand-glazed mug, 350 ml.", "\u2615", 1200, 25],
  ["Tea Set", "Teapot and four small cups.", "\uD83C\uDF75", 3450, 8],
  ["Soy Candle", "Slow-burning candle with a cedar scent.", "\uD83D\uDD6F\uFE0F", 999, 40],
  ["Notebook", "A5 notebook, 120 dotted pages.", "\uD83D\uDCD3", 650, 60],
  ["Clay Planter", "Terracotta planter with a drainage hole.", "\uD83E\uDEB4", 1500, 15],
  ["Wool Scarf", "Soft woven scarf in natural wool.", "\uD83E\uDDE3", 2200, 12],
  ["Canvas Tote", "Sturdy everyday tote bag.", "\uD83C\uDF92", 1425, 30],
  ["Table Lamp", "Warm light lamp with a clay base.", "\uD83D\uDCA1", 3999, 5],
  ["Pen Set", "Three smooth gel pens.", "\uD83D\uDD8A\uFE0F", 875, 50],
  ["Wild Honey", "Raw honey, 250 g jar.", "\uD83C\uDF6F", 1100, 20]
];

function seedProducts(db) {
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM products").get();
  if (n > 0) return;
  const insert = db.prepare("INSERT INTO products (name, description, emoji, price_cents, stock) VALUES (?, ?, ?, ?, ?)");
  db.exec("BEGIN");
  try { SEED_PRODUCTS.forEach((p) => insert.run(...p)); db.exec("COMMIT"); }
  catch (e) { db.exec("ROLLBACK"); throw e; }
}

module.exports = { openDb, seedProducts };
