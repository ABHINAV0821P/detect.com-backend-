const express = require('express');
const {
  authenticate,
  authenticateGoogle,
  requestOtp,
  authenticateWithOtp,
  resetPasswordWithOtp,
  requireAuth,
} = require('../utils/auth');
const { createUser } = require('../utils/users');
const { expectEmail, expectNonEmptyString } = require('../utils/validation');

const router = express.Router();

router.post('/register', async (req, res) => {
  try {
    const user = await createUser({
      username: req.body.username,
      email: req.body.email,
      password: req.body.password,
      role: 'reporter',
    });

    res.status(201).json({
      user,
      message: 'Reporter account created successfully. You can sign in now.',
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.post('/login', async (req, res) => {
  try {
    const identifier = expectNonEmptyString(req.body.identifier || req.body.username || req.body.email, 'Username or email', { minLength: 3, maxLength: 320 });
    const password = expectNonEmptyString(req.body.password, 'Password', { minLength: 6, maxLength: 200 });

    const session = await authenticate(identifier, password);
    if (!session) {
      return res.status(401).json({ error: 'Invalid username/email or password.' });
    }

    res.json(session);
  } catch (error) {
    res.status(400).json({ error: error.message || 'Unable to sign in.' });
  }
});

router.post('/otp/request', async (req, res) => {
  try {
    const email = expectEmail(req.body.email);
    const result = await requestOtp(email, 'login');
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message || 'Unable to request OTP.' });
  }
});

router.post('/otp/verify', async (req, res) => {
  try {
    const email = expectEmail(req.body.email);
    const otp = expectNonEmptyString(req.body.otp, 'OTP', { minLength: 4, maxLength: 12 });
    const session = await authenticateWithOtp(email, otp);
    res.json(session);
  } catch (error) {
    res.status(400).json({ error: error.message || 'Unable to verify OTP.' });
  }
});

router.post('/forgot-password/request', async (req, res) => {
  try {
    const email = expectEmail(req.body.email);
    const result = await requestOtp(email, 'reset_password');
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message || 'Unable to request password reset OTP.' });
  }
});

router.post('/forgot-password/reset', async (req, res) => {
  try {
    const email = expectEmail(req.body.email);
    const otp = expectNonEmptyString(req.body.otp, 'OTP', { minLength: 4, maxLength: 12 });
    const newPassword = expectNonEmptyString(req.body.newPassword, 'New password', { minLength: 6, maxLength: 200 });

    await resetPasswordWithOtp(email, otp, newPassword);
    res.json({ message: 'Password updated successfully. You can sign in now.' });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Unable to reset password.' });
  }
});

router.post('/google', async (req, res) => {
  try {
    const credential = expectNonEmptyString(req.body.credential, 'Google credential', { maxLength: 10000 });
    const session = await authenticateGoogle(credential);
    res.json(session);
  } catch (error) {
    const message = error.message || 'Unable to sign in with Google.';
    const statusCode = /not configured|missing/i.test(message)
      ? 500
      : /expired|invalid|unsupported|incomplete|not verified|signature/i.test(message)
        ? 401
        : 400;

    res.status(statusCode).json({ error: message });
  }
});

router.get('/session', requireAuth, (req, res) => {
  res.json({
    user: {
      username: req.user.username,
      role: req.user.role,
      authProvider: req.user.authProvider || 'local',
      email: req.user.email || null,
      displayName: req.user.displayName || req.user.username,
    },
  });
});

module.exports = router;
