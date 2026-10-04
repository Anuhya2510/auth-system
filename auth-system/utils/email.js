const nodemailer = require('nodemailer');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    const err = new Error('SMTP is not configured');
    err.code = 'SMTP_NOT_CONFIGURED';
    throw err;
  }

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  return transporter;
}

async function sendEmail({ to, subject, html, text }) {
  const t = getTransporter();
  try {
    await t.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to,
      subject,
      text,
      html,
    });
  } catch (err) {
    err.code = err.code || 'EMAIL_SEND_FAILED';
    throw err;
  }
}

async function sendOtpEmail(to, code, purpose, expiresInMinutes) {
  const isSignup = purpose === 'signup';
  const purposeLabel = isSignup ? 'Email verification OTP' : 'Rohith Solutions login code';

  const text = isSignup
    ? [
        'Hello,',
        '',
        'Thank you for registering with Rohith Solutions.',
        '',
        'Your email verification OTP is:',
        '',
        `[${code}]`,
        '',
        'Please enter this OTP on the Rohith Solutions website to verify your email address.',
        '',
        `This OTP is valid for a limited time. It expires in ${expiresInMinutes} minutes.`,
        '',
        'Please do not share this OTP with anyone.',
        '',
        'Regards,',
        'Rohith Solutions',
      ].join('\n')
    : `Hello! Your secure Rohith Solutions code is ${code}. This code will expire in ${expiresInMinutes} minutes. Please keep it private and do not share it with anyone.`;

  const html = isSignup
    ? `
      <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 24px auto; color: #1f2937; line-height: 1.6;">
        <p>Hello,</p>
        <p>Thank you for registering with Rohith Solutions.</p>
        <p>Your email verification OTP is:</p>
        <div style="margin: 18px 0; padding: 16px 20px; border: 1px solid #dbe3ef; border-radius: 10px; background: #f8fafc; text-align: center;">
          <span style="display: inline-block; font-size: 30px; font-weight: 700; letter-spacing: 6px; color: #111827;">[${code}]</span>
        </div>
        <p>Please enter this OTP on the Rohith Solutions website to verify your email address.</p>
        <p>This OTP is valid for a limited time. It expires in <strong>${expiresInMinutes} minutes</strong>.</p>
        <p style="color: #4b5563;">Please do not share this OTP with anyone.</p>
        <p style="margin-top: 24px;">Regards,<br>Rohith Solutions</p>
      </div>
    `
    : `
      <div style="font-family: sans-serif; max-width: 480px; margin: auto;">
        <h2>${purposeLabel}</h2>
        <p>Hello! Your secure Rohith Solutions code is:</p>
        <p style="font-size: 32px; font-weight: bold; letter-spacing: 6px;">${code}</p>
        <p>This code is valid for <strong>${expiresInMinutes} minutes</strong>.</p>
        <p style="color: #888; font-size: 13px;">If you did not request this, you can safely ignore this email. Please keep this code private and do not share it with anyone.</p>
      </div>
    `;

  await sendEmail({
    to,
    subject: isSignup ? 'Verify your email address' : `${purposeLabel} — ${code}`,
    text,
    html,
  });
}

async function sendPasswordResetEmail(to, resetUrl, expiresInMinutes) {
  await sendEmail({
    to,
    subject: 'Reset your password',
    text: `Reset your password using this link (expires in ${expiresInMinutes} minutes): ${resetUrl}`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: auto;">
        <h2>Reset your password</h2>
        <p>Click the button below to reset your password. This link is valid for <strong>${expiresInMinutes} minutes</strong> and can only be used once.</p>
        <p><a href="${resetUrl}" style="display:inline-block;padding:10px 20px;background:#4f46e5;color:#fff;text-decoration:none;border-radius:6px;">Reset Password</a></p>
        <p style="color: #888; font-size: 13px;">If you didn't request this, you can safely ignore this email.</p>
      </div>
    `,
  });
}

module.exports = { sendEmail, sendOtpEmail, sendPasswordResetEmail };
