const crypto = require('crypto');
const {
  findUserByIdentifier,
  findUserByEmail,
  verifyPassword,
  createOrUpdateGoogleUser,
  generateOtpCode,
  setUserOtp,
  verifyUserOtp,
  updateUserPassword,
} = require('./users');
const { verifyGoogleIdToken } = require('./googleAuth');
const { getBooleanEnv, getIntegerEnv, getOptionalEnv, getRequiredEnv } = require('./env');
const { getMailerConfig, sendOtpEmail } = require('./mailer');

function getAuthConfig() {
  const ttlHours = getIntegerEnv('AUTH_TOKEN_TTL_HOURS', 12);
  if (ttlHours <= 0) {
    throw new Error('AUTH_TOKEN_TTL_HOURS must be greater than 0.');
  }

  return {
    secret: getRequiredEnv('AUTH_SECRET'),
    ttlMs: ttlHours * 60 * 60 * 1000,
  };
}

function shouldExposeDebugOtp() {
  return getBooleanEnv('AUTH_DEBUG_OTP', process.env.NODE_ENV !== 'production');
}

function buildToken(user) {
  const { secret, ttlMs } = getAuthConfig();
  const issuedAtMs = Date.now();
  const payload = Buffer.from(JSON.stringify({
    username: user.username,
    role: user.role,
    authProvider: user.authProvider || 'local',
    email: user.email || null,
    displayName: user.displayName || user.username,
    issuedAt: new Date(issuedAtMs).toISOString(),
    expiresAt: new Date(issuedAtMs + ttlMs).toISOString(),
  })).toString('base64url');

  const signature = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('base64url');

  return `${payload}.${signature}`;
}

function buildSession(user) {
  return {
    token: buildToken(user),
    user: {
      username: user.username,
      role: user.role,
      authProvider: user.authProvider || 'local',
      email: user.email || null,
      displayName: user.displayName || user.username,
    },
  };
}

function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [payload, signature] = token.split('.');
  const { secret } = getAuthConfig();
  const expected = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('base64url');

  const provided = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);

  if (provided.length !== expectedBuffer.length || !crypto.timingSafeEqual(provided, expectedBuffer)) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const expiresAtMs = Date.parse(parsed.expiresAt);

    if (!expiresAtMs || Number.isNaN(expiresAtMs) || expiresAtMs <= Date.now()) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

async function authenticate(identifier, password) {
  const user = await findUserByIdentifier(identifier);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return null;
  }

  return buildSession(user);
}

async function authenticateGoogle(idToken) {
  const profile = await verifyGoogleIdToken(idToken);
  const user = await createOrUpdateGoogleUser(profile);
  return buildSession(user);
}

async function requestOtp(email, purpose = 'login') {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const genericMessage = 'If that email is registered, an OTP has been prepared.';
  const user = await findUserByEmail(normalizedEmail);
  const mailer = getMailerConfig();

  if (!user) {
    return { message: genericMessage };
  }

  if (purpose === 'reset_password' && !user.passwordHash) {
    throw new Error('Password reset is only available for email/password accounts.');
  }

  const code = generateOtpCode();
  await setUserOtp(user, { code, purpose, ttlMinutes: 10 });
  console.log(`[auth:${purpose}] OTP prepared for ${normalizedEmail}.`);

  if (mailer.configured) {
    await sendOtpEmail({ email: normalizedEmail, code, purpose });
  } else if (!shouldExposeDebugOtp()) {
    throw new Error('SMTP is not configured for OTP delivery. Add SMTP settings or re-enable AUTH_DEBUG_OTP for local testing.');
  }

  return {
    message: genericMessage,
    delivery: mailer.configured ? 'email' : 'debug',
    debugOtp: !mailer.configured && shouldExposeDebugOtp() ? code : undefined,
  };
}

async function authenticateWithOtp(email, code) {
  const user = await findUserByEmail(email);
  if (!user) {
    throw new Error('No account exists for that email.');
  }

  await verifyUserOtp(user, { code, purpose: 'login' });
  return buildSession(user);
}

async function resetPasswordWithOtp(email, code, newPassword) {
  const user = await findUserByEmail(email);
  if (!user) {
    throw new Error('No account exists for that email.');
  }

  if (!user.passwordHash) {
    throw new Error('Password reset is only available for email/password accounts.');
  }

  await verifyUserOtp(user, { code, purpose: 'reset_password' });
  await updateUserPassword(user, newPassword);
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const user = verifyToken(token);

  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  req.user = user;
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    next();
  };
}

module.exports = {
  authenticate,
  authenticateGoogle,
  requestOtp,
  authenticateWithOtp,
  resetPasswordWithOtp,
  requireAuth,
  requireRole,
  verifyToken,
};
