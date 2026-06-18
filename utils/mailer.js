const nodemailer = require('nodemailer');
const { getBooleanEnv, getIntegerEnv, getOptionalEnv } = require('./env');

let cachedTransporter = null;
let cachedConfigKey = '';

function getMailerConfig() {
  const host = getOptionalEnv('SMTP_HOST');
  const user = getOptionalEnv('SMTP_USER');
  const pass = getOptionalEnv('SMTP_PASS');
  const from = getOptionalEnv('SMTP_FROM');

  const configured = Boolean(host && user && pass && from);

  return {
    configured,
    host,
    port: getIntegerEnv('SMTP_PORT', 587),
    secure: getBooleanEnv('SMTP_SECURE', false),
    user,
    pass,
    from,
  };
}

function getTransporter() {
  const config = getMailerConfig();
  if (!config.configured) {
    throw new Error('SMTP is not configured. Add SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, and SMTP_FROM to server/.env.');
  }

  const configKey = JSON.stringify({
    host: config.host,
    port: config.port,
    secure: config.secure,
    user: config.user,
    from: config.from,
  });

  if (cachedTransporter && cachedConfigKey === configKey) {
    return { transporter: cachedTransporter, config };
  }

  cachedTransporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: {
      user: config.user,
      pass: config.pass,
    },
  });
  cachedConfigKey = configKey;

  return { transporter: cachedTransporter, config };
}

async function sendOtpEmail({ email, code, purpose }) {
  const { transporter, config } = getTransporter();
  const actionLabel = purpose === 'reset_password' ? 'reset your password' : 'sign in';

  await transporter.sendMail({
    from: config.from,
    to: email,
    subject: `Your Incident Workspace OTP (${code})`,
    text: [
      `Use this one-time password to ${actionLabel}: ${code}`,
      '',
      'This code expires in 10 minutes.',
      'If you did not request this code, you can ignore this email.',
    ].join('\n'),
    html: [
      '<div style="font-family:Arial,sans-serif;line-height:1.6;color:#111827;">',
      '<h2 style="margin-bottom:8px;">Incident Workspace OTP</h2>',
      `<p>Use this one-time password to ${actionLabel}.</p>`,
      `<p style="font-size:28px;font-weight:700;letter-spacing:6px;margin:18px 0;">${code}</p>`,
      '<p>This code expires in 10 minutes.</p>',
      '<p>If you did not request this code, you can ignore this email.</p>',
      '</div>',
    ].join(''),
  });
}

module.exports = {
  getMailerConfig,
  sendOtpEmail,
};
