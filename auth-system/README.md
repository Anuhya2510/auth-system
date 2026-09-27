# Professional Authentication System

Email/OTP + password auth with signup, login, and forgot/reset password flows.
Node.js + Express backend, SQLite (file-based, no separate DB server needed),
plain HTML/CSS/JS frontend.

## Features

- **Signup**: username, email OTP verification, SMS mobile verification via
  Twilio Verify, strong password + confirm, live password-strength meter,
  show/hide password, resend codes.
- **Login**: email-or-username + password, then a login OTP step, forgot
  password link, resend OTP with cooldown.
- **Forgot password**: email → reset link → secure, expiring, single-use
  reset token → set new password + confirm.
- **Security**: bcrypt password hashing (cost 12) and bcrypt-hashed OTPs,
  OTP expiry (5 min default) and max-attempt lockout, SHA-256-hashed
  single-use reset tokens (30 min expiry), per-route rate limiting,
  server-side validation, JWT session in an httpOnly cookie, generic
  "if this account exists" responses so the API never reveals which
  emails/usernames are registered, secrets loaded only from `.env`.

## Setup

```bash
cd auth-system
npm install
cp .env.example .env
```

Edit `.env`:

- `JWT_SECRET` — set to a long random string (e.g. `openssl rand -hex 32`).
- `SMTP_*` — your email provider's SMTP credentials. For Gmail, use an
  [App Password](https://myaccount.google.com/apppasswords), not your
  regular password (requires 2-Step Verification enabled).
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and
  `TWILIO_VERIFY_SERVICE_SID` — credentials and Verify service from your
  Twilio console. Create a Verify service and enable SMS for the countries
  where your users' numbers are located.
- `APP_BASE_URL` — used to build the password-reset link (e.g.
  `http://localhost:3000` locally, your real domain in production).

Run it:

```bash
npm start          # production
npm run dev         # auto-restart on changes (requires devDependencies installed)
```

Visit `http://localhost:3000/signup.html`.

## Deploy on Railway

1. Push this project to a GitHub repository and create a Railway project from it.
2. Add a volume to the app service and set its mount path to `/app/data`.
  Set `DB_PATH` to `/app/data/auth.db` in the service variables so SQLite
  data survives redeploys.
3. Add the production variables from `.env` in Railway's service settings:
  `JWT_SECRET`, `APP_BASE_URL`, the `SMTP_*` variables, and the three
  `TWILIO_*` variables. Set `NODE_ENV=production`; Railway provides `PORT`.
4. Set the service healthcheck path to `/health`, then deploy and generate a
  public domain in Railway's networking settings.
5. Set `APP_BASE_URL` to the generated `https://` domain and redeploy. Share
  the generated domain with `/signup.html` appended.

Never commit `.env` or put production secrets in `.env.example`.

## How the flows work

**Signup**: `POST /api/auth/signup/start` validates input, checks for
existing username/email, hashes the password, stores the signup as
*pending* (not yet a real user), and emails a 6-digit OTP. After
`POST /api/auth/signup/verify-otp` verifies the email, Twilio Verify sends
an SMS code. `POST /api/auth/signup/verify-mobile-otp` creates the user only
after the phone number is approved. Abandoned signups expire after 30 minutes.

**Login**: `POST /api/auth/login/start` checks credentials first (returning
a generic "Invalid credentials" either way, so the API doesn't reveal
whether the account exists), then emails a login OTP. `POST
/api/auth/login/verify-otp` checks the code and, on success, sets an
httpOnly JWT cookie (`auth_token`).

**Forgot/reset password**: `POST /api/auth/forgot-password` always returns
the same generic message regardless of whether the email is registered.
If it is, a single-use, SHA-256-hashed, 30-minute-expiry token is created
and emailed as a link to `reset-password.html?token=...`. That page calls
`GET /api/auth/reset-password/validate` to check the token before showing
the form, then `POST /api/auth/reset-password` to set the new password —
which invalidates the token immediately (single use).

## Project structure

```
auth-system/
├── server.js                  # Express app entry point
├── config/db.js               # SQLite connection + schema
├── models/                    # User, PendingSignup
├── middleware/                # rate limiting, validation, requireAuth
├── routes/auth.js             # all auth endpoints
├── utils/                     # otp.js, resetToken.js, email.js, sms.js, jwt.js
└── public/                    # signup/login/forgot/reset HTML + JS + CSS
```

## Notes / production hardening ideas

- Swap SQLite for Postgres/MySQL if you need concurrent write throughput
  beyond a single file-based DB.
- Add a scheduled cleanup job for expired `pending_signups`,
  `password_reset_tokens`, and `otps` rows (they're already excluded from
  queries once expired, but periodic deletion keeps the tables small).
- Consider CAPTCHA on signup/login if you see automated abuse beyond what
  rate limiting stops.
- Put the app behind HTTPS in production — `secure: true` is already set
  on the session cookie when `NODE_ENV=production`.
