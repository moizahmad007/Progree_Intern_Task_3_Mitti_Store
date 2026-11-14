# Mitti Store: Secure E-Commerce Engine

Full stack online store with user accounts, a saved shopping cart, a payment sandbox and stock control.

- **Frontend:** HTML, CSS and vanilla JavaScript (single page, hash routes)
- **Backend:** Node.js + Express REST API
- **Database:** SQLite (`data/shop.db`, created and seeded automatically) via Node's built-in `node:sqlite`
- **Auth:** JSON Web Tokens (HS256, 2 hour expiry). Passwords are hashed with scrypt and a random salt
- **Payments:** built-in offline sandbox, or the real Stripe API in test mode

## Run it

Needs **Node.js 22.13 or newer** (`node -v`).

```bash
npm install
cp .env.example .env      # then put a long random value in JWT_SECRET
npm start
```

Open http://localhost:3000. Without `JWT_SECRET` the server still starts in development with a random secret (you are logged out on every restart) and refuses to start when `NODE_ENV=production`.

Node prints an "ExperimentalWarning: SQLite" line on start. That is normal.

## Test cards (sandbox mode)

| Number | Result |
| --- | --- |
| 4242 4242 4242 4242 | Payment succeeds |
| 5555 5555 5555 4444 | Payment succeeds (Mastercard) |
| 4000 0000 0000 0002 | Card declined |
| 4000 0000 0000 9995 | Insufficient funds |

Use any future expiry (for example 12/30) and any 3 digit code.

## Use real Stripe test mode (optional)

Put a test secret key in `.env`:

```
STRIPE_SECRET_KEY=sk_test_...
```

The server then creates a PaymentIntent with Stripe's test payment methods, so the same test card numbers above work. Live keys (`sk_live_`) are refused. This path is covered by unit tests that mock Stripe's response; it has not been run against Stripe's servers, so try one payment with your own test key before you rely on it.

## How checkout keeps stock correct

1. **Reserve (one database transaction):** read the cart, check stock, compute the total from **database prices**, create a `pending` order, take the stock and move the cart items into the order. Two clicks, two tabs or two buyers cannot oversell, and the same cart cannot create two orders.
2. **Charge:** call the payment provider.
3. **Success:** mark the order `paid`. Stock stays reduced.
4. **Decline or provider error:** put the stock and cart items back and mark the order `failed`.

## Security notes

- Passwords: scrypt with per-user salt. Login uses the same error for a wrong password and an unknown email, and does equal work for both
- JWT: algorithm pinned to HS256, expiry enforced, user must still exist, `alg: none` and wrong-secret tokens rejected
- Rate limits on login and register (20 per 15 minutes per IP) and on the whole API
- All SQL uses bound parameters. Request bodies are limited to 10 KB. Helmet security headers and a strict Content Security Policy. No stack traces in responses
- Prices, totals and stock are always decided on the server. Orders are only visible to their owner
- Card number and CVC are used only to charge and are never stored or logged (only brand and last 4 digits are kept)
- All user text is shown with `textContent`, so names and product text cannot run as HTML

Trade-offs to know about: the token is kept in `localStorage` (the strict CSP and `textContent` rendering reduce the XSS risk, but an httpOnly cookie would be safer for a real shop), and in sandbox mode the card form posts to this server. A production shop would use Stripe Elements so card numbers never reach your server, and would run behind HTTPS.

## Tests

```bash
npm test
```

35 tests: authentication and token forgery, cart rules, checkout success and failure paths, double submit, last-item race, order privacy, rate limiting, payment provider behavior, and the full browser flow (register, add to cart, cart saved across logout, pay, receipt, orders) running against a real server.

## API

| Method | Route | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/config` | no | Payment mode and test cards |
| GET | `/api/products?q=` | no | List or search products |
| GET | `/api/products/:id` | no | One product |
| POST | `/api/auth/register` | no | Create account, returns token |
| POST | `/api/auth/login` | no | Log in, returns token |
| GET | `/api/auth/me` | yes | Current user |
| GET | `/api/cart` | yes | Saved cart with totals |
| POST | `/api/cart/items` | yes | Add `{ productId, quantity }` |
| PUT | `/api/cart/items/:productId` | yes | Set quantity (0 removes) |
| DELETE | `/api/cart/items/:productId` | yes | Remove an item |
| DELETE | `/api/cart` | yes | Empty the cart |
| POST | `/api/checkout` | yes | Pay `{ card: { number, exp, cvc } }` |
| GET | `/api/orders` | yes | Your orders |
| GET | `/api/orders/:id` | yes | One of your orders |

Send the token as `Authorization: Bearer <token>`.

## Files

```
server.js     routes and checkout logic
auth.js       password hashing, JWT
payments.js   sandbox and Stripe providers
db.js         schema and seed products
public/       index.html, style.css, app.js
test/         api, payments and ui tests
testutil.js   shared test helper
```
