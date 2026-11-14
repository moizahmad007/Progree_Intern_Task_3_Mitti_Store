"use strict";
const crypto = require("crypto");
const { promisify } = require("util");
const jwt = require("jsonwebtoken");

const scrypt = promisify(crypto.scrypt);
const N = 16384, KEYLEN = 64;

/* Passwords are stored as scrypt hashes with a random salt, never as plain text. */
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, KEYLEN, { N, r: 8, p: 1 });
  return ["scrypt", N, salt.toString("base64"), key.toString("base64")].join("$");
}

async function verifyPassword(password, stored) {
  const parts = String(stored).split("$");
  if (parts.length !== 4 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[2], "base64");
  const expected = Buffer.from(parts[3], "base64");
  const actual = await scrypt(password, salt, expected.length, { N: Number(parts[1]), r: 8, p: 1 });
  return crypto.timingSafeEqual(actual, expected);
}

let dummyHash;
/* Compare against a fake hash when the email is unknown so response time does not reveal which emails exist. */
async function fakeVerify(password) {
  dummyHash = dummyHash || (await hashPassword("not-a-real-password"));
  await verifyPassword(password, dummyHash);
}

function resolveSecret(provided) {
  const secret = provided || process.env.JWT_SECRET;
  if (secret) {
    if (secret.length < 32) throw new Error("JWT_SECRET must be at least 32 characters.");
    return secret;
  }
  if (process.env.NODE_ENV === "production") throw new Error("JWT_SECRET is required in production.");
  console.warn("JWT_SECRET is not set. Using a random secret: logins reset whenever the server restarts.");
  return crypto.randomBytes(32).toString("hex");
}

const signToken = (user, secret) => jwt.sign({ sub: String(user.id) }, secret, { algorithm: "HS256", expiresIn: "2h" });

function requireAuth(secret, db) {
  const findUser = db.prepare("SELECT id, name, email FROM users WHERE id = ?");
  return (req, res, next) => {
    const header = req.get("authorization") || "";
    const match = /^Bearer (.+)$/.exec(header);
    if (!match) return res.status(401).json({ error: "Please log in." });
    try {
      const payload = jwt.verify(match[1], secret, { algorithms: ["HS256"] });
      const user = findUser.get(Number(payload.sub));
      if (!user) return res.status(401).json({ error: "Please log in." });
      req.user = user;
      next();
    } catch {
      res.status(401).json({ error: "Your session has expired. Please log in again." });
    }
  };
}

module.exports = { hashPassword, verifyPassword, fakeVerify, resolveSecret, signToken, requireAuth };
