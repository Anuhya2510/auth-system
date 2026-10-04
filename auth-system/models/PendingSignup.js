const { db } = require('../config/db');

const PENDING_SIGNUP_TTL_MINUTES = 30;

const PendingSignup = {
  async upsert({ username, email, mobile = '', passwordHash }) {
    const expiresAt = new Date(
      Date.now() + PENDING_SIGNUP_TTL_MINUTES * 60 * 1000
    ).toISOString();

    await db.execute({
      sql: `INSERT INTO pending_signups (username, email, mobile, password_hash, email_verified, expires_at)
       VALUES (?, ?, ?, ?, 0, ?)
       ON CONFLICT(email) DO UPDATE SET
         username = excluded.username,
         mobile = excluded.mobile,
         password_hash = excluded.password_hash,
         email_verified = 0,
         expires_at = excluded.expires_at`,
      args: [username, email.toLowerCase(), mobile || '', passwordHash, expiresAt],
    });
  },

  async findByEmail(email) {
    const result = await db.execute({ sql: 'SELECT * FROM pending_signups WHERE email = ?', args: [email.toLowerCase()] });
    const record = result.rows[0];
    if (!record) return null;
    if (new Date(record.expires_at).getTime() < Date.now()) {
      await PendingSignup.deleteByEmail(email);
      return null;
    }
    return record;
  },

  async markEmailVerified(email) {
    await db.execute({ sql: 'UPDATE pending_signups SET email_verified = 1 WHERE email = ?', args: [email.toLowerCase()] });
  },

  async deleteByEmail(email) {
    await db.execute({ sql: 'DELETE FROM pending_signups WHERE email = ?', args: [email.toLowerCase()] });
  },
};

module.exports = PendingSignup;
