const crypto = require('crypto');
const db = require('../config/db');

const RESET_TOKEN_EXPIRY_MINUTES = parseInt(process.env.RESET_TOKEN_EXPIRY_MINUTES || '30', 10);

function hashToken(token) {
  // SHA-256 is appropriate here (not bcrypt): the token itself is already
  // a high-entropy random value, so we only need a fast, deterministic
  // lookup hash — bcrypt's per-hash random salt would prevent lookup by hash.
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Issues a single-use password reset token for a user. Returns the plaintext
 * token (goes in the emailed link only — never stored, logged, or returned
 * from any API response body).
 */
function issueResetToken(userId) {
  db.prepare(
    `UPDATE password_reset_tokens SET used = 1 WHERE user_id = ? AND used = 0`
  ).run(userId);

  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(
    Date.now() + RESET_TOKEN_EXPIRY_MINUTES * 60 * 1000
  ).toISOString();

  db.prepare(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
     VALUES (?, ?, ?)`
  ).run(userId, tokenHash, expiresAt);

  return { token, expiresInMinutes: RESET_TOKEN_EXPIRY_MINUTES };
}

/**
 * Validates a reset token without consuming it. Returns the token record
 * (with user_id) or null.
 */
function peekResetToken(token) {
  const tokenHash = hashToken(token);
  const record = db
    .prepare(
      `SELECT * FROM password_reset_tokens WHERE token_hash = ? AND used = 0`
    )
    .get(tokenHash);
  if (!record) return null;
  if (new Date(record.expires_at + 'Z').getTime() < Date.now()) return null;
  return record;
}

function consumeResetToken(token) {
  const record = peekResetToken(token);
  if (!record) return null;
  db.prepare(`UPDATE password_reset_tokens SET used = 1 WHERE id = ?`).run(record.id);
  return record;
}

module.exports = { issueResetToken, peekResetToken, consumeResetToken };
