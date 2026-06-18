const express = require('express');
const { requireAuth, requireRole } = require('../utils/auth');
const { listUsers, createUser } = require('../utils/users');

const router = express.Router();

router.use(requireAuth, requireRole('admin'));

router.get('/', async (req, res) => {
  const users = await listUsers();
  res.json({ users });
});

router.post('/', async (req, res) => {
  try {
    const user = await createUser({
      username: req.body.username,
      email: req.body.email,
      password: req.body.password,
      role: req.body.role,
    });

    res.status(201).json({ user });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
