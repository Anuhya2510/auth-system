const { body, param, validationResult } = require('express-validator');

function handleValidation(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: errors.array()[0].msg,
      errors: errors.array().map((e) => ({ field: e.path, message: e.msg })),
    });
  }
  next();
}

// Strong password: 8+ chars, upper, lower, digit, special char.
const strongPasswordRule = (field = 'password') =>
  body(field)
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters long')
    .matches(/[a-z]/)
    .withMessage('Password must include a lowercase letter')
    .matches(/[A-Z]/)
    .withMessage('Password must include an uppercase letter')
    .matches(/\d/)
    .withMessage('Password must include a number')
    .matches(/[^A-Za-z0-9]/)
    .withMessage('Password must include a special character');

const signupRules = [
  body('username')
    .trim()
    .isLength({ min: 3, max: 30 })
    .withMessage('Username must be 3-30 characters')
    .matches(/^[a-zA-Z0-9_]+$/)
    .withMessage('Username can only contain letters, numbers, and underscores'),
  body('email').trim().isEmail().withMessage('Enter a valid email address').normalizeEmail(),
  body('mobile')
    .trim()
    .matches(/^\+[1-9]\d{7,14}$/)
    .withMessage('Enter a valid mobile number in international format, e.g. +14155552671'),
  strongPasswordRule('password'),
  body('confirmPassword').custom((value, { req }) => {
    if (value !== req.body.password) {
      throw new Error('Passwords do not match');
    }
    return true;
  }),
];

const loginRules = [
  body('identifier').trim().notEmpty().withMessage('Email or username is required'),
  body('password').notEmpty().withMessage('Password is required'),
];

const otpRules = [
  body('email').trim().isEmail().withMessage('Enter a valid email address').normalizeEmail(),
  body('purpose').isIn(['signup', 'login']).withMessage('Invalid OTP purpose'),
];

const otpVerifyRules = [
  ...otpRules,
  body('code').trim().isLength({ min: 6, max: 6 }).isNumeric().withMessage('Enter the 6-digit code'),
];

const signupMobileOtpRules = [
  body('email').trim().isEmail().withMessage('Enter a valid email address').normalizeEmail(),
];

const signupMobileOtpVerifyRules = [
  ...signupMobileOtpRules,
  body('code').trim().isLength({ min: 6, max: 6 }).isNumeric().withMessage('Enter the 6-digit code'),
];

const forgotPasswordRules = [
  body('email').trim().isEmail().withMessage('Enter a valid email address').normalizeEmail(),
];

const resetPasswordRules = [
  body('token').trim().notEmpty().withMessage('Reset token is required'),
  strongPasswordRule('password'),
  body('confirmPassword').custom((value, { req }) => {
    if (value !== req.body.password) {
      throw new Error('Passwords do not match');
    }
    return true;
  }),
];

module.exports = {
  handleValidation,
  signupRules,
  loginRules,
  otpRules,
  otpVerifyRules,
  signupMobileOtpRules,
  signupMobileOtpVerifyRules,
  forgotPasswordRules,
  resetPasswordRules,
};
