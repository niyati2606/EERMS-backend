const jwt = require('jsonwebtoken');
const { db } = require('../store');

const SECRET = process.env.JWT_SECRET || 'eerms-dev-secret-change-me';
const sign = (user) => jwt.sign({ id: user.id, role: user.role }, SECRET, { expiresIn: '8h' });

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ message: 'Authentication required' });
  try {
    const p = jwt.verify(token, SECRET);
    const user = db.users.find((u) => u.id === p.id);
    if (!user || user.status !== 'active') return res.status(401).json({ message: 'Account unavailable or frozen' });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ message: 'Invalid or expired session' });
  }
}
const role = (...roles) => (req, res, next) =>
  roles.includes(req.user.role) ? next() : res.status(403).json({ message: 'You do not have access to this resource' });

module.exports = { sign, auth, role };
