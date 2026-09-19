const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'data.json');

const defaultData = {
  settings: {
    foundationName: "Foundation Dues Portal",
    currency: "GHS",
    minWeeklyDues: 5.00,
    momoMerchantNumber: "0241234567",
    momoMerchantName: "FOUNDATION MERCHANT",
    momoTillNumber: "847291",
    adminPin: "1234"
  },
  members: [
    {
      id: "mem_1",
      memberCode: "FDN-001",
      fullName: "Abdulrazak Usman",
      phone: "0240000001",
      email: "abdulrazak@foundation.org",
      joinDate: "2024-01-01",
      active: true,
      role: "Financial Secretary"
    }
  ],
  payments: []
};

function getWeekNumber(d) {
  d = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

class Database {
  constructor() {
    this.init();
  }

  init() {
    if (!fs.existsSync(DATA_FILE)) {
      this.write(defaultData);
    } else {
      try {
        JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      } catch (e) {
        this.write(defaultData);
      }
    }
  }

  read() {
    try {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch (e) {
      return defaultData;
    }
  }

  write(data) {
    const tempFile = `${DATA_FILE}.tmp.${Date.now()}`;
    fs.writeFileSync(tempFile, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tempFile, DATA_FILE);
  }

  getSettings() {
    return this.read().settings;
  }

  updateSettings(newSettings) {
    const data = this.read();
    data.settings = { ...data.settings, ...newSettings };
    this.write(data);
    return data.settings;
  }

  getMembers() {
    return this.read().members || [];
  }

  findMemberByCodeOrPhone(query) {
    if (!query) return null;
    const cleanQuery = query.trim().toUpperCase();
    const members = this.getMembers();
    return members.find(m => 
      m.memberCode.toUpperCase() === cleanQuery ||
      m.phone.replace(/[\s-]/g, '') === cleanQuery.replace(/[\s-]/g, '')
    ) || null;
  }

  addMember({ fullName, phone, email, role }) {
    const data = this.read();
    const count = data.members.length + 1;
    const padded = String(count).padStart(3, '0');
    const memberCode = `FDN-${padded}`;
    const newMember = {
      id: `mem_${Date.now()}`,
      memberCode,
      fullName: fullName.trim(),
      phone: phone ? phone.trim() : '',
      email: email ? email.trim() : '',
      role: role || 'Member',
      joinDate: new Date().toISOString().split('T')[0],
      active: true
    };
    data.members.push(newMember);
    this.write(data);
    return newMember;
  }

  getPayments() {
    const data = this.read();
    return (data.payments || []).sort((a, b) => new Date(b.date) - new Date(a.date));
  }

  getPaymentsForMember(memberCode) {
    return this.getPayments().filter(p => p.memberCode.toUpperCase() === memberCode.toUpperCase());
  }

  recordPayment({ memberCode, amount, momoTransactionId, momoPhoneNumber, paymentMethod, weekNumber, year, notes, status = 'Pending Verification' }) {
    const data = this.read();
    const member = this.findMemberByCodeOrPhone(memberCode);
    if (!member) throw new Error(`Member with code ${memberCode} not found.`);

    const currentYear = year || new Date().getFullYear();
    const currentWeek = weekNumber || getWeekNumber(new Date());

    const payment = {
      id: `pay_${Date.now()}`,
      memberId: member.id,
      memberCode: member.memberCode,
      fullName: member.fullName,
      amount: parseFloat(amount),
      year: parseInt(currentYear),
      weekNumber: parseInt(currentWeek),
      date: new Date().toISOString().split('T')[0],
      paymentMethod: paymentMethod || "MTN Mobile Money",
      momoTransactionId: (momoTransactionId || '').trim(),
      momoPhoneNumber: momoPhoneNumber ? momoPhoneNumber.trim() : member.phone,
      status: status,
      verifiedBy: status === 'Verified' ? 'System' : null,
      verifiedAt: status === 'Verified' ? new Date().toISOString() : null,
      notes: notes || 'Weekly Dues'
    };

    data.payments.unshift(payment);
    this.write(data);
    return payment;
  }

  verifyPayment(paymentId, verifiedBy = 'Financial Secretary') {
    const data = this.read();
    const payment = data.payments.find(p => p.id === paymentId);
    if (!payment) throw new Error("Payment record not found");
    payment.status = "Verified";
    payment.verifiedBy = verifiedBy;
    payment.verifiedAt = new Date().toISOString();
    this.write(data);
    return payment;
  }

  rejectPayment(paymentId, reason = 'Invalid reference') {
    const data = this.read();
    const payment = data.payments.find(p => p.id === paymentId);
    if (!payment) throw new Error("Payment record not found");
    payment.status = "Rejected";
    payment.notes = (payment.notes ? payment.notes + " | " : "") + `Rejected: ${reason}`;
    this.write(data);
    return payment;
  }

  getDashboardStats() {
    const data = this.read();
    const members = data.members.filter(m => m.active);
    const payments = data.payments || [];
    const currentYear = new Date().getFullYear();
    const currentWeek = getWeekNumber(new Date());

    const totalCollected = payments
      .filter(p => p.status === 'Verified')
      .reduce((sum, p) => sum + p.amount, 0);

    const thisWeekPayments = payments
      .filter(p => p.status === 'Verified' && p.year === currentYear && p.weekNumber === currentWeek);

    const thisWeekCollected = thisWeekPayments.reduce((sum, p) => sum + p.amount, 0);
    const paidMemberCodes = new Set(thisWeekPayments.map(p => p.memberCode));
    const paidMembersCount = members.filter(m => paidMemberCodes.has(m.memberCode)).length;
    const unpaidMembers = members.filter(m => !paidMemberCodes.has(m.memberCode));
    const pendingApprovals = payments.filter(p => p.status === 'Pending Verification');

    return {
      currentWeek,
      currentYear,
      totalMembers: members.length,
      totalCollected,
      thisWeekCollected,
      paidMembersCount,
      unpaidMembersCount: unpaidMembers.length,
      unpaidMembers,
      pendingApprovalsCount: pendingApprovals.length,
      currency: data.settings.currency || 'GHS',
      minWeeklyDues: data.settings.minWeeklyDues || 5.00
    };
  }
}

module.exports = {
  db: new Database(),
  getWeekNumber
};