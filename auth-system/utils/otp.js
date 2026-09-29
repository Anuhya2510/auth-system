const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { db } = require('../config/db');

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
  const existingResult = await db.execute({
    sql: `SELECT * FROM otps WHERE email = ? AND purpose = ? AND used = 0
       ORDER BY created_at DESC LIMIT 1`,
    args: [normalizedEmail, purpose],
  });
  const existing = existingResult.rows[0];

  if (existing) {
    const lastSent = new Date(existing.last_sent_at).getTime();
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
  await db.execute({
    sql: 'UPDATE otps SET used = 1 WHERE email = ? AND purpose = ? AND used = 0',
    args: [normalizedEmail, purpose],
  });

  const code = generateOtpCode();
  const codeHash = await bcrypt.hash(code, SALT_ROUNDS);
  const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000).toISOString();

  const inserted = await db.execute({
    sql: `INSERT INTO otps (email, purpose, code_hash, expires_at, last_sent_at)
     VALUES (?, ?, ?, ?, ?) RETURNING id`,
    args: [normalizedEmail, purpose, codeHash, expiresAt, new Date().toISOString()],
  });

  return { code, otpId: inserted.rows[0].id, expiresInMinutes: OTP_EXPIRY_MINUTES };
}

async function invalidateOtp(otpId) {
  await db.execute({ sql: 'UPDATE otps SET used = 1 WHERE id = ? AND used = 0', args: [otpId] });
}

/**
 * Verifies a submitted OTP code. Returns { success, reason }.
 * reason is one of: 'ok', 'not_found', 'expired', 'max_attempts', 'invalid'
 */
async function verifyOtp(email, purpose, submittedCode) {
  const normalizedEmail = email.toLowerCase();
  const result = await db.execute({
    sql: `SELECT * FROM otps WHERE email = ? AND purpose = ? AND used = 0
       ORDER BY created_at DESC LIMIT 1`,
    args: [normalizedEmail, purpose],
  });
  const record = result.rows[0];

  if (!record) return { success: false, reason: 'not_found' };

  if (record.attempts >= OTP_MAX_ATTEMPTS) {
    return { success: false, reason: 'max_attempts' };
  }

  const isExpired = new Date(record.expires_at).getTime() < Date.now();
  if (isExpired) return { success: false, reason: 'expired' };

  const matches = await bcrypt.compare(submittedCode, record.code_hash);

  await db.execute({ sql: 'UPDATE otps SET attempts = attempts + 1 WHERE id = ?', args: [record.id] });

  if (!matches) return { success: false, reason: 'invalid' };

  await db.execute({ sql: 'UPDATE otps SET used = 1 WHERE id = ?', args: [record.id] });
  return { success: true, reason: 'ok' };
}

module.exports = { issueOtp, verifyOtp, invalidateOtp, OTP_EXPIRY_MINUTES, OTP_RESEND_COOLDOWN_SECONDS };
