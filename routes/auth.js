const router = require('express').Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { db, publicUser, audit, hash } = require('../store');
const { sign, auth } = require('../middleware/auth');

const DASH = { employee: '/employee/dashboard', finance: '/finance/dashboard', hr: '/hr/dashboard', admin: '/admin/dashboard' };

router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ message: 'Email and password are required' });
  const user = db.users.find((u) => u.email.toLowerCase() === String(email).trim().toLowerCase());
  if (!user || !user.passwordHash || !bcrypt.compareSync(password, user.passwordHash)) {
    audit(null, 'LOGIN_FAILED', 'auth', String(email), req.ip);
    return res.status(401).json({ message: 'Invalid email or password' });
  }
  if (user.status !== 'active') return res.status(403).json({ message: 'This account is frozen. Contact HR.' });
  audit(user, 'LOGIN', 'auth', 'Signed in', req.ip);
  res.json({ token: sign(user), user: publicUser(user), redirect: DASH[user.role] });
});

router.post('/setup-password', (req, res) => {
  const { token, newPassword } = req.body || {};
  if (!token || !newPassword) return res.status(400).json({ message: 'Setup link and new password are required' });
  if (typeof newPassword !== 'string' || newPassword.length < 8) return res.status(400).json({ message: 'Password must be at least 8 characters' });

  const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
  const user = db.users.find((candidate) => candidate.setupTokenHash === tokenHash);
  if (!user || !user.setupTokenExpiresAt || Date.now() > user.setupTokenExpiresAt) {
    return res.status(400).json({ message: 'This password setup link is invalid or expired. Contact HR for a new link.' });
  }

  user.passwordHash = hash(newPassword);
  user.setupTokenHash = null;
  user.setupTokenExpiresAt = null;
  user.mustChange = false;
  audit(user, 'PASSWORD_SET', 'auth', 'Password set from onboarding link', req.ip);
  res.json({ message: 'Password created. You can now sign in.' });
});

router.get('/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));

router.post('/change-password', auth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!bcrypt.compareSync(currentPassword || '', req.user.passwordHash)) return res.status(400).json({ message: 'Current password is incorrect' });
  if (!newPassword || newPassword.length < 8) return res.status(400).json({ message: 'New password must be at least 8 characters' });
  req.user.passwordHash = hash(newPassword);
  req.user.mustChange = false;
  audit(req.user, 'PASSWORD_CHANGED', 'auth', '', req.ip);
  res.json({ message: 'Password updated', user: publicUser(req.user) });
});

module.exports = router;
