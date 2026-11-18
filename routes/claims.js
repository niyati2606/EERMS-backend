const router = require('express').Router();
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { db, CATEGORIES, POLICY, nextTicket, audit, notifyRole, notify } = require('../store');
const { auth, role } = require('../middleware/auth');
const { receiptUpload, sha256File, removeFiles, ROOT } = require('../middleware/uploadMiddleware');
const { view, duplicateIndicators } = require('../claimUtil');

const PROVIDERS = ['Ola', 'Uber', 'Rapido'];
const mine = (req) => db.claims.filter((c) => c.employeeId === req.user.id);

// Claim submission is for the Employee role only.
router.use(auth, role('employee'));

router.get('/policy', (req, res) => res.json({ mileagePerKm: POLICY.mileagePerKm, gstRate: POLICY.gstRate }));

router.get('/', (req, res) => {
  res.json(mine(req).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).map((c) => view(c, { withEmployee: false })));
});

router.get('/:id', (req, res) => {
  const c = mine(req).find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ message: 'Claim not found' });
  res.json(view(c, { withEmployee: false }));
});

function validateLines(lines) {
  const errors = [];
  if (!lines.length) errors.push('Add at least one expense line');
  lines.forEach((l, i) => {
    const n = `Line ${i + 1}`;
    if (!l.date) errors.push(`${n}: date is required`);
    else if (new Date(l.date) > new Date()) errors.push(`${n}: date cannot be in the future`);
    if (!CATEGORIES.includes(l.category)) errors.push(`${n}: choose a category`);
    if (!(l.amount > 0)) errors.push(`${n}: amount must be greater than ₹0`);
    if (!l.reason || !String(l.reason).trim()) errors.push(`${n}: business reason is required`);
    if (l.category === 'ROAD') {
      if (!PROVIDERS.includes(l.provider)) errors.push(`${n}: road travel must be Ola, Uber or Rapido`);
      if (!l.bookingId || !String(l.bookingId).trim()) errors.push(`${n}: ride Booking ID is required`);
      if (!Number.isFinite(Number(l.distanceKm)) || Number(l.distanceKm) <= 0) errors.push(`${n}: distance in kilometres is required`);
    }
    if (!l.receipt) errors.push(`${n}: a receipt (PDF/JPG/PNG < 200 KB) is mandatory`);
  });
  return errors;
}

function save(req, res, existing) {
  const files = req.files || [];
  const bail = (code, message, errors) => { removeFiles(files); return res.status(code).json({ message, errors }); };
  let payload;
  try { payload = JSON.parse(req.body.payload || '{}'); } catch { return bail(400, 'Invalid claim payload'); }
  if (existing && !['DRAFT', 'INFO_REQUESTED'].includes(existing.status)) return bail(409, 'This claim can no longer be edited');

  const old = new Map((existing ? existing.lines : []).map((l) => [l.id, l]));
  const lines = (payload.lines || []).map((l, i) => {
    const f = files.find((x) => x.fieldname === `receipt_${i}`);
    let receipt = null;
    if (f) receipt = { name: f.originalname, file: f.filename, size: f.size, mime: f.mimetype, hash: sha256File(f.path) };
    else if (l.id && old.get(l.id) && old.get(l.id).receipt) receipt = old.get(l.id).receipt;
    return {
      id: l.id && old.has(l.id) ? l.id : crypto.randomUUID(), date: l.date, category: l.category, amount: Number(l.amount) || 0,
      reason: l.reason || '', provider: l.category === 'ROAD' ? l.provider || null : null,
      bookingId: l.category === 'ROAD' ? l.bookingId || null : null,
      distanceKm: l.category === 'ROAD' && l.distanceKm ? Number(l.distanceKm) : null, receipt,
    };
  });
  const submit = !!payload.submit;
  if (submit) {
    const errors = validateLines(lines);
    if (errors.length) return bail(400, 'Please fix the highlighted issues', errors);
  }
  const now = new Date().toISOString();
  const total = lines.reduce((s, l) => s + l.amount, 0);
  let claim = existing;
  if (!claim) {
    claim = { id: crypto.randomUUID(), ticketRef: null, employeeId: req.user.id, status: 'DRAFT', createdAt: now, history: [], lockedBy: null, lockExpires: null, decisionNote: null, utr: null, paidAt: null, approvedAt: null, batchId: null };
    db.claims.push(claim);
  }
  claim.title = (payload.title || 'Expense claim').slice(0, 120);
  claim.lines = lines; claim.total = total;
  if (submit) {
    const resub = claim.status === 'INFO_REQUESTED';
    if (!claim.ticketRef) claim.ticketRef = nextTicket();
    claim.status = 'SUBMITTED'; claim.submittedAt = now; claim.lockedBy = null; claim.lockExpires = null;
    claim.slaEscalatedAt = null;
    claim.lines = duplicateIndicators(claim);
    claim.history.push({ at: now, status: 'SUBMITTED', by: req.user.fullName, note: resub ? 'Resubmitted after info request' : 'Claim submitted' });
    audit(req.user, resub ? 'CLAIM_RESUBMITTED' : 'CLAIM_SUBMITTED', claim.ticketRef, `₹${total}`, req.ip);
    notifyRole('finance', `${req.user.fullName} ${resub ? 'resubmitted' : 'submitted'} ${claim.ticketRef} (₹${total.toLocaleString('en-IN')}) — new in the Shared Queue`, `/finance/review/${claim.id}`);
  } else {
    audit(req.user, 'CLAIM_DRAFT_SAVED', claim.id, `₹${total}`, req.ip);
  }
  res.status(existing ? 200 : 201).json(view(claim, { withEmployee: false }));
}

router.post('/', receiptUpload.any(), (req, res) => save(req, res, null));
router.put('/:id', receiptUpload.any(), (req, res) => {
  const c = mine(req).find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ message: 'Claim not found' });
  save(req, res, c);
});

router.delete('/:id', (req, res) => {
  const i = db.claims.findIndex((c) => c.id === req.params.id && c.employeeId === req.user.id && c.status === 'DRAFT');
  if (i < 0) return res.status(404).json({ message: 'Only your drafts can be deleted' });
  db.claims.splice(i, 1);
  res.json({ message: 'Draft deleted' });
});

module.exports = router;
module.exports.receiptFileHandler = (req, res) => {
  const file = path.basename(req.params.file);
  const claim = db.claims.find((c) => c.lines.some((l) => l.receipt && l.receipt.file === file));
  if (!claim) return res.status(404).json({ message: 'Receipt not found' });
  const ok = claim.employeeId === req.user.id || ['finance', 'admin'].includes(req.user.role);
  if (!ok) return res.status(403).json({ message: 'Not allowed' });
  const p1 = path.join(ROOT, 'receipts', file);
  const p2 = path.join(__dirname, '..', 'uploads', 'receipts', file);
  const p = fs.existsSync(p1) ? p1 : (fs.existsSync(p2) ? p2 : null);
  if (!p) return res.status(404).json({ message: 'File missing' });
  res.sendFile(p);
};
