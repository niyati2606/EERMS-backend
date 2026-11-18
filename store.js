// Data store (in-memory, persisted to data/store.json). Mirrors database/schema.sql.
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const CATEGORIES = ['PLANE', 'TRAIN', 'ROAD', 'MEALS', 'HOTEL', 'SUPPLIES'];
const CATEGORY_LABELS = {
  PLANE: 'Transport - By Plane', TRAIN: 'Transport - By Train', ROAD: 'Transport - By Road (Ola/Uber/Rapido)',
  MEALS: 'Meals & Dining', HOTEL: 'Hotel Stays', SUPPLIES: 'Office Supplies',
};
const BRANCHES = ['Corporate HQ', 'Branch A', 'Branch B'];
const POLICY = { highValue: 25000, mealsPerDay: 1500, hotelPerNight: 4500, graceDays: 45, queueSlaHours: 72, businessStartHour: 9, businessEndHour: 17, gstRate: 0, mileagePerKm: 50, lockMinutes: 60 };
const REMOVED_USER_FIELDS = ['designation', 'department', 'costCenter', 'reportingManager'];
const REMOVED_BANK_FIELDS = ['chequeFileName', 'chequeFilePath', 'chequeFileSize', 'ctsAuditChecks'];

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
    phone: '', ...u,
  };
  REMOVED_USER_FIELDS.forEach((field) => { delete user[field]; });
  if (!user.passwordHash) user.status = 'pending';
  db.users.push(user);
  return user;
}
function addBank(userId, b) {
  const rec = {
    userId, accountHolder: '', bankName: '', accountNumber: '', ifsc: '', status: 'Pending', rejectReason: null, verifiedAt: null,
    verificationChecklist: [false, false, false], ...b,
  };
  REMOVED_BANK_FIELDS.forEach((field) => { delete rec[field]; });
  if (!Array.isArray(rec.verificationChecklist) || rec.verificationChecklist.length !== 3 || ![0, 1, 2].every((index) => typeof rec.verificationChecklist[index] === 'boolean')) {
    rec.verificationChecklist = [false, false, false];
  }
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
  const { passwordHash, setupTokenHash, setupTokenExpiresAt, passwordResetTokenHash, passwordResetTokenExpiresAt, ...rest } = u;
  return rest;
};
const maskAcct = (n) => (n ? '••••••' + String(n).slice(-4) : '');

// ---------- Seed ----------
function seed() {
  const ph = hash(DEFAULT_PASSWORD);
  addUser({ empCode: 'EMP-0001', fullName: 'Meera Kapoor', email: 'admin@abcsolutions.com', passwordHash: ph, role: 'admin', branch: 'Corporate HQ' });
  addUser({ empCode: 'EMP-0002', fullName: 'Priya Nair', email: 'hr@abcsolutions.com', passwordHash: ph, role: 'hr', branch: 'Corporate HQ' });
  addUser({ empCode: 'EMP-0003', fullName: 'Rahul Verma', email: 'finance@abcsolutions.com', passwordHash: ph, role: 'finance', branch: 'Corporate HQ' });
  addUser({ empCode: 'EMP-0004', fullName: 'Sneha Iyer', email: 'finance2@abcsolutions.com', passwordHash: ph, role: 'finance', branch: 'Corporate HQ' });
  audit(null, 'SEED', 'system', 'Initial role accounts loaded');
}
// ---------- Persistence (PostgreSQL in production, JSON file locally) ----------
const fs = require('fs');
const path = require('path');
const BUNDLED_FILE = path.join(__dirname, 'data', 'store.json');
const FILE = process.env.DATA_FILE || (process.env.VERCEL ? path.join('/tmp', 'store.json') : BUNDLED_FILE);
const DATABASE_URL =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.STORAGE_URL ||
  process.env.STORAGE_DATABASE_URL ||
  process.env.STORAGE_POSTGRES_URL ||
  process.env.DB_URL ||
  process.env.POSTGRES_URL_NON_POOLING ||
  process.env.POSTGRES_PRISMA_URL;
let pgPool = null;
let initializationPromise = null;

if (DATABASE_URL) {
  const { Pool } = require('pg');
  pgPool = new Pool({
    connectionString: DATABASE_URL,
    ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 10000,
    max: 1,
  });
  console.log('PostgreSQL database pool configured.');
}

let lastLoadedTime = '';
let lastLoadedRevision = '';
let lastSaved = '';

// ---------- Receipt file storage in PostgreSQL ----------
async function ensureReceiptTable(queryable = pgPool) {
  if (!queryable) return;
  await queryable.query(`
    CREATE TABLE IF NOT EXISTS eerms_receipt_files (
      filename TEXT PRIMARY KEY,
      file_data BYTEA NOT NULL,
      content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
      original_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function saveReceiptFile(filename, buffer, contentType, originalName, queryable = pgPool) {
  if (!queryable) return;
  await ensureReceiptTable(queryable);
  await queryable.query(`
    INSERT INTO eerms_receipt_files (filename, file_data, content_type, original_name)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (filename) DO UPDATE SET file_data = EXCLUDED.file_data, content_type = EXCLUDED.content_type
  `, [filename, buffer, contentType, originalName || filename]);
}

async function getReceiptFile(filename, queryable = pgPool) {
  if (!queryable) return null;
  await ensureReceiptTable(queryable);
  const result = await queryable.query('SELECT file_data, content_type, original_name FROM eerms_receipt_files WHERE filename = $1', [filename]);
  if (result.rows.length === 0) return null;
  return result.rows[0];
}

function hasPersistentStorage() {
  return Boolean(pgPool);
}

async function loadFromPostgres(queryable = pgPool) {
  if (!queryable) return false;
  await queryable.query(`
    CREATE TABLE IF NOT EXISTS eerms_store (
      id SMALLINT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  const result = await queryable.query('SELECT data, updated_at::text AS updated_at, xmin::text AS revision FROM eerms_store WHERE id = 1');
  if (result.rows.length === 0) return false;
  const d = result.rows[0].data;
  ['users', 'bank', 'claims', 'notifications', 'audit'].forEach((k) => { db[k] = d[k] || []; });
  db.users.forEach((user) => {
    if (!user.passwordHash) user.status = 'pending';
    REMOVED_USER_FIELDS.forEach((field) => { delete user[field]; });
  });
  db.bank.forEach((bank) => {
    REMOVED_BANK_FIELDS.forEach((field) => { delete bank[field]; });
    if (!Array.isArray(bank.verificationChecklist) || bank.verificationChecklist.length !== 3 ||
      ![0, 1, 2].every((index) => typeof bank.verificationChecklist[index] === 'boolean')) {
      bank.verificationChecklist = [false, false, false];
    }
  });
  db.budget = d.budget || db.budget;
  db.seq = d.seq || db.seq;
  lastLoadedTime = result.rows[0].updated_at || '';
  lastLoadedRevision = result.rows[0].revision || '';
  lastSaved = JSON.stringify(db);
  return db.users.length > 0;
}

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
    db.users.forEach((user) => {
      if (!user.passwordHash) user.status = 'pending';
      REMOVED_USER_FIELDS.forEach((field) => { delete user[field]; });
    });
    db.bank.forEach((bank) => {
      REMOVED_BANK_FIELDS.forEach((field) => { delete bank[field]; });
      if (!Array.isArray(bank.verificationChecklist) || bank.verificationChecklist.length !== 3 || ![0, 1, 2].every((index) => typeof bank.verificationChecklist[index] === 'boolean')) {
        bank.verificationChecklist = [false, false, false];
      }
    });
    db.budget = d.budget || db.budget; db.seq = d.seq || db.seq;
    return db.users.length > 0;
  } catch { return false; }
}
async function persist(queryable = null) {
  if (process.env.NODE_ENV === 'test') return;
  const out = JSON.stringify(db);
  if (out === lastSaved) return;

  if (pgPool) {
    try {
      const executor = queryable || pgPool;
      const res = await executor.query(`
        INSERT INTO eerms_store (id, data, updated_at)
        VALUES (1, $1::jsonb, now())
        ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at
        RETURNING updated_at::text AS updated_at, xmin::text AS revision
      `, [out]);
      lastSaved = out;
      if (res.rows[0]?.updated_at) lastLoadedTime = res.rows[0].updated_at;
      if (res.rows[0]?.revision) lastLoadedRevision = res.rows[0].revision;
    } catch (e) {
      console.error('PostgreSQL persist failed:', e.message);
      throw e;
    }
    return;
  }

  if (process.env.VERCEL) throw new Error('Persistent PostgreSQL storage is required on Vercel.');
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE + '.tmp', out);
    fs.renameSync(FILE + '.tmp', FILE);
    lastSaved = out;
  } catch (e) {
    console.error('persist failed', e.message);
    throw e;
  }
}

async function syncStore() {
  await initializeStore();
  if (pgPool) {
    try {
      const res = await pgPool.query('SELECT updated_at::text AS updated_at, xmin::text AS revision FROM eerms_store WHERE id = 1');
      if (res.rows.length > 0) {
        const dbTime = res.rows[0].updated_at || '';
        const revision = res.rows[0].revision || '';
        if (dbTime !== lastLoadedTime || revision !== lastLoadedRevision) await loadFromPostgres();
      }
    } catch (err) {
      console.warn('Sync check failed:', err.message);
      throw err;
    }
  }
}

const STORE_LOCK_A = 1162101325;
const STORE_LOCK_B = 1398038354;
const STORE_LOCK = `SELECT pg_advisory_lock(${STORE_LOCK_A}, ${STORE_LOCK_B})`;
const STORE_UNLOCK = `SELECT pg_advisory_unlock(${STORE_LOCK_A}, ${STORE_LOCK_B}) AS unlocked`;

async function endStoreWrite(client) {
  try {
    const result = await client.query(STORE_UNLOCK);
    if (!result.rows[0]?.unlocked) throw new Error('PostgreSQL store lock was not held.');
    client.release();
  } catch (error) {
    client.release(true);
    throw error;
  }
}

async function beginStoreWrite() {
  await initializeStore();
  if (!pgPool) {
    if (process.env.VERCEL) throw new Error('Persistent PostgreSQL storage is required on Vercel.');
    return null;
  }

  const client = await pgPool.connect();
  let locked = false;
  try {
    await client.query(STORE_LOCK);
    locked = true;
    if (!await loadFromPostgres(client)) {
      throw new Error('Persistent application data is missing from PostgreSQL.');
    }
    return client;
  } catch (error) {
    if (locked) {
      try {
        await endStoreWrite(client);
      } catch (releaseError) {
        console.error('Could not release PostgreSQL store lock:', releaseError.message);
      }
    } else {
      client.release();
    }
    throw error;
  }
}

async function initializeStore() {
  if (!initializationPromise) {
    initializationPromise = (async () => {
      if (process.env.VERCEL && !pgPool) {
        throw new Error('Persistent PostgreSQL storage is required on Vercel.');
      }
      let loaded = false;
      if (pgPool) {
        try {
          loaded = await loadFromPostgres();
          console.log(loaded ? 'Loaded saved data from PostgreSQL' : 'Initialized PostgreSQL store');
        } catch (e) {
          console.error('PostgreSQL load failed:', e.message);
          if (process.env.VERCEL) throw e;
          pgPool = null;
        }
      }
      if (process.env.VERCEL && !pgPool) {
        throw new Error('Persistent PostgreSQL storage is required on Vercel.');
      }
      if (!loaded) loaded = loadFromDisk();
      if (!loaded) seed();
      try {
        await persist();
      } catch (err) {
        console.warn('Initial persist failed:', err.message);
        if (pgPool || process.env.VERCEL) throw err;
      }
      if (!pgPool) setInterval(() => persist().catch((err) => console.error('Scheduled persist failed:', err.message)), 2000).unref();
      ['SIGINT', 'SIGTERM'].forEach((sig) => process.on(sig, () => {
        persist().catch((err) => console.error('Shutdown persist failed:', err.message)).finally(() => process.exit(0));
      }));
    })().catch((err) => {
      initializationPromise = null;
      throw err;
    });
  }
  return initializationPromise;
}

function getPersistenceType() {
  return pgPool ? 'postgresql' : 'json-file';
}

module.exports = { db, CATEGORIES, CATEGORY_LABELS, BRANCHES, POLICY, DEFAULT_PASSWORD, hash, addUser, addBank, nextEmpCode, nextTicket, audit, verifyAuditChain, notify, notifyRole, publicUser, maskAcct, initializeStore, getPersistenceType, syncStore, persist, beginStoreWrite, endStoreWrite, saveReceiptFile, getReceiptFile, hasPersistentStorage };
