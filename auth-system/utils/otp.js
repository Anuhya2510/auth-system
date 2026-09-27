const crypto = require('crypto');
const bcrypt = require('bcrypt');
const db = require('../config/db');

const OTP_EXPIRY_MINUTES = parseInt(process.env.OTP_EXPIRY_MINUTES || '5', 10);
const OTP_RESEND_COOLDOWN_SECONDS = parseInt(process.env.OTP_RESEND_COOLDOWN_SECONDS || '60', 10);
const OTP_MAX_ATTEMPTS = parseInt(process.env.OTP_MAX_ATTEMPTS || '5', 10);
const SALT_ROUNDS = 10;

function generateOtpCode() {
  // Cryptographically secure 6-digit code, zero-padded.
  const n = crypto.randomInt(0, 1000000);
  return n.toString().padStart(6, '0');
}

/**
 * Creates and stores a new OTP for (email, purpose), invalidating previous
 * unused OTPs for that pair. Returns the plaintext code (caller emails it,
 * never stores or logs it).
 */
async function issueOtp(email, purpose) {
  const normalizedEmail = email.toLowerCase();
  const existing = db
    .prepare(
      `SELECT * FROM otps WHERE email = ? AND purpose = ? AND used = 0
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(normalizedEmail, purpose);

  if (existing) {
    const lastSent = new Date(existing.last_sent_at + 'Z').getTime();
    const secondsSinceLastSend = (Date.now() - lastSent) / 1000;
    if (secondsSinceLastSend < OTP_RESEND_COOLDOWN_SECONDS) {
      const retryAfter = Math.ceil(OTP_RESEND_COOLDOWN_SECONDS - secondsSinceLastSend);
      const err = new Error('OTP resend cooldown active');
      err.code = 'OTP_COOLDOWN';
      err.retryAfter = retryAfter;
      throw err;
    }
  }

  // Invalidate any previous unused OTPs for this email+purpose.
  db.prepare(`UPDATE otps SET used = 1 WHERE email = ? AND purpose = ? AND used = 0`).run(
    normalizedEmail,
    purpose
  );

  const code = generateOtpCode();
  const codeHash = await bcrypt.hash(code, SALT_ROUNDS);
  const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000).toISOString();

  const inserted = db.prepare(
    `INSERT INTO otps (email, purpose, code_hash, expires_at, last_sent_at)
     VALUES (?, ?, ?, ?, datetime('now'))`
  ).run(normalizedEmail, purpose, codeHash, expiresAt);

  return { code, otpId: inserted.lastInsertRowid, expiresInMinutes: OTP_EXPIRY_MINUTES };
}

function invalidateOtp(otpId) {
  db.prepare('UPDATE otps SET used = 1 WHERE id = ? AND used = 0').run(otpId);
}

/**
 * Verifies a submitted OTP code. Returns { success, reason }.
 * reason is one of: 'ok', 'not_found', 'expired', 'max_attempts', 'invalid'
 */
async function verifyOtp(email, purpose, submittedCode) {
  const normalizedEmail = email.toLowerCase();
  const record = db
    .prepare(
      `SELECT * FROM otps WHERE email = ? AND purpose = ? AND used = 0
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(normalizedEmail, purpose);

  if (!record) return { success: false, reason: 'not_found' };

  if (record.attempts >= OTP_MAX_ATTEMPTS) {
    return { success: false, reason: 'max_attempts' };
  }

  const isExpired = new Date(record.expires_at + 'Z').getTime() < Date.now();
  if (isExpired) return { success: false, reason: 'expired' };

  const matches = await bcrypt.compare(submittedCode, record.code_hash);

  db.prepare(`UPDATE otps SET attempts = attempts + 1 WHERE id = ?`).run(record.id);

  if (!matches) return { success: false, reason: 'invalid' };

  db.prepare(`UPDATE otps SET used = 1 WHERE id = ?`).run(record.id);
  return { success: true, reason: 'ok' };
}

module.exports = { issueOtp, verifyOtp, invalidateOtp, OTP_EXPIRY_MINUTES, OTP_RESEND_COOLDOWN_SECONDS };
