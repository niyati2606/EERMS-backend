// Data store (in-memory, persisted to data/store.json). Mirrors database/schema.sql.
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const CATEGORIES = ['PLANE', 'TRAIN', 'ROAD', 'MEALS', 'HOTEL', 'SUPPLIES'];
const CATEGORY_LABELS = {
  PLANE: 'Transport - By Plane', TRAIN: 'Transport - By Train', ROAD: 'Transport - By Road (Ola/Uber/Rapido)',
  MEALS: 'Meals & Dining', HOTEL: 'Hotel Stays', SUPPLIES: 'Office Supplies',
};
const BRANCHES = ['Corporate HQ', 'Branch A', 'Branch B'];
const COST_CENTERS = {
  Engineering: ['Engineering - Software', 'Engineering - Infrastructure', 'Engineering - QA'],
  Operations: ['Operations - Facilities', 'Operations - Logistics', 'Operations - Admin'],
  Finance: ['Finance - Accounts', 'Finance - Payroll', 'Finance - Audit'],
  HR: ['HR - Recruitment', 'HR - L&D', 'HR - Compliance'],
  Sales: ['Sales - Domestic', 'Sales - International'],
  Marketing: ['Marketing - Digital', 'Marketing - Brand'],
};
const POLICY = { highValue: 25000, mealsPerDay: 1500, hotelPerNight: 4500, graceDays: 45, queueSlaHours: 72, lockMinutes: 15 };

const db = {
  users: [], bank: [], claims: [], notifications: [], audit: [],
  budget: { monthly: 200000, categories: { PLANE: 50000, TRAIN: 20000, ROAD: 15000, MEALS: 40000, HOTEL: 50000, SUPPLIES: 25000 } },
  seq: { claim: 0, batch: 0 },
};

const hash = (p) => bcrypt.hashSync(p, 8);
const DEFAULT_PASSWORD = 'Password@123';

function nextEmpCode() {
  const max = db.users.reduce((m, u) => Math.max(m, parseInt(u.empCode.split('-')[1], 10) || 0), 0);
  return 'EMP-' + String(max + 1).padStart(4, '0');
}
function nextTicket() {
  db.seq.claim += 1;
  return `EXP-${new Date().getFullYear()}-${String(db.seq.claim).padStart(4, '0')}`;
}
function addUser(u) {
  const user = {
    id: crypto.randomUUID(), empCode: u.empCode || nextEmpCode(), status: 'active', mustChange: false,
    phone: '', designation: '', joiningDate: '2024-01-15', costCenter: '', reportingManager: '', ...u,
  };
  db.users.push(user);
  return user;
}
function addBank(userId, b) {
  const rec = {
    userId, accountHolder: '', bankName: '', accountNumber: '', ifsc: '', chequeFileName: null, chequeFilePath: null,
    chequeFileSize: null, ctsAuditChecks: Array(3).fill(false), status: 'Pending', rejectReason: null, verifiedAt: null, ...b,
  };
  const i = db.bank.findIndex((x) => x.userId === userId);
  if (i >= 0) db.bank[i] = rec; else db.bank.push(rec);
  return rec;
}

// Tamper-evident (hash-chained) audit trail
function audit(actor, action, entity, detail, ip) {
  const prev = db.audit.length ? db.audit[db.audit.length - 1].hash : 'GENESIS';
  const entry = {
    seq: db.audit.length + 1, at: new Date().toISOString(), actorId: actor ? actor.id : null,
    actor: actor ? `${actor.fullName} (${actor.empCode})` : 'system', action, entity, detail: detail || '', ip: ip || '-', prev,
  };
  entry.hash = crypto.createHash('sha256').update(prev + JSON.stringify({ ...entry, hash: undefined })).digest('hex');
  db.audit.push(entry);
}
function verifyAuditChain() {
  let prev = 'GENESIS';
  for (const e of db.audit) {
    const { hash: h, ...rest } = e;
    const calc = crypto.createHash('sha256').update(prev + JSON.stringify({ ...rest, hash: undefined })).digest('hex');
    if (e.prev !== prev || calc !== h) return false;
    prev = h;
  }
  return true;
}
function notify(userId, message, link) {
  db.notifications.push({ id: crypto.randomUUID(), userId, message, link: link || null, read: false, at: new Date().toISOString() });
  // Simulated e-mail dispatch
  const u = db.users.find((x) => x.id === userId);
  if (u && process.env.NODE_ENV !== 'test') console.log(`[email → ${u.email}] ${message}`);
}
function notifyRole(role, message, link) {
  db.users.filter((u) => u.role === role && u.status === 'active').forEach((u) => notify(u.id, message, link));
}
const publicUser = (u) => {
  const { passwordHash, setupTokenHash, setupTokenExpiresAt, ...rest } = u;
  return rest;
};
const maskAcct = (n) => (n ? '••••••' + String(n).slice(-4) : '');

// ---------- Seed ----------
function seed() {
  const ph = hash(DEFAULT_PASSWORD);
  addUser({ empCode: 'EMP-0001', fullName: 'Meera Kapoor', email: 'admin@abcsolutions.com', passwordHash: ph, role: 'admin', department: 'Finance', branch: 'Corporate HQ', designation: 'CFO', costCenter: 'Finance - Accounts' });
  addUser({ empCode: 'EMP-0002', fullName: 'Priya Nair', email: 'hr@abcsolutions.com', passwordHash: ph, role: 'hr', department: 'HR', branch: 'Corporate HQ', designation: 'HR Administrator', costCenter: 'HR - Compliance' });
  addUser({ empCode: 'EMP-0003', fullName: 'Rahul Verma', email: 'finance@abcsolutions.com', passwordHash: ph, role: 'finance', department: 'Finance', branch: 'Corporate HQ', designation: 'Finance Officer', costCenter: 'Finance - Audit' });
  addUser({ empCode: 'EMP-0004', fullName: 'Sneha Iyer', email: 'finance2@abcsolutions.com', passwordHash: ph, role: 'finance', department: 'Finance', branch: 'Corporate HQ', designation: 'Finance Officer', costCenter: 'Finance - Accounts' });
  audit(null, 'SEED', 'system', 'Initial role accounts loaded');
}
// ---------- Persistence (JSON file) so data survives server restarts ----------
const fs = require('fs');
const path = require('path');
const BUNDLED_FILE = path.join(__dirname, 'data', 'store.json');
const FILE = process.env.DATA_FILE || (process.env.VERCEL ? path.join('/tmp', 'store.json') : BUNDLED_FILE);

function loadFromDisk() {
  try {
    if (process.env.VERCEL && !fs.existsSync(FILE) && fs.existsSync(BUNDLED_FILE)) {
      try {
        fs.copyFileSync(BUNDLED_FILE, FILE);
      } catch (err) {
        console.warn('Could not copy bundled store to /tmp:', err.message);
      }
    }
    const targetFile = fs.existsSync(FILE) ? FILE : (fs.existsSync(BUNDLED_FILE) ? BUNDLED_FILE : null);
    if (!targetFile) return false;
    const d = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
    ['users', 'bank', 'claims', 'notifications', 'audit'].forEach((k) => { db[k] = d[k] || []; });
    db.budget = d.budget || db.budget; db.seq = d.seq || db.seq;
    return db.users.length > 0;
  } catch { return false; }
}
let lastSaved = '';
function persist() {
  if (process.env.NODE_ENV === 'test') return;
  try {
    const out = JSON.stringify(db);
    if (out === lastSaved) return;
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE + '.tmp', out);
    fs.renameSync(FILE + '.tmp', FILE);
    lastSaved = out;
  } catch (e) { console.error('persist failed', e.message); }
}
if (!loadFromDisk()) { seed(); persist(); } else console.log(`Loaded saved data from ${FILE}`);
setInterval(persist, 2000).unref();
['SIGINT', 'SIGTERM'].forEach((sig) => process.on(sig, () => { persist(); process.exit(0); }));

module.exports = { db, CATEGORIES, CATEGORY_LABELS, BRANCHES, COST_CENTERS, POLICY, DEFAULT_PASSWORD, hash, addUser, addBank, nextEmpCode, nextTicket, audit, verifyAuditChain, notify, notifyRole, publicUser, maskAcct };
