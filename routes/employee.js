const router = require('express').Router();
const path = require('path');
const { db, addBank, audit } = require('../store');
const { auth, role } = require('../middleware/auth');
const { chequeUpload, removeFiles } = require('../middleware/uploadMiddleware');

const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;

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
      designation: user.designation,
      joiningDate: user.joiningDate,
      department: user.department,
      costCenter: user.costCenter,
      branch: user.branch,
      reportingManager: user.reportingManager,
    },
    bank: bank ? {
      accountHolder: bank.accountHolder,
      bankName: bank.bankName,
      accountNumber: bank.accountNumber,
      ifsc: bank.ifsc,
      chequeFileName: bank.chequeFileName,
      chequeFileSize: bank.chequeFileSize,
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

router.put('/profile/bank', chequeUpload.single('chequeFile'), (req, res) => {
  const b = req.body || {};
  const accountNumber = String(b.accountNumber || '').trim();
  const ifsc = String(b.ifsc || '').trim().toUpperCase();
  const accountHolder = String(b.accountHolder || '').trim();
  const bankName = String(b.bankName || '').trim();
  const errors = [];
  if (!accountHolder) errors.push('Account holder name is required');
  if (accountHolder.length > 150) errors.push('Account holder name must be 150 characters or fewer');
  if (!bankName) errors.push('Bank name is required');
  if (bankName.length > 100) errors.push('Bank name must be 100 characters or fewer');
  if (!/^\d{9,18}$/.test(accountNumber)) errors.push('Account number must be 9–18 digits');
  if (!IFSC.test(ifsc)) errors.push('Enter a valid IFSC code');
  if (!req.file) errors.push('A new cancelled cheque is required for verification');
  if (errors.length) {
    removeFiles(req.file ? [req.file] : []);
    return res.status(400).json({ message: errors[0], errors });
  }

  const previous = db.bank.find((record) => record.userId === req.user.id);
  addBank(req.user.id, {
    accountHolder,
    bankName,
    accountNumber,
    ifsc,
    chequeFileName: req.file.originalname,
    chequeFilePath: req.file.filename,
    chequeFileSize: req.file.size,
    ctsAuditChecks: Array(3).fill(false),
    status: 'Pending',
    rejectReason: null,
    verifiedAt: null,
  });
  if (previous && previous.chequeFilePath) {
    removeFiles([{ path: path.join(__dirname, '..', 'uploads', 'cheques', path.basename(previous.chequeFilePath)) }]);
  }
  audit(req.user, 'BANK_UPDATED', req.user.empCode, 'Employee changed bank details; verification required', req.ip);
  res.json({ ...profile(req.user), message: 'Bank details updated and sent for verification.' });
});

module.exports = router;
