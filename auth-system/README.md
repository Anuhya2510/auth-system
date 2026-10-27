# Professional Authentication System

Email/OTP + password auth with signup, login, and forgot/reset password flows.
Node.js + Express backend, SQLite database, and plain HTML/CSS/JS frontend.

## Features

- **Signup**: username, email OTP verification, SMS mobile verification via
  Twilio Verify, strong password + confirm, live password-strength meter,
  show/hide password, resend codes.
- **Login**: email-or-username + password, forgot password link. OTP
  verification is required when creating an account.
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
- `DB_PATH` — optional local SQLite file path. Render sets this to the mounted
  persistent disk path.
- `FILE_STORAGE_PATH` — private file-byte storage directory. Defaults to
  `data/gallery` locally; Render uses `/var/data/gallery` on its persistent disk.
- `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` — optional locally; required for
  Vercel deployments. Without them, local development uses `data/auth.db`.
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

## Deploy on Vercel

1. Set the Vercel project Root Directory to `auth-system` if deploying this
  repository as-is.
2. Create a Turso database and add `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`
  to the Vercel project environment variables.
3. Create and connect a **private Vercel Blob store** from the project's Storage
  tab. Vercel supplies the Blob store ID and authentication to the deployment.
4. Add `JWT_SECRET`, `APP_BASE_URL`, `SMTP_*`, and `TWILIO_*`. Set
  `APP_BASE_URL` to the deployed Vercel origin and `NODE_ENV=production`.
5. Deploy. The Vercel function serves the frontend and API; check `/health`
  and open `/signup.html` after deployment.

Vercel's filesystem is ephemeral, so the app requires Turso there. Existing
local SQLite data is not migrated automatically.

Gallery uploads use private Vercel Blob storage on Vercel, served through the
authenticated API. Local and Render deployments continue to use disk storage.

## Deploy on Render

1. In Render, create a Blueprint using this repository and the root
  `render.yaml`. The blueprint points the service at the `auth-system`
  application directory and provisions a persistent disk at `/var/data`.
2. During setup, provide the requested SMTP and Twilio environment variables.
  Render generates `JWT_SECRET`; the service uses Render's assigned URL for
  reset links and same-origin requests.
3. Deploy and check `/health`. Open `/signup.html` on the Render service URL.

The Render blueprint uses a paid Starter web service because persistent disks
are not available on free web services. It stores SQLite at
`/var/data/auth.db` and Gallery files at `/var/data/gallery`. Keep the disk
attached to preserve accounts and files across deploys.

## Gallery and file recovery

After logging in, open `/gallery.html` to upload files, create/rename folders,
search and sort items, switch between grid and list layouts, preview supported
images, videos, PDFs, and plain text/CSV files, and download files. Large
folders are paginated. Drag-and-drop uploads are supported on the Gallery page.
Folder uploads use the browser's directory-picker support where available.
Uploads are limited to 10 files and 50 MB total per request, with a 25 MB
per-file limit. File bytes are stored outside `public/` under opaque identifiers;
every listing, preview, download, restore, and deletion request requires the
authenticated session and checks file ownership.

Normal deletion moves the file or folder to `/recently-deleted.html` without
removing its file bytes. Items can be restored for 30 days. Restore conflicts
are resolved by assigning a non-conflicting name, never by overwriting an
existing file. Recently Deleted supports search, type filters, original-location
details, individual/bulk restore, and restore-all. A background cleanup task runs
hourly on the local/Render server
and permanently removes expired bytes and metadata. Permanent deletion and
emptying Recently Deleted require confirmation in the UI.

The schema for `gallery_folders` and `gallery_files` is created idempotently
when the app initializes its database; no manual SQL migration is required.
For local testing, set `FILE_STORAGE_PATH=./data/gallery` in `.env`, run
`npm install`, then `npm start` and sign in at `http://localhost:3000/login.html`.
Run `npm test` for the automated auth and Gallery integration tests.

Never commit `.env` or put production secrets in `.env.example`.

## How the flows work

**Signup**: `POST /api/auth/signup/start` validates input, checks for
existing username/email, hashes the password, stores the signup as
*pending* (not yet a real user), and emails a 6-digit OTP. After
`POST /api/auth/signup/verify-otp` verifies the email, Twilio Verify sends
an SMS code. `POST /api/auth/signup/verify-mobile-otp` creates the user only
after the phone number is approved. Abandoned signups expire after 30 minutes.

**Login**: `POST /api/auth/login/start` checks credentials (returning a
generic "Invalid credentials" either way) and, on success, sets an httpOnly
JWT cookie (`auth_token`). OTP verification is used for account creation only.

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
├── config/db.js               # SQLite/libSQL connection + schema
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
