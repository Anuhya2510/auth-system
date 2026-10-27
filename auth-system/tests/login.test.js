const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'login-test-secret-that-is-only-used-in-tests';
process.env.TURSO_DATABASE_URL = 'file::memory:';
process.env.TURSO_AUTH_TOKEN = '';
process.env.TURSO_DB_URL = '';
process.env.TURSO_DB_AUTH_TOKEN = '';

const app = require('../server');
const { initDb } = require('../config/db');
const User = require('../models/User');

let server;
let origin;

test('login accepts email or username without an OTP and rejects invalid credentials generically', async (t) => {
  await initDb();
  const passwordHash = await bcrypt.hash('GoodPassword9!', 4);
  const user = await User.create({
    username: 'login_test_user',
    email: 'login-test@example.com',
    passwordHash,
  });
  await User.markEmailVerified(user.id);

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  for (const identifier of ['login-test@example.com', 'login_test_user']) {
    const response = await fetch(`${origin}/api/auth/login/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier, password: 'GoodPassword9!' }),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.match(response.headers.get('set-cookie') || '', /auth_token=.*HttpOnly/i);
  }

  const invalid = await fetch(`${origin}/api/auth/login/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: 'login_test_user', password: 'incorrect' }),
  });
  const invalidBody = await invalid.json();
  assert.equal(invalid.status, 401);
  assert.deepEqual(invalidBody, { success: false, message: 'Invalid credentials' });
});
