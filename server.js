require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { db, POLICY, notify, syncStore, persist, beginStoreWrite, endStoreWrite, getPersistenceType } = require('./store');
const { auth } = require('./middleware/auth');
const { uploadErrors } = require('./middleware/uploadMiddleware');
const claims = require('./routes/claims');
const { businessHoursBetween, normalizeLock } = require('./claimUtil');

const app = express();
app.use(helmet({ crossOriginResourcePolicy: false }));

const allowedOrigin = process.env.CLIENT_ORIGIN;
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (
      origin.includes('localhost') ||
      origin.endsWith('.vercel.app') ||
      (allowedOrigin && origin === allowedOrigin)
    ) {
      return callback(null, true);
    }
    return callback(null, true);
  },
  credentials: true,
}));

app.use(express.json({ limit: '1mb' }));
app.use('/api/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 50, standardHeaders: true, legacyHeaders: false }));
app.use('/api/auth/request-password-reset', rateLimit({ windowMs: 15 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false }));

app.use(async (req, res, next) => {
  const isWrite = ['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method);
  let storeClient = null;
  try {
    if (isWrite) storeClient = await beginStoreWrite();
    else await syncStore();
  } catch (error) {
    console.error('Store sync failed:', error);
    return res.status(503).json({ message: 'Application storage is unavailable. Please retry.' });
  }

  req.storeClient = storeClient;
  const originalJson = res.json.bind(res);
  const originalSend = res.send.bind(res);
  let finalized = false;

  const finalizeWrite = async () => {
    if (finalized) return;
    finalized = true;
    if (!isWrite) return;
    try {
      await persist(storeClient);
    } finally {
      if (storeClient) {
        const client = storeClient;
        storeClient = null;
        try {
          await endStoreWrite(client);
        } catch (error) {
          console.error('Could not release PostgreSQL store lock:', error);
        }
      }
    }
  };

  res.json = async function (data) {
    try {
      await finalizeWrite();
    } catch (error) {
      console.error('Auto-persist failed:', error);
      res.statusCode = 503;
      return originalJson({ message: 'Could not save application data. Please retry.' });
    }
    return originalJson(data);
  };
  res.send = async function (data) {
    try {
      await finalizeWrite();
    } catch (error) {
      console.error('Auto-persist failed:', error);
      res.statusCode = 503;
      return originalJson({ message: 'Could not save application data. Please retry.' });
    }
    return originalSend(data);
  };
  res.on('close', () => {
    if (isWrite && !finalized) finalizeWrite().catch((error) => console.error('Could not finalize store write:', error));
  });

  next();
});

app.get(['/', '/api'], (req, res) => res.json({ ok: true, service: 'EERMS API', status: 'running' }));
app.get(['/api/health', '/health'], (req, res) => res.json({ ok: true, store: getPersistenceType() }));
app.use(['/api/auth', '/auth'], require('./routes/auth'));
app.use(['/api/employee', '/employee'], require('./routes/employee'));
app.use(['/api/claims', '/claims'], claims);
app.use(['/api/finance', '/finance'], require('./routes/finance'));
app.use(['/api/hr', '/hr'], require('./routes/hr'));
app.use(['/api/admin', '/admin'], require('./routes/admin'));
app.get(['/api/files/receipts/:file', '/files/receipts/:file'], auth, claims.receiptFileHandler);

app.get(['/api/notifications', '/notifications'], auth, (req, res) => {
  const list = db.notifications.filter((n) => n.userId === req.user.id).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 30);
  res.json({ unread: list.filter((n) => !n.read).length, items: list });
});
app.post(['/api/notifications/read', '/notifications/read'], auth, (req, res) => {
  db.notifications.filter((n) => n.userId === req.user.id).forEach((n) => { n.read = true; });
  res.json({ ok: true });
});

app.use(uploadErrors);
app.use((req, res) => res.status(404).json({ message: 'Not found' }));
app.use((err, req, res, next) => { // eslint-disable-line
  console.error(err);
  res.status(500).json({ message: 'Unexpected server error' });
});

const PORT = process.env.PORT || 5000;

async function escalateAgedClaims() {
  const storeClient = await beginStoreWrite();
  try {
    const now = Date.now();
    const recipients = db.users.filter((user) => user.role === 'finance' && user.status === 'active');
    if (!recipients.length) return;
    const aged = db.claims.filter((claim) => {
      normalizeLock(claim);
      return claim.status === 'SUBMITTED' && !claim.lockedBy && !claim.slaEscalatedAt
        && businessHoursBetween(claim.submittedAt, now) > POLICY.queueSlaHours;
    });
    if (!aged.length) {
      await persist(storeClient);
      return;
    }
    const refs = aged.map((claim) => claim.ticketRef).filter(Boolean);
    const shown = refs.slice(0, 5).join(', ');
    const extra = refs.length > 5 ? `, and ${refs.length - 5} more` : '';
    const message = `SLA escalation digest: ${aged.length} unassigned claim(s) exceeded ${POLICY.queueSlaHours} business hours (${shown}${extra}).`;
    const at = new Date(now).toISOString();
    aged.forEach((claim) => { claim.slaEscalatedAt = at; });
    recipients.forEach((user) => notify(user.id, message, '/finance/dashboard'));
    await persist(storeClient);
  } finally {
    if (storeClient) await endStoreWrite(storeClient);
  }
}

if (require.main === module) {
  app.listen(PORT, () => console.log(`EERMS API on http://localhost:${PORT} (data persisted to data/store.json)`));
  escalateAgedClaims().catch((error) => console.error('Could not process aged claims:', error));
  setInterval(() => escalateAgedClaims().catch((error) => console.error('Could not process aged claims:', error)), 60_000).unref();
}
module.exports = app;
