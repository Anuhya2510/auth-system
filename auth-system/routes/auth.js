const express = require('express');
const bcrypt = require('bcrypt');
const User = require('../models/User');
const PendingSignup = require('../models/PendingSignup');
const { issueOtp, verifyOtp, invalidateOtp } = require('../utils/otp');
const { issueResetToken, peekResetToken, consumeResetToken } = require('../utils/resetToken');
const { sendOtpEmail, sendPasswordResetEmail } = require('../utils/email');
const { signToken } = require('../utils/jwt');
const {
  handleValidation,
  signupRules,
  loginRules,
  otpRules,
  otpVerifyRules,
  forgotPasswordRules,
  resetPasswordRules,
} = require('../middleware/validate');
const {
  signupLimiter,
  loginLimiter,
  otpRequestLimiter,
  otpVerifyLimiter,
  forgotPasswordLimiter,
} = require('../middleware/rateLimiter');

const router = express.Router();
const SALT_ROUNDS = 12;

// Generic messages — never reveal whether an email/username exists.
const GENERIC_OTP_SENT = 'If the details are valid, a verification code has been sent.';
const GENERIC_RESET_SENT =
  'If an account with that email exists, a password reset link has been sent.';

async function otpCooldownGuard(res, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err.code === 'OTP_COOLDOWN') {
      res.status(429).json({
        success: false,
        message: `Please wait ${err.retryAfter}s before requesting another code.`,
        retryAfter: err.retryAfter,
      });
      return null;
    }
    throw err;
  }
}

async function sendOtpOrRespond(res, email, purpose, result) {
  try {
    await sendOtpEmail(email, result.code, purpose, result.expiresInMinutes);
    return true;
  } catch (err) {
    await invalidateOtp(result.otpId);
    console.error('OTP email delivery failed:', err.message);
    res.status(503).json({
      success: false,
      message: 'Could not send the verification email. Check SMTP settings and try again.',
    });
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* SIGNUP                                                              */
/* ------------------------------------------------------------------ */

// Step 1: validate + stash pending signup + send OTP to email.
router.post('/signup/start', signupLimiter, signupRules, handleValidation, async (req, res, next) => {
  try {
    const { username, email, mobile = '', password } = req.body;
    const normalizedEmail = email.toLowerCase();

    if (await User.emailExists(normalizedEmail)) {
      return res.status(409).json({ success: false, message: 'Email is already registered' });
    }
    if (await User.usernameExists(username)) {
      return res.status(409).json({ success: false, message: 'Username is already taken' });
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    await PendingSignup.upsert({ username, email: normalizedEmail, mobile: mobile || '', passwordHash });

    const result = await otpCooldownGuard(res, () => issueOtp(normalizedEmail, 'signup'));
    if (!result) return; // response already sent by guard

    if (!(await sendOtpOrRespond(res, normalizedEmail, 'signup', result))) return;

    res.json({
      success: true,
      message: 'Verification code sent to your email.',
      expiresInMinutes: result.expiresInMinutes,
    });
  } catch (err) {
    next(err);
  }
});

// Step 2: verify email OTP and create the account immediately.
router.post(
  '/signup/verify-otp',
  otpVerifyLimiter,
  otpVerifyRules,
  handleValidation,
  async (req, res, next) => {
    try {
      const { email, code } = req.body;
      const normalizedEmail = email.toLowerCase();

      const pending = await PendingSignup.findByEmail(normalizedEmail);
      if (!pending) {
        return res.status(400).json({
          success: false,
          message: 'No pending signup found for this email. Please sign up again.',
        });
      }

      const result = await verifyOtp(normalizedEmail, 'signup', code);
      if (!result.success) {
        const messages = {
          not_found: 'No verification code found. Please request a new one.',
          expired: 'This code has expired. Please request a new one.',
          max_attempts: 'Too many incorrect attempts. Please request a new code.',
          invalid: 'Incorrect verification code.',
        };
        return res.status(400).json({ success: false, message: messages[result.reason] });
      }

      if (
        (await User.emailExists(normalizedEmail)) ||
        (await User.usernameExists(pending.username))
      ) {
        await PendingSignup.deleteByEmail(normalizedEmail);
        return res.status(409).json({
          success: false,
          message: 'This email or username was registered while signup was pending. Please start again.',
        });
      }

      const user = await User.create({
        username: pending.username,
        email: normalizedEmail,
        mobile: pending.mobile || '',
        passwordHash: pending.password_hash,
      });
      await User.markEmailVerified(user.id);
      await PendingSignup.deleteByEmail(normalizedEmail);

      return res.json({ success: true, message: 'Email verified. Account created successfully.' });
    } catch (err) {
      next(err);
    }
  }
);

// Resend OTP for signup (subject to cooldown inside issueOtp).
router.post('/signup/resend-otp', otpRequestLimiter, otpRules, handleValidation, async (req, res, next) => {
  try {
    const { email } = req.body;
    const normalizedEmail = email.toLowerCase();

    const pending = await PendingSignup.findByEmail(normalizedEmail);
    if (!pending) {
      return res.status(400).json({
        success: false,
        message: 'No pending signup found for this email. Please sign up again.',
      });
    }

    const result = await otpCooldownGuard(res, () => issueOtp(normalizedEmail, 'signup'));
    if (!result) return;

    if (!(await sendOtpOrRespond(res, normalizedEmail, 'signup', result))) return;
    res.json({ success: true, message: 'Verification code resent.', expiresInMinutes: result.expiresInMinutes });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/* LOGIN                                                               */
/* ------------------------------------------------------------------ */

// Step 1: verify credentials, then send login OTP.
router.post('/login/start', loginLimiter, loginRules, handleValidation, async (req, res, next) => {
  try {
    const { identifier, password } = req.body;
    const user = await User.findByEmailOrUsernameWithSecret(identifier);

    // Same generic response whether the user exists or the password is wrong.
    const invalidCredsResponse = () =>
      res.status(401).json({ success: false, message: 'Invalid credentials' });

    if (!user) return invalidCredsResponse();

    const passwordOk = await bcrypt.compare(password, user.password_hash);
    if (!passwordOk) return invalidCredsResponse();

    if (!user.is_email_verified) {
      return res.status(403).json({
        success: false,
        message: 'Please verify your email before logging in.',
      });
    }

    const result = await otpCooldownGuard(res, () => issueOtp(user.email, 'login'));
    if (!result) return;

    if (!(await sendOtpOrRespond(res, user.email, 'login', result))) return;

    res.json({
      success: true,
      message: 'Login code sent to your email.',
      email: user.email,
      expiresInMinutes: result.expiresInMinutes,
    });
  } catch (err) {
    next(err);
  }
});

// Step 2: verify login OTP, issue JWT session.
router.post(
  '/login/verify-otp',
  otpVerifyLimiter,
  otpVerifyRules,
  handleValidation,
  async (req, res, next) => {
    try {
      const { email, code } = req.body;
      const normalizedEmail = email.toLowerCase();

      const result = await verifyOtp(normalizedEmail, 'login', code);
      if (!result.success) {
        const messages = {
          not_found: 'No login code found. Please log in again.',
          expired: 'This code has expired. Please request a new one.',
          max_attempts: 'Too many incorrect attempts. Please log in again.',
          invalid: 'Incorrect verification code.',
        };
        return res.status(400).json({ success: false, message: messages[result.reason] });
      }

      const user = await User.findByEmailWithSecret(normalizedEmail);
      if (!user) {
        return res.status(400).json({ success: false, message: 'Account not found.' });
      }

      const token = signToken({ userId: user.id, email: user.email });

      res
        .cookie('auth_token', token, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax',
          maxAge: 7 * 24 * 60 * 60 * 1000,
        })
        .json({
          success: true,
          message: 'Login successful.',
          user: { id: user.id, username: user.username, email: user.email },
        });
    } catch (err) {
      next(err);
    }
  }
);

// Resend OTP for login.
router.post('/login/resend-otp', otpRequestLimiter, otpRules, handleValidation, async (req, res, next) => {
  try {
    const { email } = req.body;
    const normalizedEmail = email.toLowerCase();
    const user = await User.findByEmailWithSecret(normalizedEmail);
    if (!user) {
      // Generic response — don't reveal account existence.
      return res.json({ success: true, message: GENERIC_OTP_SENT });
    }

    const result = await otpCooldownGuard(res, () => issueOtp(normalizedEmail, 'login'));
    if (!result) return;

    if (!(await sendOtpOrRespond(res, normalizedEmail, 'login', result))) return;
    res.json({ success: true, message: 'Login code resent.', expiresInMinutes: result.expiresInMinutes });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  res.clearCookie('auth_token').json({ success: true, message: 'Logged out.' });
});

/* ------------------------------------------------------------------ */
/* FORGOT / RESET PASSWORD                                             */
/* ------------------------------------------------------------------ */

router.post(
  '/forgot-password',
  forgotPasswordLimiter,
  forgotPasswordRules,
  handleValidation,
  async (req, res, next) => {
    try {
      const { email } = req.body;
      const normalizedEmail = email.toLowerCase();
      const user = await User.findByEmailWithSecret(normalizedEmail);

      // Always respond the same way to avoid leaking which emails are registered.
      if (user) {
        try {
          const { token, expiresInMinutes } = await issueResetToken(user.id);
          const appBaseUrl = process.env.APP_BASE_URL || process.env.RENDER_EXTERNAL_URL;
          const resetUrl = `${appBaseUrl}/reset-password.html?token=${token}`;
          await sendPasswordResetEmail(normalizedEmail, resetUrl, expiresInMinutes);
        } catch (err) {
          return next(err);
        }
      }

      res.json({ success: true, message: GENERIC_RESET_SENT });
    } catch (err) {
      next(err);
    }
  }
);

// Lets the reset-password page confirm a token is valid before showing the form.
router.get('/reset-password/validate', async (req, res, next) => {
  try {
    const { token } = req.query;
    if (!token || !(await peekResetToken(token))) {
      return res.status(400).json({ success: false, message: 'Invalid or expired reset link.' });
    }
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

router.post(
  '/reset-password',
  resetPasswordRules,
  handleValidation,
  async (req, res, next) => {
    try {
      const { token, password } = req.body;
      const record = await consumeResetToken(token);
      if (!record) {
        return res.status(400).json({ success: false, message: 'Invalid or expired reset link.' });
      }

      const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
      await User.updatePassword(record.user_id, passwordHash);

      res.json({ success: true, message: 'Password reset successfully. You can now log in.' });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
