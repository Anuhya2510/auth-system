const db = require('../config/db');

const PENDING_SIGNUP_TTL_MINUTES = 30;

const PendingSignup = {
  upsert({ username, email, mobile, passwordHash }) {
    const expiresAt = new Date(
      Date.now() + PENDING_SIGNUP_TTL_MINUTES * 60 * 1000
    ).toISOString();

    db.prepare(
      `INSERT INTO pending_signups (username, email, mobile, password_hash, email_verified, expires_at)
       VALUES (@username, @email, @mobile, @passwordHash, 0, @expiresAt)
       ON CONFLICT(email) DO UPDATE SET
         username = excluded.username,
         mobile = excluded.mobile,
         password_hash = excluded.password_hash,
         email_verified = 0,
         expires_at = excluded.expires_at`
    ).run({ username, email: email.toLowerCase(), mobile, passwordHash, expiresAt });
  },

  findByEmail(email) {
    const record = db
      .prepare('SELECT * FROM pending_signups WHERE email = ?')
      .get(email.toLowerCase());
    if (!record) return null;
    if (new Date(record.expires_at + 'Z').getTime() < Date.now()) {
      PendingSignup.deleteByEmail(email);
      return null;
    }
    return record;
  },

  markEmailVerified(email) {
    db.prepare('UPDATE pending_signups SET email_verified = 1 WHERE email = ?').run(email.toLowerCase());
  },

  deleteByEmail(email) {
    db.prepare('DELETE FROM pending_signups WHERE email = ?').run(email.toLowerCase());
  },
};

module.exports = PendingSignup;
