const router = require('express').Router();
const { db, audit } = require('../store');
const { auth, role } = require('../middleware/auth');

router.use(auth, role('employee'));

function profile(user) {
  const bank = db.bank.find((record) => record.userId === user.id);
  return {
    employee: {
      id: user.id,
      empCode: user.empCode,
      fullName: user.fullName,
      email: user.email,
      phone: user.phone,
      branch: user.branch,
      joiningDate: user.joiningDate || null,
    },
    bank: bank ? {
      accountHolder: bank.accountHolder,
      bankName: bank.bankName,
      accountNumber: bank.accountNumber,
      ifsc: bank.ifsc,
      status: bank.status,
      rejectReason: bank.rejectReason,
    } : null,
  };
}

router.get('/profile', (req, res) => res.json(profile(req.user)));

router.put('/profile', (req, res) => {
  const { fullName, phone } = req.body || {};
  if (!String(fullName || '').trim()) return res.status(400).json({ message: 'Full name is required' });
  if (String(fullName).trim().length > 150) return res.status(400).json({ message: 'Full name must be 150 characters or fewer' });
  if (phone !== undefined && String(phone).length > 20) return res.status(400).json({ message: 'Phone must be 20 characters or fewer' });
  req.user.fullName = String(fullName).trim();
  if (phone !== undefined) req.user.phone = String(phone).trim();
  audit(req.user, 'PROFILE_UPDATED', req.user.empCode, 'Personal details updated', req.ip);
  res.json(profile(req.user));
});

module.exports = router;
