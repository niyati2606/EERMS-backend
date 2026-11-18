const router = require('express').Router();
const crypto = require('crypto');
const { db, BRANCHES, addUser, addBank, nextEmpCode, audit, notify, publicUser } = require('../store');
const { auth, role } = require('../middleware/auth');
const { view, getFrontendUrl } = require('../claimUtil');
const { sendEmail } = require('../mailer');

router.use(auth, role('hr'));

const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const isValidBankChecklist = (value) => Array.isArray(value) && value.length === 3 && [0, 1, 2].every((index) => typeof value[index] === 'boolean');
const SETUP_TOKEN_TTL_MS = 30 * 60 * 1000;

const withBank = (u) => ({ ...publicUser(u), bank: db.bank.find((b) => b.userId === u.id) || null });
const isValidDate = (value) => {
  if (typeof value !== 'string' || !DATE_ONLY.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

router.get('/next-employee-code', (req, res) => res.json({ code: nextEmpCode() }));
router.get('/meta', (req, res) => res.json({ branches: BRANCHES }));

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
  return res.status(403).json({ message: 'HR is not authorized to view claim history' });
});

// Finance staff management (HR)
router.get('/finance', (req, res) => {
  const list = db.users
    .filter((u) => u.role === 'finance')
    .map((u) => withBank(u))
    .sort((a, b) => a.empCode.localeCompare(b.empCode));
  res.json(list);
});

// Create finance employee (only name, email, phone, branch, employee code)
router.post('/finance', async (req, res) => {
  const b = req.body || {};
  const errors = [];
  const req_ = (k, label) => { if (!b[k] || !String(b[k]).trim()) errors.push(`${label} is required`); };
  [['fullName', 'Full name'], ['email', 'Official email'], ['phone', 'Phone number'], ['branch', 'Branch']].forEach(([k, l]) => req_(k, l));
  if (b.email && !EMAIL.test(b.email)) errors.push('Official email is invalid');
  if (b.email && db.users.some((u) => u.email.toLowerCase() === b.email.toLowerCase())) errors.push('A user with this email already exists');
  if (b.branch && !BRANCHES.includes(b.branch)) errors.push('Unknown branch');
  if (errors.length) return res.status(400).json({ message: errors[0], errors });

  const setupToken = crypto.randomBytes(32).toString('hex');
  const setupTokenHash = crypto.createHash('sha256').update(setupToken).digest('hex');
  const setupTokenExpiresAt = Date.now() + SETUP_TOKEN_TTL_MS;
  const origin = getFrontendUrl(req);
  const setupUrl = `${origin}/set-password?token=${setupToken}`;

  let emailSent = false;
  try {
    await sendEmail(
      b.email.trim().toLowerCase(),
      'Set up your EERMS Finance account',
      `Welcome to EERMS, ${b.fullName.trim()}.\nYour Finance account is ready. Set your password using this one-time link within 30 minutes:\n${setupUrl}`
    );
    emailSent = true;
  } catch (error) {
    console.error('Failed to send finance password setup email:', error.message);
  }

  const user = addUser({
    empCode: b.empCode && String(b.empCode).trim() ? String(b.empCode).trim() : nextEmpCode(),
    fullName: b.fullName.trim(),
    email: b.email.trim().toLowerCase(),
    phone: String(b.phone).trim(),
    branch: b.branch,
    passwordHash: null,
    role: 'finance',
    status: 'pending',
    mustChange: false,
    setupTokenHash,
    setupTokenExpiresAt,
  });

  audit(req.user, 'FINANCE_USER_CREATED', user.empCode, `Finance staff created (${user.fullName})`, req.ip);
  res.status(201).json({
    employee: withBank(user),
    message: emailSent ? 'Finance staff created and setup email sent.' : 'Finance staff created. Password setup link generated.',
    setupUrl,
  });
});

// Resend password setup email for any employee/finance user
router.post('/employees/:id/resend-setup', async (req, res) => {
  const u = db.users.find((x) => x.id === req.params.id);
  if (!u) return res.status(404).json({ message: 'User not found' });

  const setupToken = crypto.randomBytes(32).toString('hex');
  u.setupTokenHash = crypto.createHash('sha256').update(setupToken).digest('hex');
  u.setupTokenExpiresAt = Date.now() + SETUP_TOKEN_TTL_MS;

  const origin = getFrontendUrl(req);
  const setupUrl = `${origin}/set-password?token=${setupToken}`;

  let emailSent = false;
  try {
    await sendEmail(
      u.email,
      'Set up your EERMS password',
      `Hello ${u.fullName},\n\nHere is your new password setup link for EERMS. It is valid for 30 minutes:\n${setupUrl}`
    );
    emailSent = true;
    audit(req.user, 'SETUP_EMAIL_RESENT', u.empCode, `Sent to ${u.email}`, req.ip);
  } catch (error) {
    console.error('Failed to send setup email:', error.message);
    audit(req.user, 'SETUP_EMAIL_RESENT_SIMULATED', u.empCode, `Simulated for ${u.email}`, req.ip);
  }

  res.json({
    message: emailSent ? `Password setup email sent to ${u.email}.` : `Setup link generated for ${u.email}.`,
    setupUrl,
  });
});

// Create employee — bank details remain pending until HR verifies them.
router.post('/employees', async (req, res) => {
  const b = req.body || {};
  const errors = [];
  const req_ = (k, label) => { if (!b[k] || !String(b[k]).trim()) errors.push(`${label} is required`); };
  [['fullName', 'Full name'], ['email', 'Official email'], ['phoneNumber', 'Phone'],
    ['branchLocation', 'Branch location'], ['joiningDate', 'Joining date'], ['accountHolderName', 'Account holder name'],
    ['bankName', 'Bank name'], ['accountNumber', 'Account number'], ['ifscCode', 'IFSC code']].forEach(([k, l]) => req_(k, l));
  if (b.joiningDate && !isValidDate(b.joiningDate)) errors.push('Joining date is invalid');
  if (b.email && !EMAIL.test(b.email)) errors.push('Official email is invalid');
  if (b.email && db.users.some((u) => u.email.toLowerCase() === b.email.toLowerCase())) errors.push('An employee with this email already exists');
  if (b.branchLocation && !BRANCHES.includes(b.branchLocation)) errors.push('Unknown branch');
  if (b.accountNumber && !/^\d{9,18}$/.test(b.accountNumber)) errors.push('Account number must be 9–18 digits');
  if (b.ifscCode && !IFSC.test(String(b.ifscCode).toUpperCase())) errors.push('IFSC code is invalid');
  if (errors.length) return res.status(400).json({ message: errors[0], errors });

  const setupToken = crypto.randomBytes(32).toString('hex');
  const setupTokenHash = crypto.createHash('sha256').update(setupToken).digest('hex');
  const setupTokenExpiresAt = Date.now() + SETUP_TOKEN_TTL_MS;
  const origin = getFrontendUrl(req);
  const setupUrl = `${origin}/set-password?token=${setupToken}`;
  try {
    await sendEmail(b.email.trim().toLowerCase(), 'Set up your EERMS account', `Welcome to EERMS, ${b.fullName.trim()}.\nYour account is ready. Set your password using this one-time link within 30 minutes:\n${setupUrl}`);
  } catch (error) {
    console.error('Failed to send employee password setup email:', error.message);
    const message = error.code === 'EAUTH'
      ? 'SMTP authentication failed. Check the email address and app password in eerms-backend/.env.'
      : error.code === 'ENOTFOUND' || error.code === 'ECONNECTION' || error.code === 'ETIMEDOUT'
        ? 'Could not connect to the SMTP server. Check SMTP_HOST, SMTP_PORT, and network access.'
        : error.code === 'SMTP_CONFIG'
          ? error.message
          : 'Could not send the password setup email. Check SMTP settings in eerms-backend/.env and try again.';
    return res.status(502).json({ message });
  }

  const user = addUser({
    fullName: b.fullName.trim(), email: b.email.trim().toLowerCase(), passwordHash: null, role: 'employee', status: 'pending', phone: b.phoneNumber, branch: b.branchLocation,
    joiningDate: b.joiningDate, mustChange: false, setupTokenHash, setupTokenExpiresAt,
  });
  const bank = addBank(user.id, {
    accountHolder: b.accountHolderName.trim(), bankName: b.bankName.trim(), accountNumber: b.accountNumber, ifsc: String(b.ifscCode).toUpperCase(),
    status: 'Pending', verifiedAt: null,
  });
  audit(req.user, 'EMPLOYEE_CREATED', user.empCode, `bank ${bank.status}`, req.ip);
  res.status(201).json({ employee: withBank(user), bankStatus: bank.status, emailDelivery: 'sent' });
});

router.put('/employees/:id', (req, res) => {
  const u = db.users.find((x) => x.id === req.params.id);
  if (!u) return res.status(404).json({ message: 'Employee not found' });
  const b = req.body || {};
  const beforeBranch = u.branch;
  const beforeEmail = u.email;
  if (b.branch && !BRANCHES.includes(b.branch)) return res.status(400).json({ message: 'Unknown branch' });
  if (b.joiningDate !== undefined && b.joiningDate !== '' && !isValidDate(b.joiningDate)) return res.status(400).json({ message: 'Joining date is invalid' });
  if (b.email !== undefined) {
    if (typeof b.email !== 'string' || !EMAIL.test(b.email.trim())) {
      return res.status(400).json({ message: 'Official email is invalid' });
    }
    const email = b.email.trim().toLowerCase();
    if (db.users.some((user) => user.id !== u.id && user.email.toLowerCase() === email)) {
      return res.status(400).json({ message: 'A user with this email already exists' });
    }
    u.email = email;
  }
  ['fullName', 'phone', 'branch'].forEach((k) => { if (b[k] !== undefined) u[k] = b[k]; });
  if (b.joiningDate !== undefined) u.joiningDate = b.joiningDate || null;
  audit(req.user, 'EMPLOYEE_UPDATED', u.empCode, `${beforeBranch} → ${u.branch}${beforeEmail !== u.email ? '; official email updated' : ''}`, req.ip);
  res.json(withBank(u));
});

router.put('/employees/:id/bank', (req, res) => {
  const u = db.users.find((x) => x.id === req.params.id && x.role === 'employee');
  if (!u) return res.status(404).json({ message: 'Employee not found' });
  const bank = db.bank.find((x) => x.userId === u.id);
  if (!bank) return res.status(404).json({ message: 'Bank record not found' });

  const b = req.body || {};
  const required = [
    ['accountHolder', 'Account holder name'],
    ['bankName', 'Bank name'],
    ['accountNumber', 'Account number'],
    ['ifsc', 'IFSC code'],
  ];
  for (const [field, label] of required) {
    if (typeof b[field] !== 'string' || !b[field].trim()) {
      return res.status(400).json({ message: `${label} is required` });
    }
  }

  const accountNumber = b.accountNumber.trim();
  const ifsc = b.ifsc.trim().toUpperCase();
  if (!/^\d{9,18}$/.test(accountNumber)) {
    return res.status(400).json({ message: 'Account number must be 9–18 digits' });
  }
  if (!IFSC.test(ifsc)) return res.status(400).json({ message: 'IFSC code is invalid' });

  bank.accountHolder = b.accountHolder.trim();
  bank.bankName = b.bankName.trim();
  bank.accountNumber = accountNumber;
  bank.ifsc = ifsc;
  bank.status = 'Pending';
  bank.rejectReason = null;
  bank.verifiedAt = null;
  bank.verificationChecklist = [false, false, false];
  audit(req.user, 'BANK_DETAILS_UPDATED', u.empCode, 'Bank details updated; verification reset to pending', req.ip);
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
    return {
      userId: b.userId, accountHolder: b.accountHolder, bankName: b.bankName, accountNumber: b.accountNumber, ifsc: b.ifsc,
      status: b.status, rejectReason: b.rejectReason, verifiedAt: b.verifiedAt, verificationChecklist: b.verificationChecklist,
      employee: u ? { id: u.id, empCode: u.empCode, fullName: u.fullName, branch: u.branch } : null,
    };
  }).sort((a, b) => (a.status === 'Pending' ? -1 : 1)));
});

router.post('/bank/:userId/decision', (req, res) => {
  const b = db.bank.find((x) => x.userId === req.params.userId);
  const u = db.users.find((x) => x.id === req.params.userId);
  if (!b || !u) return res.status(404).json({ message: 'Bank record not found' });
  const { decision, reason } = req.body || {};
  if (decision === 'approve') {
    if (!isValidBankChecklist(req.body?.verificationChecklist) || !req.body.verificationChecklist.every(Boolean)) {
      return res.status(400).json({ message: 'Complete all bank detail checks before approval' });
    }
    b.verificationChecklist = req.body.verificationChecklist;
    b.status = 'Verified'; b.rejectReason = null; b.verifiedAt = new Date().toISOString();
  } else if (decision === 'reject') {
    if (typeof reason !== 'string' || !reason.trim()) return res.status(400).json({ message: 'A rejection reason is mandatory' });
    if (req.body.verificationChecklist !== undefined && !isValidBankChecklist(req.body.verificationChecklist)) {
      return res.status(400).json({ message: 'Bank detail checklist is invalid' });
    }
    if (req.body.verificationChecklist !== undefined) b.verificationChecklist = req.body.verificationChecklist;
    b.status = 'Rejected'; b.rejectReason = reason.trim();
    notify(u.id, `Your bank details were rejected: ${b.rejectReason}. Contact HR.`, '/employee/profile');
  } else return res.status(400).json({ message: 'Invalid decision' });
  audit(req.user, 'BANK_' + String(decision).toUpperCase(), u.empCode, reason || '', req.ip);
  res.json(b);
});

module.exports = router;
