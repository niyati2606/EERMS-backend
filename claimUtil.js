const { db, POLICY, maskAcct } = require('./store');

const HOUR = 3600000;
const DAY = 24 * HOUR;
const IST_OFFSET = 330 * 60000;

function businessHoursBetween(start, end = Date.now()) {
  const startMs = typeof start === 'number' ? start : Date.parse(start);
  const endMs = typeof end === 'number' ? end : Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return 0;

  const localStart = startMs + IST_OFFSET;
  const localEnd = endMs + IST_OFFSET;
  const firstDay = new Date(localStart);
  const lastDay = new Date(localEnd);
  let total = 0;
  for (let day = Date.UTC(firstDay.getUTCFullYear(), firstDay.getUTCMonth(), firstDay.getUTCDate());
    day <= Date.UTC(lastDay.getUTCFullYear(), lastDay.getUTCMonth(), lastDay.getUTCDate()); day += DAY) {
    const weekday = new Date(day).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    const open = day + POLICY.businessStartHour * HOUR;
    const close = day + POLICY.businessEndHour * HOUR;
    total += Math.max(0, Math.min(localEnd, close) - Math.max(localStart, open));
  }
  return total / HOUR;
}

// Release expired one-hour leases (lazy expiry)
function normalizeLock(c) {
  if (c.lockedBy && c.lockExpires && new Date(c.lockExpires) < new Date()) {
    c.lockedBy = null; c.lockExpires = null;
    if (c.status === 'UNDER_REVIEW') c.status = 'SUBMITTED';
  }
  return c;
}

function duplicateIndicators(c) {
  const cutoff = new Date();
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 1);
  const submittedOthers = db.claims.filter((other) => other.id !== c.id && other.status !== 'DRAFT');
  const recentOthers = submittedOthers.filter((other) => other.submittedAt && new Date(other.submittedAt) >= cutoff);
  return c.lines.map((line) => ({
    ...line,
    duplicate: recentOthers.some((other) => other.employeeId === c.employeeId
      && other.lines.some((candidate) => candidate.date === line.date && candidate.amount === line.amount && candidate.category === line.category)),
    receiptDuplicate: Boolean(line.receipt && (
      submittedOthers.some((other) => other.lines.some((candidate) => candidate.receipt && candidate.receipt.hash === line.receipt.hash))
      || c.lines.some((candidate) => candidate.id !== line.id && candidate.receipt && candidate.receipt.hash === line.receipt.hash)
    )),
  }));
}

function flags(c) {
  const f = [];
  if (c.total > POLICY.highValue) f.push({ code: 'HIGH_VALUE', label: `High value > ₹${POLICY.highValue.toLocaleString('en-IN')}` });
  if (c.status === 'SUBMITTED' && !c.lockedBy && c.submittedAt && businessHoursBetween(c.submittedAt) > POLICY.queueSlaHours)
    f.push({ code: 'AGED', label: `Unassigned > ${POLICY.queueSlaHours} business hours` });
  const late = c.lines.some((l) => c.submittedAt && (new Date(c.submittedAt) - new Date(l.date)) / 86400000 > POLICY.graceDays);
  if (late) f.push({ code: 'LATE', label: `Submitted after ${POLICY.graceDays}-day grace` });
  const mealsByDay = {};
  c.lines.filter((l) => l.category === 'MEALS').forEach((l) => { mealsByDay[l.date] = (mealsByDay[l.date] || 0) + l.amount; });
  if (Object.values(mealsByDay).some((v) => v > POLICY.mealsPerDay)) f.push({ code: 'MEALS_CAP', label: `Meals > ₹${POLICY.mealsPerDay}/day` });
  if (c.lines.some((l) => l.category === 'HOTEL' && l.amount > POLICY.hotelPerNight)) f.push({ code: 'HOTEL_CAP', label: `Hotel > ₹${POLICY.hotelPerNight}/night` });
  if (c.lines.some((l) => l.duplicate)) f.push({ code: 'DUPLICATE', label: 'Possible duplicate (Emp+Date+Amount+Category, past 12 months)' });
  if (c.lines.some((l) => l.receiptDuplicate)) f.push({ code: 'RECEIPT_DUPLICATE', label: 'High-severity duplicate receipt file' });
  if (c.lines.some((l) => l.category === 'ROAD' && Number(l.distanceKm) > 0 && Number(l.amount) > Number(l.distanceKm) * POLICY.mileagePerKm)) {
    f.push({ code: 'MILEAGE_POLICY', label: `Road expense exceeds ₹${POLICY.mileagePerKm}/km policy` });
  }
  if (c.lines.some((l) => !l.receipt)) f.push({ code: 'NO_RECEIPT', label: 'Line without receipt file' });
  return f;
}

function view(c, { withEmployee = true, reveal = false } = {}) {
  normalizeLock(c);
  const emp = db.users.find((u) => u.id === c.employeeId);
  const locker = c.lockedBy && db.users.find((u) => u.id === c.lockedBy);
  const lines = duplicateIndicators(c).map((l) => {
    const amount = Number(l.amount) || 0;
    const gstAmount = Math.round((amount * POLICY.gstRate / (100 + POLICY.gstRate)) * 100) / 100;
    const mileageLimit = l.category === 'ROAD' && Number(l.distanceKm) > 0
      ? Math.round(Number(l.distanceKm) * POLICY.mileagePerKm * 100) / 100
      : null;
    return {
      ...l,
      taxableAmount: Math.round((amount - gstAmount) * 100) / 100,
      gstAmount,
      mileageLimit,
      mileageExceeded: mileageLimit !== null && amount > mileageLimit,
      receipt: l.receipt ? { name: l.receipt.name, file: l.receipt.file, size: l.receipt.size, hash: l.receipt.hash, mime: l.receipt.mime } : null,
    };
  });
  const out = {
    ...c,
    lines,
    policyCalculation: {
      gstRate: POLICY.gstRate,
      mileagePerKm: POLICY.mileagePerKm,
      taxableAmount: Math.round(lines.reduce((sum, line) => sum + line.taxableAmount, 0) * 100) / 100,
      gstAmount: Math.round(lines.reduce((sum, line) => sum + line.gstAmount, 0) * 100) / 100,
    },
    flags: flags({ ...c, lines }),
    lockedByName: locker ? locker.fullName : null,
  };
  if (withEmployee) {
    const b = emp && db.bank.find((x) => x.userId === emp.id);
    out.employee = emp ? {
      id: emp.id, empCode: emp.empCode || '—', fullName: emp.fullName || 'Unknown employee', branch: emp.branch || '—', status: emp.status,
      bank: b ? { bankName: b.bankName, ifsc: b.ifsc, account: reveal ? b.accountNumber : maskAcct(b.accountNumber), status: b.status } : null,
    } : {
      id: c.employeeId || null, empCode: '—', fullName: 'Employee record unavailable', branch: '—', status: 'unavailable', bank: null,
    };
  }
  return out;
}

function getFrontendUrl(req) {
  let origin = null;
  if (req && req.headers) {
    origin = req.headers.origin;
    if (!origin && req.headers.referer) {
      try { origin = new URL(req.headers.referer).origin; } catch (_) {}
    }
  }
  if (origin && origin.includes('.vercel.app')) {
    return origin.replace(/\/+$/, '');
  }
  if (process.env.CLIENT_ORIGIN && !process.env.CLIENT_ORIGIN.includes('localhost')) {
    return process.env.CLIENT_ORIGIN.replace(/\/+$/, '');
  }
  if (origin && !origin.includes('localhost')) {
    return origin.replace(/\/+$/, '');
  }
  if (process.env.VERCEL || process.env.NODE_ENV === 'production') {
    return (process.env.CLIENT_ORIGIN || 'https://eerms-frontend.vercel.app').replace(/\/+$/, '');
  }
  return (origin || process.env.CLIENT_ORIGIN || 'http://localhost:5173').replace(/\/+$/, '');
}

module.exports = { normalizeLock, businessHoursBetween, duplicateIndicators, flags, view, getFrontendUrl };
