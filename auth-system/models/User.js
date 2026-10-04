const { db } = require('../config/db');

const PUBLIC_FIELDS = 'id, username, email, mobile, is_email_verified, is_mobile_verified, created_at';

const User = {
  async create({ username, email, mobile = '', passwordHash }) {
    const result = await db.execute({
      sql: `INSERT INTO users (username, email, mobile, password_hash)
       VALUES (?, ?, ?, ?) RETURNING ${PUBLIC_FIELDS}`,
      args: [username, email, mobile || '', passwordHash],
    });
    return result.rows[0];
  },

  async findById(id) {
    const result = await db.execute({ sql: `SELECT ${PUBLIC_FIELDS} FROM users WHERE id = ?`, args: [id] });
    return result.rows[0] || null;
  },

  // Includes password_hash — internal use only (login/reset), never send to client.
  async findByEmailWithSecret(email) {
    const result = await db.execute({ sql: 'SELECT * FROM users WHERE email = ?', args: [email.toLowerCase()] });
    return result.rows[0] || null;
  },

  async findByUsernameWithSecret(username) {
    const result = await db.execute({ sql: 'SELECT * FROM users WHERE username = ?', args: [username] });
    return result.rows[0] || null;
  },

  async findByEmailOrUsernameWithSecret(identifier) {
    const result = await db.execute({
      sql: 'SELECT * FROM users WHERE email = ? OR username = ?',
      args: [identifier.toLowerCase(), identifier],
    });
    return result.rows[0] || null;
  },

  async emailExists(email) {
    const result = await db.execute({ sql: 'SELECT 1 FROM users WHERE email = ?', args: [email.toLowerCase()] });
    return result.rows.length > 0;
  },

  async usernameExists(username) {
    const result = await db.execute({ sql: 'SELECT 1 FROM users WHERE username = ?', args: [username] });
    return result.rows.length > 0;
  },

  async markEmailVerified(userId) {
    await db.execute({ sql: "UPDATE users SET is_email_verified = 1, updated_at = datetime('now') WHERE id = ?", args: [userId] });
  },

  async markMobileVerified(userId) {
    await db.execute({ sql: "UPDATE users SET is_mobile_verified = 1, updated_at = datetime('now') WHERE id = ?", args: [userId] });
  },

  async updatePassword(userId, passwordHash) {
    await db.execute({
      sql: "UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?",
      args: [passwordHash, userId],
    });
  },
};

module.exports = User;
