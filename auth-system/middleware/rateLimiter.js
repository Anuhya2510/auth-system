const rateLimit = require('express-rate-limit');

// Generic response shape so the frontend can show a friendly message.
function limiterHandler(req, res) {
  res.status(429).json({
    success: false,
    message: 'Too many requests. Please try again later.',
  });
}

// Signup: modest limit, prevents mass account creation from one IP.
const signupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: limiterHandler,
});

// Login attempts: stricter, guards against credential stuffing / brute force.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  handler: limiterHandler,
});

// OTP send/resend: tight limit independent of the OTP service's own cooldown.
const otpRequestLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  handler: limiterHandler,
});

// OTP verification: separate from send, guards against code-guessing.
const otpVerifyLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: limiterHandler,
});

// Forgot password: prevents email-bombing an arbitrary address.
const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: limiterHandler,
});

module.exports = {
  signupLimiter,
  loginLimiter,
  otpRequestLimiter,
  otpVerifyLimiter,
  forgotPasswordLimiter,
};
