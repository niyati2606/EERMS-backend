const router = require('express').Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { db, publicUser, audit, hash } = require('../store');
const { sign, auth } = require('../middleware/auth');
const { sendEmail } = require('../mailer');
const { getFrontendUrl } = require('../claimUtil');

const DASH = { employee: '/employee/dashboard', finance: '/finance/dashboard', hr: '/hr/dashboard', admin: '/admin/dashboard' };

router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ message: 'Email and password are required' });
  const user = db.users.find((u) => u.email.toLowerCase() === String(email).trim().toLowerCase());
  if (!user || user.passwordHash && !bcrypt.compareSync(password, user.passwordHash)) {
    audit(null, 'LOGIN_FAILED', 'auth', String(email), req.ip);
    return res.status(401).json({ message: 'Invalid email or password' });
  }
  if (!user.passwordHash || user.status === 'pending') {
    audit(null, 'LOGIN_FAILED', 'auth', String(email), req.ip);
    return res.status(403).json({ message: 'Password setup is not complete. Please use the setup link sent to your email or contact HR for a new link.' });
  }
  if (user.status !== 'active') return res.status(403).json({ message: 'This account is deactivated. Please contact HR Team.' });
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
  user.status = 'active';
  user.passwordResetTokenHash = null;
  user.passwordResetTokenExpiresAt = null;
  audit(user, 'PASSWORD_SET', 'auth', 'Password set from onboarding link', req.ip);
  res.json({ message: 'Password created. You can now sign in.' });
});

router.post('/request-password-reset', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ message: 'A valid email address is required' });
  }

  const user = db.users.find((candidate) => candidate.email.toLowerCase() === email && candidate.status === 'active');
  if (user) {
    const token = crypto.randomBytes(32).toString('hex');
    user.passwordResetTokenHash = crypto.createHash('sha256').update(token).digest('hex');
    user.passwordResetTokenExpiresAt = Date.now() + 60 * 60 * 1000;
    const origin = getFrontendUrl(req);
    const resetUrl = `${origin}/reset-password?token=${token}`;
    try {
      await sendEmail(
        user.email,
        'Reset your EERMS password',
        `Hello ${user.fullName},\n\nUse this one-time link to reset your EERMS password within 1 hour:\n${resetUrl}\n\nIf you did not request this, you can ignore this email.`
      );
      audit(user, 'PASSWORD_RESET_REQUESTED', 'auth', 'Password reset email sent', req.ip);
    } catch (error) {
      user.passwordResetTokenHash = null;
      user.passwordResetTokenExpiresAt = null;
      console.error('Failed to send password reset email:', error.message);
      return res.status(502).json({ message: 'Could not send the password reset email. Check the email service configuration and try again.' });
    }
  }

  res.json({ message: 'If an active account uses that email, a password reset link has been sent.' });
});

router.post('/reset-password', (req, res) => {
  const { token, newPassword } = req.body || {};
  if (!token || !newPassword) return res.status(400).json({ message: 'Reset link and new password are required' });
  if (typeof newPassword !== 'string' || newPassword.length < 8) return res.status(400).json({ message: 'Password must be at least 8 characters' });

  const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
  const user = db.users.find((candidate) => candidate.passwordResetTokenHash === tokenHash);
  if (!user || !user.passwordResetTokenExpiresAt || Date.now() > user.passwordResetTokenExpiresAt) {
    return res.status(400).json({ message: 'This password reset link is invalid or expired. Request a new link.' });
  }

  user.passwordHash = hash(newPassword);
  user.passwordResetTokenHash = null;
  user.passwordResetTokenExpiresAt = null;
  user.mustChange = false;
  audit(user, 'PASSWORD_RESET', 'auth', 'Password reset from email link', req.ip);
  res.json({ message: 'Password reset. You can now sign in.' });
});

router.get('/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));

router.post('/change-password', auth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!bcrypt.compareSync(currentPassword || '', req.user.passwordHash)) return res.status(400).json({ message: 'Current password is incorrect' });
  if (!newPassword || newPassword.length < 8) return res.status(400).json({ message: 'New password must be at least 8 characters' });
  req.user.passwordHash = hash(newPassword);
  req.user.mustChange = false;
  req.user.passwordResetTokenHash = null;
  req.user.passwordResetTokenExpiresAt = null;
  audit(req.user, 'PASSWORD_CHANGED', 'auth', '', req.ip);
  res.json({ message: 'Password updated', user: publicUser(req.user) });
});

module.exports = router;
