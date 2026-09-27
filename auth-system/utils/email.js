const nodemailer = require('nodemailer');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

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
  await t.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject,
    text,
    html,
  });
}

async function sendOtpEmail(to, code, purpose, expiresInMinutes) {
  const purposeLabel = purpose === 'signup' ? 'Verify your email' : 'Your login code';
  await sendEmail({
    to,
    subject: `${purposeLabel} — ${code}`,
    text: `Your verification code is ${code}. It expires in ${expiresInMinutes} minutes. Do not share this code with anyone.`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: auto;">
        <h2>${purposeLabel}</h2>
        <p>Your one-time verification code is:</p>
        <p style="font-size: 32px; font-weight: bold; letter-spacing: 6px;">${code}</p>
        <p>This code expires in <strong>${expiresInMinutes} minutes</strong>.</p>
        <p style="color: #888; font-size: 13px;">If you didn't request this, you can safely ignore this email. Never share this code with anyone.</p>
      </div>
    `,
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
