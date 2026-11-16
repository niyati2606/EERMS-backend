const { db, POLICY, maskAcct } = require('./store');

const HOUR = 3600000;

// Release expired 15-minute leases (lazy expiry)
function normalizeLock(c) {
  if (c.lockedBy && c.lockExpires && new Date(c.lockExpires) < new Date()) {
    c.lockedBy = null; c.lockExpires = null;
    if (c.status === 'UNDER_REVIEW') c.status = 'SUBMITTED';
  }
  return c;
}

function flags(c) {
  const f = [];
  if (c.total > POLICY.highValue) f.push({ code: 'HIGH_VALUE', label: `High value > ₹${POLICY.highValue.toLocaleString('en-IN')}` });
  if (['SUBMITTED'].includes(c.status) && c.submittedAt && Date.now() - new Date(c.submittedAt) > POLICY.queueSlaHours * HOUR)
    f.push({ code: 'AGED', label: `Unassigned > ${POLICY.queueSlaHours}h` });
  const late = c.lines.some((l) => c.submittedAt && (new Date(c.submittedAt) - new Date(l.date)) / 86400000 > POLICY.graceDays);
  if (late) f.push({ code: 'LATE', label: `Submitted after ${POLICY.graceDays}-day grace` });
  const mealsByDay = {};
  c.lines.filter((l) => l.category === 'MEALS').forEach((l) => { mealsByDay[l.date] = (mealsByDay[l.date] || 0) + l.amount; });
  if (Object.values(mealsByDay).some((v) => v > POLICY.mealsPerDay)) f.push({ code: 'MEALS_CAP', label: `Meals > ₹${POLICY.mealsPerDay}/day` });
  if (c.lines.some((l) => l.category === 'HOTEL' && l.amount > POLICY.hotelPerNight)) f.push({ code: 'HOTEL_CAP', label: `Hotel > ₹${POLICY.hotelPerNight}/night` });
  if (c.lines.some((l) => l.duplicate)) f.push({ code: 'DUPLICATE', label: 'Possible duplicate (Emp+Date+Amount+Category)' });
  if (c.lines.some((l) => !l.receipt)) f.push({ code: 'NO_RECEIPT', label: 'Line without receipt file' });
  return f;
}

function view(c, { withEmployee = true, reveal = false } = {}) {
  normalizeLock(c);
  const emp = db.users.find((u) => u.id === c.employeeId);
  const locker = c.lockedBy && db.users.find((u) => u.id === c.lockedBy);
  const out = {
    ...c,
    lines: c.lines.map((l) => ({ ...l, receipt: l.receipt ? { name: l.receipt.name, file: l.receipt.file, size: l.receipt.size, hash: l.receipt.hash, mime: l.receipt.mime } : null })),
    flags: flags(c),
    lockedByName: locker ? locker.fullName : null,
  };
  if (withEmployee && emp) {
    const b = db.bank.find((x) => x.userId === emp.id);
    out.employee = {
      id: emp.id, empCode: emp.empCode, fullName: emp.fullName, department: emp.department, branch: emp.branch, status: emp.status,
      bank: b ? { bankName: b.bankName, ifsc: b.ifsc, account: reveal ? b.accountNumber : maskAcct(b.accountNumber), status: b.status } : null,
    };
  }
  return out;
}

module.exports = { normalizeLock, flags, view };
