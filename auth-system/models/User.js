const db = require('../config/db');

const PUBLIC_FIELDS = 'id, username, email, mobile, is_email_verified, is_mobile_verified, created_at';

const User = {
  create({ username, email, mobile, passwordHash }) {
    const stmt = db.prepare(`
      INSERT INTO users (username, email, mobile, password_hash)
      VALUES (@username, @email, @mobile, @passwordHash)
    `);
    const info = stmt.run({ username, email, mobile, passwordHash });
    return User.findById(info.lastInsertRowid);
  },

  findById(id) {
    return db.prepare(`SELECT ${PUBLIC_FIELDS} FROM users WHERE id = ?`).get(id);
  },

  // Includes password_hash — internal use only (login/reset), never send to client.
  findByEmailWithSecret(email) {
    return db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
  },

  findByUsernameWithSecret(username) {
    return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  },

  findByEmailOrUsernameWithSecret(identifier) {
    return db
      .prepare('SELECT * FROM users WHERE email = ? OR username = ?')
      .get(identifier.toLowerCase(), identifier);
  },

  emailExists(email) {
    return !!db.prepare('SELECT 1 FROM users WHERE email = ?').get(email.toLowerCase());
  },

  usernameExists(username) {
    return !!db.prepare('SELECT 1 FROM users WHERE username = ?').get(username);
  },

  markEmailVerified(userId) {
    db.prepare(
      `UPDATE users SET is_email_verified = 1, updated_at = datetime('now') WHERE id = ?`
    ).run(userId);
  },

  markMobileVerified(userId) {
    db.prepare(
      `UPDATE users SET is_mobile_verified = 1, updated_at = datetime('now') WHERE id = ?`
    ).run(userId);
  },

  updatePassword(userId, passwordHash) {
    db.prepare(
      `UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(passwordHash, userId);
  },
};

module.exports = User;
