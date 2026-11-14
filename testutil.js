"use strict";
const { createApp } = require("./server");
const { openDb } = require("./db");
const { createSandboxProvider } = require("./payments");

const SECRET = "test-secret-test-secret-test-secret-123";
const GOOD_CARD = { number: "4242 4242 4242 4242", exp: "12/99", cvc: "123" };
const DECLINE_CARD = { number: "4000 0000 0000 0002", exp: "12/99", cvc: "123" };

async function startServer(opts = {}) {
  const db = openDb(":memory:");
  const app = createApp({ db, jwtSecret: SECRET, payments: createSandboxProvider(), authLimit: 1000, ...opts });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = "http://127.0.0.1:" + server.address().port;

  async function call(method, path, { body, token, raw, headers } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: "Bearer " + token } : {}), ...(headers || {}) },
      body: body !== undefined ? (raw ? body : JSON.stringify(body)) : undefined
    });
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, json, headers: res.headers };
  }
  let n = 0;
  async function signup(name = "Test User") {
    n++;
    const r = await call("POST", "/api/auth/register", { body: { name, email: "user" + n + "-" + Date.now() + "@example.com", password: "password123" } });
    return { token: r.json.token, user: r.json.user };
  }
  return { db, base, call, signup, close: () => server.close() };
}

module.exports = { startServer, SECRET, GOOD_CARD, DECLINE_CARD };
