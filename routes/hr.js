const router = require('express').Router();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { db, COST_CENTERS, BRANCHES, addUser, addBank, nextEmpCode, audit, hash, publicUser } = require('../store');
const { auth, role } = require('../middleware/auth');
const { view } = require('../claimUtil');
const { chequeUpload, removeFiles, ROOT, CHEQUE_MAX } = require('../middleware/uploadMiddleware');
const { sendEmail } = require('../mailer');

router.use(auth, role('hr'));

const DEPARTMENTS = Object.keys(COST_CENTERS);
const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const withBank = (u) => ({ ...publicUser(u), bank: db.bank.find((b) => b.userId === u.id) || null });

router.get('/next-employee-code', (req, res) => res.json({ code: nextEmpCode() }));
router.get('/meta', (req, res) => res.json({ departments: DEPARTMENTS, costCenters: COST_CENTERS, branches: BRANCHES }));

router.get('/stats', (req, res) => {
  const employees = db.users.filter((u) => u.role === 'employee');
  const employeeIds = new Set(employees.map((u) => u.id));
  const pending = db.bank.filter((b) => employeeIds.has(b.userId) && b.status === 'Pending').length;
  res.json({
    total: employees.length, active: employees.filter((u) => u.status === 'active').length, frozen: employees.filter((u) => u.status === 'frozen').length,
    pendingBank: pending, byBranch: BRANCHES.map((b) => ({ branch: b, count: employees.filter((u) => u.branch === b && u.status === 'active').length })),
  });
});

router.get('/employees', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  let list = db.users.filter((u) => u.role === 'employee');
  if (req.query.status) list = list.filter((u) => u.status === req.query.status);
  if (q) list = list.filter((u) => u.empCode.toLowerCase().includes(q) || u.fullName.toLowerCase().includes(q) || u.email.toLowerCase().includes(q));
  res.json(list.map(withBank).sort((a, b) => a.empCode.localeCompare(b.empCode)));
});

router.get('/employees/:id', (req, res) => {
  const u = db.users.find((x) => x.id === req.params.id);
  u ? res.json(withBank(u)) : res.status(404).json({ message: 'Employee not found' });
});

router.get('/employees/:id/claims', (req, res) => {
  const list = db.claims.filter((c) => c.employeeId === req.params.id && c.status !== 'DRAFT').sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
  res.json(list.map((c) => { const v = view(c, { withEmployee: false }); return { id: v.id, ticketRef: v.ticketRef, status: v.status, total: v.total, submittedAt: v.submittedAt, utr: v.utr }; }));
});

// Create employee — bank verification can be completed after the employee uploads a cheque.
router.post('/employees', chequeUpload.single('chequeFile'), async (req, res) => {
  const b = req.body || {};
  const bail = (code, message, errors) => { removeFiles(req.file ? [req.file] : []); return res.status(code).json({ message, errors }); };
  const errors = [];
  const req_ = (k, label) => { if (!b[k] || !String(b[k]).trim()) errors.push(`${label} is required`); };
  [['fullName', 'Full name'], ['email', 'Official email'], ['phoneNumber', 'Phone'], ['joiningDate', 'Date of joining'],
    ['branchLocation', 'Branch location'], ['accountHolderName', 'Account holder name'],
    ['bankName', 'Bank name'], ['accountNumber', 'Account number'], ['ifscCode', 'IFSC code']].forEach(([k, l]) => req_(k, l));
  if (b.email && !EMAIL.test(b.email)) errors.push('Official email is invalid');
  if (b.email && db.users.some((u) => u.email.toLowerCase() === b.email.toLowerCase())) errors.push('An employee with this email already exists');
  if (b.branchLocation && !BRANCHES.includes(b.branchLocation)) errors.push('Unknown branch');
  if (b.accountNumber && !/^\d{9,18}$/.test(b.accountNumber)) errors.push('Account number must be 9–18 digits');
  if (b.ifscCode && !IFSC.test(String(b.ifscCode).toUpperCase())) errors.push('IFSC code is invalid');
  if (errors.length) return bail(400, errors[0], errors);

  const setupToken = crypto.randomBytes(32).toString('hex');
  const setupTokenHash = crypto.createHash('sha256').update(setupToken).digest('hex');
  const setupTokenExpiresAt = Date.now() + 24 * 60 * 60 * 1000;
  const setupUrl = `${process.env.CLIENT_ORIGIN || 'http://localhost:5173'}/set-password?token=${setupToken}`;
  try {
    await sendEmail(b.email.trim().toLowerCase(), 'Set up your EERMS account', `Welcome to EERMS, ${b.fullName.trim()}.\nYour account is ready. Set your password using this one-time link within 24 hours:\n${setupUrl}`);
  } catch (error) {
    console.error('Failed to send employee password setup email:', error.message);
    const message = error.code === 'EAUTH'
      ? 'SMTP authentication failed. Check the email address and app password in eerms-backend/.env.'
      : error.code === 'ENOTFOUND' || error.code === 'ECONNECTION' || error.code === 'ETIMEDOUT'
        ? 'Could not connect to the SMTP server. Check SMTP_HOST, SMTP_PORT, and network access.'
        : error.code === 'SMTP_CONFIG'
          ? error.message
          : 'Could not send the password setup email. Check SMTP settings in eerms-backend/.env and try again.';
    return bail(502, message);
  }

  const user = addUser({
    fullName: b.fullName.trim(), email: b.email.trim().toLowerCase(), passwordHash: null, role: 'employee', phone: b.phoneNumber, designation: '',
    joiningDate: b.joiningDate, department: '', costCenter: '', branch: b.branchLocation,
    reportingManager: '', mustChange: false, setupTokenHash, setupTokenExpiresAt,
  });
  const bank = addBank(user.id, {
    accountHolder: b.accountHolderName.trim(), bankName: b.bankName.trim(), accountNumber: b.accountNumber, ifsc: String(b.ifscCode).toUpperCase(),
    chequeFileName: req.file ? req.file.originalname : null, chequeFilePath: req.file ? req.file.filename : null, chequeFileSize: req.file ? req.file.size : null,
    ctsAuditChecks: Array(3).fill(false), status: 'Pending', verifiedAt: null,
  });
  audit(req.user, 'EMPLOYEE_CREATED', user.empCode, `bank ${bank.status}`, req.ip);
  res.status(201).json({ employee: withBank(user), bankStatus: bank.status, emailDelivery: 'sent' });
});

router.put('/employees/:id', (req, res) => {
  const u = db.users.find((x) => x.id === req.params.id);
  if (!u) return res.status(404).json({ message: 'Employee not found' });
  const b = req.body || {};
  if (b.department && !DEPARTMENTS.includes(b.department)) return res.status(400).json({ message: 'Unknown department' });
  if (b.branch && !BRANCHES.includes(b.branch)) return res.status(400).json({ message: 'Unknown branch' });
  const before = `${u.branch}/${u.department}`;
  ['fullName', 'phone', 'designation', 'department', 'costCenter', 'branch', 'reportingManager'].forEach((k) => { if (b[k] !== undefined) u[k] = b[k]; });
  audit(req.user, 'EMPLOYEE_UPDATED', u.empCode, `${before} → ${u.branch}/${u.department}`, req.ip);
  res.json(withBank(u));
});

// Bank detail change → re-verification required
router.put('/employees/:id/bank', chequeUpload.single('chequeFile'), (req, res) => {
  const u = db.users.find((x) => x.id === req.params.id);
  const b = req.body || {};
  if (!u) { removeFiles(req.file ? [req.file] : []); return res.status(404).json({ message: 'Employee not found' }); }
  if (!/^\d{9,18}$/.test(b.accountNumber || '') || !IFSC.test(String(b.ifscCode || '').toUpperCase()) || !b.bankName || !b.accountHolderName || !req.file) {
    removeFiles(req.file ? [req.file] : []);
    return res.status(400).json({ message: 'Account holder, bank, 9–18 digit account, valid IFSC and a cheque file are required' });
  }
  addBank(u.id, { accountHolder: b.accountHolderName, bankName: b.bankName, accountNumber: b.accountNumber, ifsc: b.ifscCode.toUpperCase(), chequeFileName: req.file.originalname, chequeFilePath: req.file.filename, chequeFileSize: req.file.size, status: 'Pending' });
  audit(req.user, 'BANK_UPDATED', u.empCode, 'Re-verification required', req.ip);
  res.json(withBank(u));
});

router.post('/employees/:id/freeze', (req, res) => {
  const u = db.users.find((x) => x.id === req.params.id);
  if (!u) return res.status(404).json({ message: 'Employee not found' });
  if (u.id === req.user.id) return res.status(400).json({ message: 'You cannot freeze your own account' });
  const frozen = req.body && req.body.freeze === false ? false : true;
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  if (frozen && !reason) return res.status(400).json({ message: 'A reason is required to freeze an employee' });
  if (reason.length > 500) return res.status(400).json({ message: 'Freeze reason must be 500 characters or fewer' });
  u.status = frozen ? 'frozen' : 'active';
  const pending = db.claims.filter((c) => c.employeeId === u.id && ['SUBMITTED', 'UNDER_REVIEW', 'INFO_REQUESTED', 'APPROVED'].includes(c.status)).length;
  audit(req.user, frozen ? 'EMPLOYEE_FROZEN' : 'EMPLOYEE_UNFROZEN', u.empCode, frozen ? `${reason} (${pending} unsettled claims)` : `${pending} unsettled claims`, req.ip);
  res.json({ employee: withBank(u), unsettledClaims: pending });
});

// ----- Bank Verification queue -----
router.get('/bank-verifications', (req, res) => {
  const st = req.query.status;
  res.json(db.bank.filter((b) => !st || b.status === st).map((b) => {
    const u = db.users.find((x) => x.id === b.userId);
    const checks = Array.isArray(b.ctsAuditChecks) ? b.ctsAuditChecks : [];
    return { ...b, ctsAuditChecks: checks.length === 7 ? [checks[3], checks[4], checks[5]] : checks.slice(0, 3), chequeFilePath: undefined, employee: u ? { id: u.id, empCode: u.empCode, fullName: u.fullName, department: u.department, branch: u.branch } : null };
  }).sort((a, b) => (a.status === 'Pending' ? -1 : 1)));
});

router.get('/bank/:userId/cheque', (req, res) => {
  const b = db.bank.find((x) => x.userId === req.params.userId);
  if (!b || !b.chequeFilePath) return res.status(404).json({ message: 'No cheque on file' });
  const filename = path.basename(b.chequeFilePath);
  const p1 = path.join(ROOT, 'cheques', filename);
  const p2 = path.join(__dirname, '..', 'uploads', 'cheques', filename);
  const p = fs.existsSync(p1) ? p1 : (fs.existsSync(p2) ? p2 : null);
  if (!p) return res.status(404).json({ message: 'File missing' });
  res.sendFile(p);
});

router.post('/bank/:userId/decision', (req, res) => {
  const b = db.bank.find((x) => x.userId === req.params.userId);
  const u = db.users.find((x) => x.id === req.params.userId);
  if (!b || !u) return res.status(404).json({ message: 'Bank record not found' });
  const { decision, checks, reason } = req.body || {};
  if (Array.isArray(checks) && checks.length === 3) b.ctsAuditChecks = checks.map((x) => x === true);
  if (decision === 'approve') {
    if (!b.ctsAuditChecks.every(Boolean)) return res.status(400).json({ message: 'Tick all 3 bank detail checklist items before approving' });
    b.status = 'Verified'; b.rejectReason = null; b.verifiedAt = new Date().toISOString();
  } else if (decision === 'reject') {
    if (!reason || !reason.trim()) return res.status(400).json({ message: 'A rejection reason is mandatory' });
    b.status = 'Rejected'; b.rejectReason = reason.trim();
    notify(u.id, `Your bank details were rejected: ${b.rejectReason}. Contact HR.`);
  } else if (decision !== 'save') return res.status(400).json({ message: 'Invalid decision' });
  audit(req.user, 'BANK_' + String(decision).toUpperCase(), u.empCode, reason || '', req.ip);
  res.json(b);
});

router.CHEQUE_MAX = CHEQUE_MAX;
module.exports = router;
