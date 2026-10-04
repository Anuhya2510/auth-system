const test = require('node:test');
const assert = require('node:assert/strict');
const { validationResult } = require('express-validator');
const { signupRules } = require('../middleware/validate');

async function validateSignup(payload) {
  const req = { body: payload };
  await Promise.all(signupRules.map((rule) => rule.run(req)));
  return validationResult(req);
}

test('signup validation does not require a mobile number', async () => {
  const result = await validateSignup({
    username: 'demouser',
    email: 'demo@example.com',
    password: 'StrongPass1!',
    confirmPassword: 'StrongPass1!',
  });

  assert.equal(result.isEmpty(), true, result.array().map((error) => error.msg).join(', '));
});
