require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { db } = require('./store');
const { auth } = require('./middleware/auth');
const { uploadErrors } = require('./middleware/uploadMiddleware');
const claims = require('./routes/claims');

const app = express();
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({ origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173' }));
app.use(express.json({ limit: '1mb' }));
app.use('/api/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 50, standardHeaders: true, legacyHeaders: false }));

app.get('/api/health', (req, res) => res.json({ ok: true, store: 'json-file' }));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/employee', require('./routes/employee'));
app.use('/api/claims', claims);
app.use('/api/finance', require('./routes/finance'));
app.use('/api/hr', require('./routes/hr'));
app.use('/api/admin', require('./routes/admin'));
app.get('/api/files/receipts/:file', auth, claims.receiptFileHandler);

app.get('/api/notifications', auth, (req, res) => {
  const list = db.notifications.filter((n) => n.userId === req.user.id).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 30);
  res.json({ unread: list.filter((n) => !n.read).length, items: list });
});
app.post('/api/notifications/read', auth, (req, res) => {
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
if (require.main === module) app.listen(PORT, () => console.log(`EERMS API on http://localhost:${PORT} (data persisted to data/store.json)`));
module.exports = app;
