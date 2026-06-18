const crypto = require('crypto');
const User = require('../models/User');
const { getOptionalEnv } = require('./env');
const { expectEmail } = require('./validation');

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derivedKey = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derivedKey}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, expectedHash] = storedHash.split(':');
  const actualHash = crypto.scryptSync(password, salt, 64).toString('hex');
  const expected = Buffer.from(expectedHash, 'hex');
  const actual = Buffer.from(actualHash, 'hex');

  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

function clearOtpState(user) {
  user.otp = {
    codeHash: null,
    purpose: null,
    expiresAt: null,
    requestedAt: null,
  };
}

function hashOtp(code) {
  return crypto.createHash('sha256').update(String(code || '')).digest('hex');
}

function generateOtpCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

async function ensureAdminUser() {
  const username = getOptionalEnv('AUTH_USERNAME');
  const password = getOptionalEnv('AUTH_PASSWORD');
  const email = getOptionalEnv('AUTH_EMAIL') || null;

  if (!username && !password) {
    return;
  }

  if (!username || !password) {
    throw new Error('AUTH_USERNAME and AUTH_PASSWORD must both be set to seed an admin user.');
  }

  const existing = await User.findOne({ username });
  if (existing) return;

  await User.create({
    username,
    passwordHash: hashPassword(password),
    role: 'admin',
    authProvider: 'local',
    email: email ? expectEmail(email) : null,
  });

  console.log(`Seeded admin user "${username}" in MongoDB.`);
}

async function findUserByUsername(username) {
  return User.findOne({ username: String(username || '').trim() });
}

async function findUserByEmail(email) {
  return User.findOne({ email: String(email || '').trim().toLowerCase() });
}

async function findUserByIdentifier(identifier) {
  const normalized = String(identifier || '').trim();
  if (!normalized) {
    return null;
  }

  return User.findOne({
    $or: [
      { username: normalized },
      { email: normalized.toLowerCase() },
    ],
  });
}

async function listUsers() {
  const users = await User.find({}).sort({ createdAt: -1 }).lean();
  return users.map(user => ({
    username: user.username,
    role: user.role,
    authProvider: user.authProvider || 'local',
    email: user.email || null,
    createdAt: user.createdAt,
  }));
}

async function createUser({ username, email, password, role }) {
  const normalizedUsername = String(username || '').trim();
  const normalizedEmail = expectEmail(email);

  if (!normalizedUsername || !password) {
    throw new Error('Username, email, and password are required.');
  }

  if (normalizedUsername.length < 3) {
    throw new Error('Username must be at least 3 characters long.');
  }

  if (!/^[a-zA-Z0-9._-]+$/.test(normalizedUsername)) {
    throw new Error('Username may only contain letters, numbers, dots, underscores, and hyphens.');
  }

  if (password.length < 6) {
    throw new Error('Password must be at least 6 characters long.');
  }

  if (!['admin', 'verifier', 'reporter'].includes(role)) {
    throw new Error('Role must be admin, verifier, or reporter.');
  }

  const existing = await User.findOne({ username: normalizedUsername });
  if (existing) {
    throw new Error('Username already exists.');
  }

  const existingEmail = await User.findOne({ email: normalizedEmail });
  if (existingEmail) {
    throw new Error('Email already exists.');
  }

  const user = await User.create({
    username: normalizedUsername,
    passwordHash: hashPassword(password),
    role,
    authProvider: 'local',
    email: normalizedEmail,
  });

  return {
    username: user.username,
    role: user.role,
    authProvider: user.authProvider,
    email: user.email || null,
    createdAt: user.createdAt,
  };
}

async function setUserOtp(user, { code, purpose, ttlMinutes = 10 }) {
  const requestedAt = new Date();
  const previousRequestedAt = Date.parse(user.otp?.requestedAt || '');

  if (previousRequestedAt && (Date.now() - previousRequestedAt) < 30 * 1000) {
    throw new Error('Please wait a few seconds before requesting another OTP.');
  }

  user.otp = {
    codeHash: hashOtp(code),
    purpose,
    requestedAt: requestedAt.toISOString(),
    expiresAt: new Date(requestedAt.getTime() + ttlMinutes * 60 * 1000).toISOString(),
  };
  await user.save();
}

async function verifyUserOtp(user, { code, purpose }) {
  const normalizedCode = String(code || '').trim();
  if (!normalizedCode) {
    throw new Error('OTP is required.');
  }

  if (!user?.otp?.codeHash || !user?.otp?.purpose || !user?.otp?.expiresAt) {
    throw new Error('No OTP request is active for this account.');
  }

  if (user.otp.purpose !== purpose) {
    throw new Error('This OTP was issued for a different action.');
  }

  const expiresAtMs = Date.parse(user.otp.expiresAt);
  if (!expiresAtMs || Number.isNaN(expiresAtMs) || expiresAtMs <= Date.now()) {
    clearOtpState(user);
    await user.save();
    throw new Error('OTP has expired. Request a new code.');
  }

  if (hashOtp(normalizedCode) !== user.otp.codeHash) {
    throw new Error('OTP is invalid.');
  }

  clearOtpState(user);
  await user.save();
}

async function updateUserPassword(user, password) {
  if (!password || password.length < 6) {
    throw new Error('Password must be at least 6 characters long.');
  }

  user.passwordHash = hashPassword(password);
  if (!user.authProvider || user.authProvider === 'google') {
    user.authProvider = 'local';
  }
  await user.save();
}

async function createOrUpdateGoogleUser({ googleId, email, displayName }) {
  const normalizedGoogleId = String(googleId || '').trim();
  const normalizedEmail = expectEmail(email);
  const normalizedDisplayName = String(displayName || normalizedEmail).trim();

  if (!normalizedGoogleId || !normalizedEmail) {
    throw new Error('Google account details are required.');
  }

  let user = await User.findOne({
    $or: [{ googleId: normalizedGoogleId }, { email: normalizedEmail }],
  });

  if (user) {
    user.googleId = normalizedGoogleId;
    user.email = normalizedEmail;
    user.displayName = normalizedDisplayName || user.displayName;
    user.authProvider = 'google';
    if (!user.username) {
      user.username = normalizedEmail;
    }
    await user.save();
  } else {
    user = await User.create({
      username: normalizedEmail,
      passwordHash: null,
      role: 'reporter',
      authProvider: 'google',
      googleId: normalizedGoogleId,
      email: normalizedEmail,
      displayName: normalizedDisplayName,
    });
  }

  return {
    username: user.username,
    role: user.role,
    authProvider: user.authProvider,
    email: user.email || null,
    displayName: user.displayName || user.username,
    createdAt: user.createdAt,
  };
}

module.exports = {
  ensureAdminUser,
  findUserByUsername,
  findUserByEmail,
  findUserByIdentifier,
  verifyPassword,
  listUsers,
  createUser,
  generateOtpCode,
  setUserOtp,
  verifyUserOtp,
  updateUserPassword,
  createOrUpdateGoogleUser,
};
