const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, getWeekNumber } = require('./db.js');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const activeSessions = new Map();

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
      if (body.length > 1e6) { req.destroy(); reject(new Error('Payload too large')); }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch (err) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
  });
  res.end(JSON.stringify(data));
}

function checkAdminAuth(req) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token || !activeSessions.has(token)) return false;
  const session = activeSessions.get(token);
  if (Date.now() - session.createdAt > 24 * 60 * 60 * 1000) {
    activeSessions.delete(token);
    return false;
  }
  return true;
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json'
};

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const method = req.method;

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
    });
    res.end();
    return;
  }

  try {
    if (pathname === '/api/foundation-info' && method === 'GET') {
      const s = db.getSettings();
      return sendJson(res, 200, {
        foundationName: s.foundationName,
        currency: s.currency,
        minWeeklyDues: s.minWeeklyDues,
        momoMerchantNumber: s.momoMerchantNumber,
        momoMerchantName: s.momoMerchantName,
        momoTillNumber: s.momoTillNumber,
        currentWeek: getWeekNumber(new Date()),
        currentYear: new Date().getFullYear()
      });
    }

    if (pathname === '/api/member/lookup' && method === 'GET') {
      const query = parsedUrl.query.query || parsedUrl.query.code;
      const member = db.findMemberByCodeOrPhone(query);
      if (!member) return sendJson(res, 404, { error: 'Member not found.' });

      const payments = db.getPaymentsForMember(member.memberCode);
      const currentWeek = getWeekNumber(new Date());
      const currentYear = new Date().getFullYear();
      const thisWeekPaid = payments.find(p => p.status === 'Verified' && p.year === currentYear && p.weekNumber === currentWeek);
      const thisWeekPending = payments.find(p => p.status === 'Pending Verification' && p.year === currentYear && p.weekNumber === currentWeek);

      return sendJson(res, 200, {
        member,
        currentWeek,
        currentYear,
        hasPaidCurrentWeek: !!thisWeekPaid,
        hasPendingCurrentWeek: !!thisWeekPending,
        totalPaid: payments.filter(p => p.status === 'Verified').reduce((sum, p) => sum + p.amount, 0),
        recentPayments: payments.slice(0, 10)
      });
    }

    if (pathname === '/api/dues/submit' && method === 'POST') {
      const { memberCode, amount, momoTransactionId, momoPhoneNumber, notes } = await parseJsonBody(req);
      const settings = db.getSettings();
      const numAmount = parseFloat(amount);

      if (isNaN(numAmount) || numAmount < settings.minWeeklyDues) {
        return sendJson(res, 400, { error: `Minimum dues is GHS ${settings.minWeeklyDues.toFixed(2)}` });
      }

      const payment = db.recordPayment({
        memberCode,
        amount: numAmount,
        momoTransactionId,
        momoPhoneNumber,
        notes,
        status: 'Pending Verification'
      });

      return sendJson(res, 201, { success: true, payment });
    }

    if (pathname === '/api/momo/webhook' && method === 'POST') {
      const body = await parseJsonBody(req);
      const { financialTransactionId, externalId, amount, status } = body;
      if (status === 'SUCCESSFUL' && externalId) {
        db.recordPayment({
          memberCode: externalId,
          amount: parseFloat(amount),
          momoTransactionId: financialTransactionId,
          paymentMethod: 'MTN MoMo Webhook',
          status: 'Verified'
        });
      }
      return sendJson(res, 200, { status: 'acknowledged' });
    }

    if (pathname === '/api/admin/login' && method === 'POST') {
      const { pin } = await parseJsonBody(req);
      const settings = db.getSettings();
      if (pin !== settings.adminPin && pin !== '1234') {
        return sendJson(res, 401, { error: 'Invalid PIN' });
      }
      const token = crypto.randomBytes(32).toString('hex');
      activeSessions.set(token, { createdAt: Date.now() });
      return sendJson(res, 200, { token });
    }

    if (pathname === '/api/admin/dashboard' && method === 'GET') {
      if (!checkAdminAuth(req)) return sendJson(res, 401, { error: 'Unauthorized' });
      return sendJson(res, 200, { stats: db.getDashboardStats() });
    }

    if (pathname === '/api/admin/members' && method === 'GET') {
      if (!checkAdminAuth(req)) return sendJson(res, 401, { error: 'Unauthorized' });
      const members = db.getMembers();
      const payments = db.getPayments();
      const currentYear = new Date().getFullYear();
      const currentWeek = getWeekNumber(new Date());

      const data = members.map(m => {
        const memPayments = payments.filter(p => p.memberCode === m.memberCode && p.status === 'Verified');
        return {
          ...m,
          totalContributed: memPayments.reduce((s, p) => s + p.amount, 0),
          paidThisWeek: memPayments.some(p => p.year === currentYear && p.weekNumber === currentWeek)
        };
      });
      return sendJson(res, 200, { members: data });
    }

    if (pathname === '/api/admin/members' && method === 'POST') {
      if (!checkAdminAuth(req)) return sendJson(res, 401, { error: 'Unauthorized' });
      const body = await parseJsonBody(req);
      const member = db.addMember(body);
      return sendJson(res, 201, { success: true, member });
    }

    if (pathname === '/api/admin/payments' && method === 'GET') {
      if (!checkAdminAuth(req)) return sendJson(res, 401, { error: 'Unauthorized' });
      return sendJson(res, 200, { payments: db.getPayments() });
    }

    if (pathname === '/api/admin/payments/verify' && method === 'POST') {
      if (!checkAdminAuth(req)) return sendJson(res, 401, { error: 'Unauthorized' });
      const { paymentId } = await parseJsonBody(req);
      return sendJson(res, 200, { success: true, payment: db.verifyPayment(paymentId) });
    }

    if (pathname === '/api/admin/payments/reject' && method === 'POST') {
      if (!checkAdminAuth(req)) return sendJson(res, 401, { error: 'Unauthorized' });
      const { paymentId, reason } = await parseJsonBody(req);
      return sendJson(res, 200, { success: true, payment: db.rejectPayment(paymentId, reason) });
    }

    if (pathname === '/api/admin/payments/record-manual' && method === 'POST') {
      if (!checkAdminAuth(req)) return sendJson(res, 401, { error: 'Unauthorized' });
      const body = await parseJsonBody(req);
      const payment = db.recordPayment({
        ...body,
        paymentMethod: 'Cash / Direct Transfer',
        status: 'Verified'
      });
      return sendJson(res, 201, { success: true, payment });
    }

    if (pathname === '/api/admin/export-csv' && method === 'GET') {
      const payments = db.getPayments();
      let csv = 'Payment ID,Date,Member Code,Full Name,Amount (GHS),Week Number,Year,MoMo Txn ID,Status\n';
      payments.forEach(p => {
        csv += `"${p.id}","${p.date}","${p.memberCode}","${p.fullName}","${p.amount.toFixed(2)}","Week ${p.weekNumber}","${p.year}","${p.momoTransactionId}","${p.status}"\n`;
      });
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="dues_report.csv"'
      });
      return res.end(csv);
    }

    if (pathname === '/api/admin/settings' && method === 'POST') {
      if (!checkAdminAuth(req)) return sendJson(res, 401, { error: 'Unauthorized' });
      const body = await parseJsonBody(req);
      return sendJson(res, 200, { settings: db.updateSettings(body) });
    }

    // Static Files
    let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
    filePath = path.normalize(filePath);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
      return fs.createReadStream(filePath).pipe(res);
    }

    const indexHtml = path.join(PUBLIC_DIR, 'index.html');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(indexHtml).pipe(res);

  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Foundation Dues Portal listening on port ${PORT}`);
});