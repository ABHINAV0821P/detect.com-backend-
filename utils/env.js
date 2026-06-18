const fs = require('fs');
const path = require('path');

function loadEnvFile() {
  const envPath = path.join(__dirname, '..', '.env');

  if (!fs.existsSync(envPath)) {
    return;
  }

  const raw = fs.readFileSync(envPath, 'utf8');
  raw.split(/\r?\n/).forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) return;

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim().replace(/^['"]|['"]$/g, '');

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  });
}

function getOptionalEnv(key, fallback = '') {
  const value = process.env[key];
  if (value === undefined || value === null) {
    return fallback;
  }

  return String(value).trim();
}

function getRequiredEnv(key) {
  const value = getOptionalEnv(key);
  if (!value) {
    throw new Error(`${key} is missing. Add it to server/.env before starting the server.`);
  }
  return value;
}

function getArrayEnv(key, fallback = []) {
  const value = getOptionalEnv(key);
  if (!value) {
    return fallback;
  }

  return value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function getIntegerEnv(key, fallback) {
  const value = getOptionalEnv(key);
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${key} must be a valid integer.`);
  }

  return parsed;
}

function getBooleanEnv(key, fallback = false) {
  const value = getOptionalEnv(key);
  if (!value) {
    return fallback;
  }

  if (/^(true|1|yes|on)$/i.test(value)) {
    return true;
  }

  if (/^(false|0|no|off)$/i.test(value)) {
    return false;
  }

  throw new Error(`${key} must be true or false.`);
}

module.exports = {
  loadEnvFile,
  getOptionalEnv,
  getRequiredEnv,
  getArrayEnv,
  getIntegerEnv,
  getBooleanEnv,
};
