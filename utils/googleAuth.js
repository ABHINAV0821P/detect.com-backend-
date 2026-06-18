const crypto = require('crypto');
const { getRequiredEnv } = require('./env');

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
const REQUEST_TIMEOUT_MS = 8000;

let cachedKeys = null;
let cacheExpiresAt = 0;

function createTimeoutSignal(timeoutMs) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(timeoutMs);
  }

  return undefined;
}

function decodeBase64UrlJson(value) {
  return JSON.parse(Buffer.from(String(value || ''), 'base64url').toString('utf8'));
}

async function getGoogleKeys({ forceRefresh = false } = {}) {
  if (forceRefresh) {
    cachedKeys = null;
    cacheExpiresAt = 0;
  }

  if (cachedKeys && Date.now() < cacheExpiresAt) {
    return cachedKeys;
  }

  const response = await fetch(GOOGLE_JWKS_URL, {
    signal: createTimeoutSignal(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error('Unable to download Google signing keys.');
  }

  const cacheControl = response.headers.get('cache-control') || '';
  const maxAgeMatch = cacheControl.match(/max-age=(\d+)/);
  const maxAgeMs = maxAgeMatch ? Number(maxAgeMatch[1]) * 1000 : 60 * 60 * 1000;
  const body = await response.json();

  cachedKeys = body.keys || [];
  cacheExpiresAt = Date.now() + maxAgeMs;
  return cachedKeys;
}

function verifySignature(signingInput, signature, jwk) {
  const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  return crypto.verify(
    'RSA-SHA256',
    Buffer.from(signingInput),
    publicKey,
    Buffer.from(signature, 'base64url')
  );
}

async function verifyGoogleIdToken(idToken) {
  const clientId = getRequiredEnv('GOOGLE_CLIENT_ID');

  const token = String(idToken || '').trim();
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid Google credential.');
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeBase64UrlJson(encodedHeader);
  const payload = decodeBase64UrlJson(encodedPayload);

  if (header.alg !== 'RS256' || !header.kid) {
    throw new Error('Unsupported Google token algorithm.');
  }

  const keys = await getGoogleKeys();
  let signingKey = keys.find(key => key.kid === header.kid);
  if (!signingKey) {
    const refreshedKeys = await getGoogleKeys({ forceRefresh: true });
    signingKey = refreshedKeys.find(key => key.kid === header.kid);
  }

  if (!signingKey) {
    throw new Error('Unable to match Google signing key.');
  }

  const signingInput = `${encodedHeader}.${encodedPayload}`;
  if (!verifySignature(signingInput, encodedSignature, signingKey)) {
    throw new Error('Google token signature verification failed.');
  }

  const expiresAtMs = Number(payload.exp || 0) * 1000;
  if (!expiresAtMs || expiresAtMs <= Date.now()) {
    throw new Error('Google credential has expired.');
  }

  if (!GOOGLE_ISSUERS.has(payload.iss)) {
    throw new Error('Google credential issuer is invalid.');
  }

  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(clientId)) {
    throw new Error('Google credential audience is invalid.');
  }

  if (!payload.sub || !payload.email) {
    throw new Error('Google profile information is incomplete.');
  }

  if (payload.email_verified === false) {
    throw new Error('Google account email is not verified.');
  }

  return {
    googleId: payload.sub,
    email: String(payload.email).toLowerCase(),
    displayName: payload.name || payload.email,
  };
}

module.exports = { verifyGoogleIdToken };
