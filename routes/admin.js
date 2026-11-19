const router = require('express').Router();
const { db, CATEGORIES, CATEGORY_LABELS, BRANCHES, audit, verifyAuditChain } = require('../store');
const { auth, role } = require('../middleware/auth');

router.use(auth, role('admin', 'finance'));
const adminOnly = role('admin');

function analytics(trendFrom, trendTo, quarterlyBranches, quarterlyYear, statusFrom, statusTo, statusBranch, branchSpendMonth, branchSpendCategory) {
  const spend = db.claims.filter((c) => ['APPROVED', 'PAID'].includes(c.status));
  const now = new Date();
  const monthKey = (d) => new Date(d).toISOString().slice(0, 7);
  const thisMonth = now.toISOString().slice(0, 7);
  const lines = spend.flatMap((c) => c.lines.map((l) => ({ ...l, c, emp: db.users.find((u) => u.id === c.employeeId) })));
  const branchSpendLines = lines.filter((line) => monthKey(line.date) === branchSpendMonth
    && (!branchSpendCategory || line.category === branchSpendCategory));
  const cur = lines.filter((l) => monthKey(l.date) === thisMonth);
  const categories = CATEGORIES.map((k) => {
    const utilized = cur.filter((l) => l.category === k).reduce((s, l) => s + l.amount, 0);
    const budget = db.budget.categories[k] || 0;
    return { key: k, label: CATEGORY_LABELS[k], budget, utilized, pct: budget ? Math.round((utilized / budget) * 100) : 0 };
  });
  const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
  const by = (keys, f) => keys.map((k) => ({ name: k, amount: sum(lines.filter((l) => f(l) === k), (l) => l.amount) }));
  const trendEnd = trendTo
    ? new Date(`${trendTo}-01T00:00:00.000Z`)
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const trendStart = trendFrom
    ? new Date(`${trendFrom}-01T00:00:00.000Z`)
    : new Date(Date.UTC(trendEnd.getUTCFullYear(), trendEnd.getUTCMonth() - 5, 1));
  const trend = [];
  for (let month = trendStart; month <= trendEnd; month = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1))) {
    const key = month.toISOString().slice(0, 7);
    trend.push({
      month: month.toLocaleString('en-IN', { month: 'short', year: '2-digit', timeZone: 'UTC' }),
      amount: sum(lines.filter((line) => monthKey(line.date) === key), (line) => line.amount),
    });
  }
  const quarterKey = (date) => `${date.getUTCFullYear()}-Q${Math.floor(date.getUTCMonth() / 3) + 1}`;
  const firstQuarterYear = 2024;
  const quarterYears = Array.from(
    { length: Math.max(now.getUTCFullYear() - firstQuarterYear + 1, 1) },
    (_, index) => firstQuarterYear + index
  );
  const quarterLines = quarterlyBranches.length
    ? lines.filter((line) => line.emp && quarterlyBranches.includes(line.emp.branch))
    : lines;
  const monthlySpend = Array.from({ length: 12 }, (_, i) => {
    const monthDate = new Date(Date.UTC(quarterlyYear, i, 1));
    const month = monthDate.toISOString().slice(0, 7);
    return {
      month: monthDate.toLocaleString('en-IN', { month: 'short', timeZone: 'UTC' }),
      amount: sum(quarterLines.filter((line) => monthKey(line.date) === month), (line) => line.amount),
    };
  });
  const quarterlySpend = Array.from({ length: 4 }, (_, i) => {
    const quarter = `${quarterlyYear}-Q${i + 1}`;
    return {
      quarter: `Q${i + 1} ${quarterlyYear}`,
      amount: sum(quarterLines.filter((line) => quarterKey(new Date(line.date)) === quarter), (line) => line.amount),
    };
  });
  const paid = db.claims.filter((c) => c.status === 'PAID');
  const days = paid.map((c) => (new Date(c.paidAt) - new Date(c.submittedAt)) / 86400000);
  const statuses = ['SUBMITTED', 'UNDER_REVIEW', 'INFO_REQUESTED', 'APPROVED', 'PAID', 'REJECTED'];
  const statusClaims = db.claims.filter((claim) => {
    if (!statuses.includes(claim.status)) return false;
    if (statusFrom && (!claim.submittedAt || monthKey(claim.submittedAt) < statusFrom || monthKey(claim.submittedAt) > statusTo)) return false;
    if (statusBranch) {
      const employee = db.users.find((user) => user.id === claim.employeeId);
      if (!employee || employee.branch !== statusBranch) return false;
    }
    return true;
  });
  const statusCounts = statuses.map((status) => ({
    name: status,
    count: statusClaims.filter((claim) => claim.status === status).length,
  }));
  const branchSpend = BRANCHES.map((branch) => ({
    name: branch,
    amount: sum(branchSpendLines.filter((line) => line.emp && line.emp.branch === branch), (line) => line.amount),
  }));
  return {
    budget: { monthly: db.budget.monthly, utilized: sum(categories, (c) => c.utilized), pct: db.budget.monthly ? Math.round((sum(categories, (c) => c.utilized) / db.budget.monthly) * 100) : 0 },
    categories, byBranch: branchSpend,
    trend, monthlySpend, quarterlySpend, quarterYears, statusCounts, totals: { reimbursed: sum(paid, (c) => c.total), pipeline: sum(db.claims.filter((c) => ['SUBMITTED', 'UNDER_REVIEW', 'INFO_REQUESTED', 'APPROVED'].includes(c.status)), (c) => c.total), claims: db.claims.filter((c) => c.status !== 'DRAFT').length },
    avgTurnaroundDays: days.length ? +(sum(days, (d) => d) / days.length).toFixed(1) : 0, slaTargetDays: 5,
    slaMet: days.length ? Math.round((days.filter((d) => d <= 5).length / days.length) * 100) : 0,
  };
}

router.get('/analytics', adminOnly, (req, res) => {
  const from = String(req.query.from || '');
  const to = String(req.query.to || '');
  const branchFilter = String(req.query.branches || req.query.branch || '');
  const branches = branchFilter ? Array.from(new Set(branchFilter.split(',').filter(Boolean))) : [];
  const yearValue = String(req.query.year || '');
  const year = yearValue ? Number(yearValue) : new Date().getUTCFullYear();
  const statusFrom = String(req.query.statusFrom || '');
  const statusTo = String(req.query.statusTo || '');
  const statusBranch = String(req.query.statusBranch || '');
  const branchSpendCategory = String(req.query.branchCategory || '');
  const isMonth = (value) => /^\d{4}-(0[1-9]|1[0-2])$/.test(value)
    && new Date(`${value}-01T00:00:00.000Z`).toISOString().slice(0, 7) === value;
  const branchSpendMonth = String(req.query.branchMonth || new Date().toISOString().slice(0, 7));
  if (Boolean(from) !== Boolean(to) || (from && (!isMonth(from) || !isMonth(to) || from > to))) {
    return res.status(400).json({ message: 'Choose a valid start and end month range' });
  }
  if (Boolean(statusFrom) !== Boolean(statusTo) || (statusFrom && (!isMonth(statusFrom) || !isMonth(statusTo) || statusFrom > statusTo))) {
    return res.status(400).json({ message: 'Choose a valid claims status month range' });
  }
  if (!isMonth(branchSpendMonth)) {
    return res.status(400).json({ message: 'Choose a valid month for branch spend' });
  }
  if (branchSpendCategory && !CATEGORIES.includes(branchSpendCategory)) {
    return res.status(400).json({ message: 'Choose a valid category for branch spend' });
  }
  if (branches.some((branch) => !BRANCHES.includes(branch))) {
    return res.status(400).json({ message: 'Unknown branch' });
  }
  if (statusBranch && !BRANCHES.includes(statusBranch)) {
    return res.status(400).json({ message: 'Unknown claims status branch' });
  }
  if (yearValue && !/^\d{4}$/.test(yearValue)) {
    return res.status(400).json({ message: 'Choose a valid year' });
  }
  res.json(analytics(from, to, branches, year, statusFrom, statusTo, statusBranch, branchSpendMonth, branchSpendCategory));
});

router.get('/claims', adminOnly, (req, res) => {
  const category = String(req.query.category || '').trim();
  if (category && !CATEGORIES.includes(category)) {
    return res.status(400).json({ message: 'Unknown expense category' });
  }

  const claims = db.claims
    .filter((claim) => claim.status !== 'DRAFT' && (!category || claim.lines.some((line) => line.category === category)))
    .map((claim) => {
      const employee = db.users.find((user) => user.id === claim.employeeId);
      return {
        id: claim.id,
        claimId: claim.ticketRef || claim.id,
        employeeName: employee ? employee.fullName : 'Employee record unavailable',
        branch: employee ? employee.branch || '—' : '—',
        categories: [...new Set(claim.lines.map((line) => line.category))]
          .map((key) => CATEGORY_LABELS[key] || key),
        status: claim.status,
      };
    })
    .sort((a, b) => a.claimId.localeCompare(b.claimId));

  res.json({ claims });
});

router.get('/employee-claim-summary', adminOnly, (req, res) => {
  const periodType = String(req.query.periodType || 'month');
  const now = new Date();
  const currentMonth = now.toISOString().slice(0, 7);
  const currentQuarter = `${now.getUTCFullYear()}-Q${Math.floor(now.getUTCMonth() / 3) + 1}`;
  const period = String(req.query.period || (periodType === 'quarter' ? currentQuarter : currentMonth));
  const category = String(req.query.category || '').trim();
  const isMonth = (value) => /^\d{4}-(0[1-9]|1[0-2])$/.test(value);

  if (!['month', 'quarter'].includes(periodType)) {
    return res.status(400).json({ message: 'Choose month or quarter for the claims period' });
  }
  if (periodType === 'month' && !isMonth(period)) {
    return res.status(400).json({ message: 'Choose a valid claim month' });
  }
  if (periodType === 'quarter' && !/^\d{4}-Q[1-4]$/.test(period)) {
    return res.status(400).json({ message: 'Choose a valid claim quarter' });
  }
  if (category && !CATEGORIES.includes(category)) {
    return res.status(400).json({ message: 'Unknown expense category' });
  }

  const quarterBounds = periodType === 'quarter'
    ? (() => {
      const [, year, quarter] = period.match(/^(\d{4})-Q([1-4])$/);
      const firstMonth = (Number(quarter) - 1) * 3 + 1;
      return [
        `${year}-${String(firstMonth).padStart(2, '0')}`,
        `${year}-${String(firstMonth + 2).padStart(2, '0')}`,
      ];
    })()
    : null;
  const employees = db.users
    .filter((user) => user.role === 'employee')
    .map((employee) => {
      const periodClaims = db.claims.filter((claim) => {
        if (claim.employeeId !== employee.id || claim.status === 'DRAFT') return false;
        if (category && !claim.lines.some((line) => line.category === category)) return false;
        const month = String(claim.submittedAt || claim.createdAt || '').slice(0, 7);
        return periodType === 'month' ? month === period : month >= quarterBounds[0] && month <= quarterBounds[1];
      });
      const lineTotal = (claim) => claim.lines
        .filter((line) => !category || line.category === category)
        .reduce((sum, line) => sum + line.amount, 0);
      const totalSpend = periodClaims
        .filter((claim) => ['APPROVED', 'PAID'].includes(claim.status))
        .reduce((sum, claim) => sum + lineTotal(claim), 0);
      const pendingTotal = periodClaims
        .filter((claim) => ['SUBMITTED', 'UNDER_REVIEW', 'INFO_REQUESTED'].includes(claim.status))
        .reduce((sum, claim) => sum + lineTotal(claim), 0);
      return {
        id: employee.id,
        fullName: employee.fullName,
        empCode: employee.empCode,
        branch: employee.branch || '—',
        claimCount: periodClaims.length,
        totalSpend,
        averagePerClaim: periodClaims.length ? totalSpend / periodClaims.length : 0,
        pendingTotal,
        rejectedCount: periodClaims.filter((claim) => claim.status === 'REJECTED').length,
      };
    })
    .sort((a, b) => a.fullName.localeCompare(b.fullName));

  const branchTotals = employees.reduce((totals, employee) => {
    if (!totals[employee.branch]) totals[employee.branch] = { spend: 0, employeeCount: 0 };
    totals[employee.branch].spend += employee.totalSpend;
    totals[employee.branch].employeeCount += 1;
    return totals;
  }, {});
  employees.forEach((employee) => {
    const branch = branchTotals[employee.branch];
    employee.branchAverage = branch.employeeCount ? branch.spend / branch.employeeCount : 0;
    employee.branchVariancePct = employee.branchAverage
      ? ((employee.totalSpend - employee.branchAverage) / employee.branchAverage) * 100
      : null;
  });

  res.json({ employees, periodType, period });
});

router.get('/budget', adminOnly, (req, res) => res.json(db.budget));
router.put('/budget', adminOnly, (req, res) => {
  const { monthly, categories } = req.body || {};
  if (!(monthly > 0)) return res.status(400).json({ message: 'Monthly budget must be greater than 0' });
  db.budget.monthly = Number(monthly);
  if (categories) CATEGORIES.forEach((k) => { if (Number(categories[k]) >= 0) db.budget.categories[k] = Number(categories[k]); });
  audit(req.user, 'BUDGET_SET', 'budget', `₹${monthly}`, req.ip);
  res.json(db.budget);
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
  const rows = [['Ticket', 'Employee', 'EmpCode', 'Branch', 'Category', 'Date', 'Amount_INR', 'Status', 'UTR'].join(',')];
  db.claims.filter((c) => c.status !== 'DRAFT').forEach((c) => {
    const e = db.users.find((u) => u.id === c.employeeId);
    c.lines.forEach((l) => rows.push([c.ticketRef, esc(e.fullName), e.empCode, e.branch, CATEGORY_LABELS[l.category], l.date, l.amount, c.status, c.utr || ''].join(',')));
  });
  audit(req.user, 'REPORT_EXPORTED', 'claims.csv', '', req.ip);
  res.type('text/csv').send(rows.join('\n'));
});

module.exports = router;
