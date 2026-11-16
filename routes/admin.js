const router = require('express').Router();
const { db, CATEGORIES, CATEGORY_LABELS, BRANCHES, COST_CENTERS, audit, verifyAuditChain } = require('../store');
const { auth, role } = require('../middleware/auth');
const { view } = require('../claimUtil');

router.use(auth, role('admin', 'finance'));
const adminOnly = role('admin');

function analytics() {
  const spend = db.claims.filter((c) => ['APPROVED', 'PAID'].includes(c.status));
  const now = new Date();
  const monthKey = (d) => new Date(d).toISOString().slice(0, 7);
  const thisMonth = now.toISOString().slice(0, 7);
  const lines = spend.flatMap((c) => c.lines.map((l) => ({ ...l, c, emp: db.users.find((u) => u.id === c.employeeId) })));
  const cur = lines.filter((l) => monthKey(l.c.submittedAt) === thisMonth);
  const categories = CATEGORIES.map((k) => {
    const utilized = cur.filter((l) => l.category === k).reduce((s, l) => s + l.amount, 0);
    const budget = db.budget.categories[k] || 0;
    return { key: k, label: CATEGORY_LABELS[k], budget, utilized, pct: budget ? Math.round((utilized / budget) * 100) : 0 };
  });
  const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
  const by = (keys, f) => keys.map((k) => ({ name: k, amount: sum(lines.filter((l) => f(l) === k), (l) => l.amount) }));
  const trend = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - (5 - i), 1);
    const k = d.toISOString().slice(0, 7);
    return { month: d.toLocaleString('en-IN', { month: 'short', year: '2-digit' }), amount: sum(lines.filter((l) => monthKey(l.c.submittedAt) === k), (l) => l.amount) };
  });
  const paid = db.claims.filter((c) => c.status === 'PAID');
  const days = paid.map((c) => (new Date(c.paidAt) - new Date(c.submittedAt)) / 86400000);
  const statusCounts = ['SUBMITTED', 'UNDER_REVIEW', 'INFO_REQUESTED', 'APPROVED', 'PAID', 'REJECTED'].map((s) => ({ name: s, count: db.claims.filter((c) => c.status === s).length }));
  return {
    budget: { monthly: db.budget.monthly, utilized: sum(categories, (c) => c.utilized), pct: db.budget.monthly ? Math.round((sum(categories, (c) => c.utilized) / db.budget.monthly) * 100) : 0 },
    categories, byBranch: by(BRANCHES, (l) => l.emp && l.emp.branch), byDepartment: by(Object.keys(COST_CENTERS), (l) => l.emp && l.emp.department).filter((d) => d.amount > 0),
    trend, statusCounts, totals: { reimbursed: sum(paid, (c) => c.total), pipeline: sum(db.claims.filter((c) => ['SUBMITTED', 'UNDER_REVIEW', 'INFO_REQUESTED', 'APPROVED'].includes(c.status)), (c) => c.total), claims: db.claims.filter((c) => c.status !== 'DRAFT').length },
    avgTurnaroundDays: days.length ? +(sum(days, (d) => d) / days.length).toFixed(1) : 0, slaTargetDays: 5,
    slaMet: days.length ? Math.round((days.filter((d) => d <= 5).length / days.length) * 100) : 0,
  };
}

router.get('/analytics', adminOnly, (req, res) => res.json(analytics()));

router.get('/budget', adminOnly, (req, res) => res.json(db.budget));
router.put('/budget', adminOnly, (req, res) => {
  const { monthly, categories } = req.body || {};
  if (!(monthly > 0)) return res.status(400).json({ message: 'Monthly budget must be greater than 0' });
  db.budget.monthly = Number(monthly);
  if (categories) CATEGORIES.forEach((k) => { if (Number(categories[k]) >= 0) db.budget.categories[k] = Number(categories[k]); });
  audit(req.user, 'BUDGET_SET', 'budget', `₹${monthly}`, req.ip);
  res.json(db.budget);
});

// Universal search: ticket ref / employee ID (FR-09)
router.get('/search', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  if (!q) return res.json({ claims: [], employees: [] });
  const claims = db.claims.filter((c) => c.status !== 'DRAFT').map((c) => view(c))
    .filter((c) => c.ticketRef.toLowerCase().includes(q) || c.employee.empCode.toLowerCase().includes(q) || c.employee.fullName.toLowerCase().includes(q)).slice(0, 25);
  const employees = db.users.filter((u) => u.empCode.toLowerCase().includes(q) || u.fullName.toLowerCase().includes(q))
    .map((u) => ({ id: u.id, empCode: u.empCode, fullName: u.fullName, department: u.department, branch: u.branch, status: u.status })).slice(0, 25);
  res.json({ claims, employees });
});

router.get('/audit-log', adminOnly, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  let list = db.audit;
  if (q) list = list.filter((e) => [e.entity, e.actor, e.action, e.detail].some((v) => String(v).toLowerCase().includes(q)));
  if (req.query.from) list = list.filter((e) => e.at >= req.query.from);
  if (req.query.to) list = list.filter((e) => e.at <= req.query.to + 'T23:59:59Z');
  res.json({ chainValid: verifyAuditChain(), total: db.audit.length, entries: list.slice().reverse().slice(0, 300) });
});

router.get('/export.csv', adminOnly, (req, res) => {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['Ticket', 'Employee', 'EmpCode', 'Branch', 'Department', 'Category', 'Date', 'Amount_INR', 'Status', 'UTR'].join(',')];
  db.claims.filter((c) => c.status !== 'DRAFT').forEach((c) => {
    const e = db.users.find((u) => u.id === c.employeeId);
    c.lines.forEach((l) => rows.push([c.ticketRef, esc(e.fullName), e.empCode, e.branch, e.department, CATEGORY_LABELS[l.category], l.date, l.amount, c.status, c.utr || ''].join(',')));
  });
  audit(req.user, 'REPORT_EXPORTED', 'claims.csv', '', req.ip);
  res.type('text/csv').send(rows.join('\n'));
});

module.exports = router;
