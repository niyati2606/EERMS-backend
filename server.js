require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { db, POLICY, notify, initializeStore, getPersistenceType } = require('./store');
const { auth } = require('./middleware/auth');
const { uploadErrors } = require('./middleware/uploadMiddleware');
const claims = require('./routes/claims');
const { businessHoursBetween, normalizeLock } = require('./claimUtil');

const app = express();
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(async (req, res, next) => {
  try {
    await initializeStore();
    next();
  } catch (error) {
    console.error('Store initialization failed:', error);
    res.status(503).json({ message: 'Application store unavailable' });
  }
});

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

function escalateAgedClaims() {
  const now = Date.now();
  const recipients = db.users.filter((user) => user.role === 'finance' && user.status === 'active');
  if (!recipients.length) return;
  const aged = db.claims.filter((claim) => {
    normalizeLock(claim);
    return claim.status === 'SUBMITTED' && !claim.lockedBy && !claim.slaEscalatedAt
      && businessHoursBetween(claim.submittedAt, now) > POLICY.queueSlaHours;
  });
  if (!aged.length) return;
  const refs = aged.map((claim) => claim.ticketRef).filter(Boolean);
  const shown = refs.slice(0, 5).join(', ');
  const extra = refs.length > 5 ? `, and ${refs.length - 5} more` : '';
  const message = `SLA escalation digest: ${aged.length} unassigned claim(s) exceeded ${POLICY.queueSlaHours} business hours (${shown}${extra}).`;
  const at = new Date(now).toISOString();
  aged.forEach((claim) => { claim.slaEscalatedAt = at; });
  recipients.forEach((user) => notify(user.id, message, '/finance/dashboard'));
}

if (require.main === module) {
  app.listen(PORT, () => console.log(`EERMS API on http://localhost:${PORT} (data persisted to data/store.json)`));
  escalateAgedClaims();
  setInterval(escalateAgedClaims, 60_000).unref();
}
module.exports = app;
