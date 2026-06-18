function normalizeString(value, { maxLength = 1000, allowEmpty = false } = {}) {
  const normalized = String(value || '').trim();
  if (!allowEmpty && !normalized) {
    return '';
  }

  return normalized.slice(0, maxLength);
}

function normalizeEmail(value, { maxLength = 320, allowEmpty = false } = {}) {
  return normalizeString(value, { maxLength, allowEmpty }).toLowerCase();
}

function expectNonEmptyString(value, fieldName, { maxLength = 1000, minLength = 1 } = {}) {
  const normalized = normalizeString(value, { maxLength, allowEmpty: false });

  if (!normalized) {
    throw new Error(`${fieldName} is required.`);
  }

  if (normalized.length < minLength) {
    throw new Error(`${fieldName} must be at least ${minLength} characters long.`);
  }

  return normalized;
}

function expectEmail(value, fieldName = 'Email') {
  const normalized = normalizeEmail(value, { maxLength: 320, allowEmpty: false });

  if (!normalized) {
    throw new Error(`${fieldName} is required.`);
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new Error(`${fieldName} must be a valid email address.`);
  }

  return normalized;
}

function parseJsonField(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  return JSON.parse(value);
}

function isAllowedMediaMimeType(mimeType) {
  return /^(image|video|audio)\//.test(String(mimeType || ''));
}

function isAllowedImageMimeType(mimeType) {
  return /^image\//.test(String(mimeType || ''));
}

module.exports = {
  normalizeString,
  normalizeEmail,
  expectNonEmptyString,
  expectEmail,
  parseJsonField,
  isAllowedMediaMimeType,
  isAllowedImageMimeType,
};
