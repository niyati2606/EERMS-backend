const router = require('express').Router();
const { db, POLICY, BRANCHES, audit, notify } = require('../store');
const { auth, role } = require('../middleware/auth');
const { view, normalizeLock, businessHoursBetween } = require('../claimUtil');

const hasOnlyLettersAndSpaces = (value) => /^[\p{L} ]*$/u.test(value);

router.use(auth, role('finance'));

const find = (id) => db.claims.find((c) => c.id === id);
const lockValid = (c, uid) => normalizeLock(c) && c.lockedBy === uid && new Date(c.lockExpires) > new Date();

// Shared Work Queue — oldest first (FR-05), search by ticket ref / employee ID (FR-09)
router.get('/queue', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  let list = db.claims.filter((c) => ['SUBMITTED', 'UNDER_REVIEW'].includes(normalizeLock(c).status));
  list = list.map((c) => view(c));
  if (q) list = list.filter((c) => String(c.ticketRef || '').toLowerCase().includes(q)
    || String(c.employee.empCode || '').toLowerCase().includes(q)
    || String(c.employee.fullName || '').toLowerCase().includes(q)
    || String(c.employee.id || '').toLowerCase().includes(q));
  list.sort((a, b) => new Date(a.submittedAt) - new Date(b.submittedAt));
  res.json(list);
});

router.get('/stats', (req, res) => {
  const all = db.claims.map(normalizeLock);
  const queue = all.filter((c) => ['SUBMITTED', 'UNDER_REVIEW'].includes(c.status));
  res.json({
    inQueue: queue.filter((c) => c.status === 'SUBMITTED').length,
    myLocked: queue.filter((c) => c.lockedBy === req.user.id).length,
    aged: queue.filter((c) => c.status === 'SUBMITTED' && !c.lockedBy && businessHoursBetween(c.submittedAt) > POLICY.queueSlaHours).length,
    highValue: queue.filter((c) => c.total > POLICY.highValue).length,
    toPay: all.filter((c) => c.status === 'APPROVED').length,
    paid: all.filter((c) => c.status === 'PAID').length,
    infoRequested: all.filter((c) => c.status === 'INFO_REQUESTED').length,
  });
});

router.get('/history', (req, res) => {
  const statuses = ['APPROVED', 'REJECTED'];
  const status = String(req.query.status || 'ALL').trim().toUpperCase();
  if (status !== 'ALL' && !statuses.includes(status)) {
    return res.status(400).json({ message: 'Invalid claim status filter' });
  }
  const month = String(req.query.month || new Date().toISOString().slice(0, 7)).trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return res.status(400).json({ message: 'Month filter must use YYYY-MM format' });
  }
  const branches = [...new Set([
    ...BRANCHES,
    ...db.users
      .filter((user) => user.role === 'employee' && user.branch)
      .map((user) => String(user.branch).trim())
      .filter(Boolean),
  ])];
  const branch = String(req.query.branch || 'ALL').trim();
  if (branch !== 'ALL' && !branches.includes(branch)) {
    return res.status(400).json({ message: 'Invalid branch filter' });
  }
  const q = String(req.query.q || '').trim().toLowerCase();
  const list = db.claims
    .filter((claim) => statuses.includes(normalizeLock(claim).status))
    .map((claim) => {
      const employee = db.users.find((user) => user.id === claim.employeeId);
      return {
        id: claim.id,
        ticketRef: claim.ticketRef,
        title: claim.title,
        status: claim.status,
        createdAt: claim.createdAt,
        submittedAt: claim.submittedAt,
        approvedAt: claim.approvedAt,
        paidAt: claim.paidAt,
        total: claim.total,
        decisionNote: claim.decisionNote || (claim.history || []).slice().reverse().find((entry) => entry.status === claim.status)?.note || null,
        employee: {
          fullName: employee?.fullName || 'Employee record unavailable',
          empCode: employee?.empCode || '—',
          branch: employee?.branch || '—',
        },
      };
    })
    .filter((claim) => (status === 'ALL' || claim.status === status)
      && (branch === 'ALL' || claim.employee.branch === branch)
      && String(claim.submittedAt || claim.createdAt || '').slice(0, 7) === month
      && (!q || [claim.ticketRef, claim.title, claim.employee.fullName, claim.employee.empCode, claim.employee.branch, claim.id]
        .some((value) => String(value || '').toLowerCase().includes(q))))
    .sort((a, b) => new Date(b.submittedAt || b.createdAt) - new Date(a.submittedAt || a.createdAt));
  res.json({ claims: list, branches });
});

router.get('/claims/:id', (req, res) => {
  const c = find(req.params.id);
  if (!c || c.status === 'DRAFT') return res.status(404).json({ message: 'Claim not found' });
  res.json(view(c));
});

// [Assign to Me] — one-hour lease lock. Node is single-threaded so check+set is atomic;
// with PostgreSQL this maps to: UPDATE ... WHERE (locked_by IS NULL OR lock_expires < now()) RETURNING *.
router.post('/claims/:id/assign', (req, res) => {
  const c = find(req.params.id);
  if (!c) return res.status(404).json({ message: 'Claim not found' });
  normalizeLock(c);
  if (c.employeeId === req.user.id) return res.status(403).json({ message: 'You cannot audit your own claim. A peer officer must lock it.' });
  if (!['SUBMITTED', 'UNDER_REVIEW'].includes(c.status)) return res.status(409).json({ message: `Claim is ${c.status} and cannot be assigned` });
  if (c.lockedBy && c.lockedBy !== req.user.id) {
    const o = db.users.find((u) => u.id === c.lockedBy);
    return res.status(409).json({ message: `Already locked by ${o ? o.fullName : 'another officer'} until ${new Date(c.lockExpires).toLocaleTimeString('en-IN')}` });
  }
  c.lockedBy = req.user.id;
  c.lockExpires = new Date(Date.now() + POLICY.lockMinutes * 60000).toISOString();
  if (c.status === 'SUBMITTED') {
    c.status = 'UNDER_REVIEW';
    c.history.push({ at: new Date().toISOString(), status: 'UNDER_REVIEW', by: req.user.fullName, note: 'Assigned for audit' });
    notify(c.employeeId, `${c.ticketRef} is now under review`, `/employee/claims/${c.id}`);
  }
  audit(req.user, 'CLAIM_LOCKED', c.ticketRef, `until ${c.lockExpires}`, req.ip);
  res.json(view(c));
});

router.post('/claims/:id/release', (req, res) => {
  const c = find(req.params.id);
  if (!c) return res.status(404).json({ message: 'Claim not found' });
  if (!lockValid(c, req.user.id)) return res.status(403).json({ message: 'You do not hold an active lock' });
  const note = String(req.body?.note || '').trim();
  if (!note) return res.status(400).json({ message: 'A handoff remark is required to release this claim' });
  if (!hasOnlyLettersAndSpaces(note)) return res.status(400).json({ message: 'Handoff remarks can contain letters and spaces only' });
  if (note.length > 500) return res.status(400).json({ message: 'Handoff remark must be 500 characters or fewer' });
  const now = new Date().toISOString();
  c.lockedBy = null; c.lockExpires = null;
  if (c.status === 'UNDER_REVIEW') c.status = 'SUBMITTED';
  c.slaEscalatedAt = null;
  c.history.push({ at: now, status: c.status, by: req.user.fullName, note: `Released for handoff: ${note}` });
  audit(req.user, 'CLAIM_RELEASED', c.ticketRef, note, req.ip);
  res.json(view(c));
});

// 3-way decision gateway (FR-07)
router.post('/claims/:id/decision', (req, res) => {
  const c = find(req.params.id);
  if (!c) return res.status(404).json({ message: 'Claim not found' });
  if (c.employeeId === req.user.id) return res.status(403).json({ message: 'You cannot approve your own claim' });
  if (!lockValid(c, req.user.id)) return res.status(409).json({ message: 'Your one-hour lock has expired or is not held. Click [Assign to Me] again.' });
  const { decision, note } = req.body || {};
  const decisionNote = typeof note === 'string' ? note.trim() : '';
  if (!['approve', 'info', 'reject'].includes(decision)) return res.status(400).json({ message: 'Invalid decision' });
  if (decision !== 'approve' && !decisionNote) return res.status(400).json({ message: 'A written note is mandatory for Request Info / Reject' });
  if (!hasOnlyLettersAndSpaces(decisionNote)) return res.status(400).json({ message: 'Decision notes can contain letters and spaces only' });
  if (decisionNote.length > 500) return res.status(400).json({ message: 'Decision notes must be 500 characters or fewer' });
  const now = new Date().toISOString();
  const map = { approve: 'APPROVED', info: 'INFO_REQUESTED', reject: 'REJECTED' };
  c.status = map[decision]; c.decisionNote = decisionNote || null; c.lockedBy = null; c.lockExpires = null;
  if (decision === 'approve') c.approvedAt = now;
  c.history.push({ at: now, status: c.status, by: req.user.fullName, note: c.decisionNote || 'Approved for disbursement' });
  audit(req.user, 'CLAIM_' + c.status, c.ticketRef, c.decisionNote || '', req.ip);
  notify(c.employeeId, `${c.ticketRef}: ${c.status.replace('_', ' ')}${c.decisionNote ? ' — ' + c.decisionNote : ''}`, `/employee/claims/${c.id}`);
  res.json(view(c));
});

// Settlement
router.get('/payable', (req, res) => {
  res.json(db.claims.filter((c) => c.status === 'APPROVED').sort((a, b) => new Date(a.approvedAt) - new Date(b.approvedAt)).map((c) => view(c)));
});
router.get('/paid', (req, res) => {
  res.json(db.claims.filter((c) => c.status === 'PAID').sort((a, b) => new Date(b.paidAt) - new Date(a.paidAt)).map((c) => view(c)));
});

const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
router.post('/export', (req, res) => {
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : null;
  let list = db.claims.filter((c) => c.status === 'APPROVED' && (!ids || ids.includes(c.id)));
  const skipped = [];
  const ok = list.filter((c) => {
    const u = db.users.find((x) => x.id === c.employeeId);
    const b = db.bank.find((x) => x.userId === c.employeeId);
    if (!u || u.status !== 'active') { skipped.push({ ticketRef: c.ticketRef, reason: 'Employee account is frozen' }); return false; }
    if (!b || b.status !== 'Verified') { skipped.push({ ticketRef: c.ticketRef, reason: 'Bank details not verified by HR' }); return false; }
    return true;
  });
  if (!ok.length) return res.status(400).json({ message: 'No payable claims with verified bank details', skipped });
  db.seq.batch += 1;
  const batchId = `BATCH-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(db.seq.batch).padStart(3, '0')}`;
  const rows = [['BatchId', 'TicketRef', 'EmpCode', 'BeneficiaryName', 'BankName', 'AccountNumber', 'IFSC', 'Amount_INR', 'Narration'].join(',')];
  ok.forEach((c) => {
    const u = db.users.find((x) => x.id === c.employeeId);
    const b = db.bank.find((x) => x.userId === c.employeeId);
    c.batchId = batchId;
    rows.push([batchId, c.ticketRef, u.empCode, esc(b.accountHolder), esc(b.bankName), esc(b.accountNumber), b.ifsc, c.total.toFixed(2), esc('EERMS ' + c.ticketRef)].join(','));
  });
  audit(req.user, 'EFT_EXPORT', batchId, `${ok.length} claims`, req.ip);
  res.json({ batchId, count: ok.length, total: ok.reduce((s, c) => s + c.total, 0), csv: rows.join('\n'), skipped });
});

// Mark PAID with bank UTR
router.post('/claims/:id/pay', (req, res) => {
  const c = find(req.params.id);
  if (!c) return res.status(404).json({ message: 'Claim not found' });
  if (c.status !== 'APPROVED') return res.status(409).json({ message: 'Only APPROVED claims can be marked PAID' });
  if (c.employeeId === req.user.id) return res.status(403).json({ message: 'You cannot disburse your own claim' });
  const utr = String((req.body && req.body.utr) || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{8,22}$/.test(utr)) return res.status(400).json({ message: 'Enter a valid bank UTR / reference (8–22 letters or digits)' });
  const u = db.users.find((x) => x.id === c.employeeId);
  const b = db.bank.find((x) => x.userId === c.employeeId);
  if (!u || u.status !== 'active') return res.status(409).json({ message: 'Payout blocked: employee account is frozen' });
  if (!b || b.status !== 'Verified') return res.status(409).json({ message: 'Payout blocked: bank details are not verified' });
  c.status = 'PAID'; c.utr = utr; c.paidAt = new Date().toISOString();
  c.history.push({ at: c.paidAt, status: 'PAID', by: req.user.fullName, note: `Paid. UTR ${utr}` });
  audit(req.user, 'CLAIM_PAID', c.ticketRef, `UTR ${utr}`, req.ip);
  notify(c.employeeId, `${c.ticketRef} paid — ₹${c.total.toLocaleString('en-IN')} credited. UTR ${utr}`, `/employee/claims/${c.id}`);
  res.json(view(c));
});

module.exports = router;
