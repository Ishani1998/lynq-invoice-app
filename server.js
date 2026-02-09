const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const PDFDocument = require('pdfkit');
require('dotenv').config();

const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'data', 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER || '';
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_SECURE = String(process.env.SMTP_SECURE || 'true') === 'true';
const APP_BASE_URL = process.env.APP_BASE_URL || `http://localhost:${PORT}`;

const mailer = SMTP_USER && SMTP_PASS ? nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_SECURE,
  auth: { user: SMTP_USER, pass: SMTP_PASS }
}) : null;

function readDb() {
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    return { admin: null, clients: [], invoices: [], reminders: [], messages: [] };
  }
}

function writeDb(db) {
  const tmp = DB_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_PATH);
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e7) req.destroy();
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
    });
  });
}

function id() {
  return crypto.randomUUID();
}

function nowIso() {
  return new Date().toISOString();
}

function buildPaymentLink(invoiceId) {
  return `/pay/${invoiceId}`;
}

function sanitizeAdmin(admin) {
  if (!admin) return null;
  const { passwordHash, passwordSalt, sessionToken, ...safe } = admin;
  return safe;
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function checkAuth(req, db) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice(7);
  return Boolean(db.admin && db.admin.sessionToken && token === db.admin.sessionToken);
}

function buildReminderMessage({ language, tone, invoice, client, business }) {
  const lang = (language || 'en').toLowerCase();
  const amt = `${invoice.currency || 'USD'} ${invoice.amount}`;
  const due = invoice.dueDate ? new Date(invoice.dueDate).toLocaleDateString('en-US') : 'soon';
  const biz = business?.businessName || 'LYNQ';

  const templates = {
    en: {
      gentle: `Hi ${client.name}, friendly reminder from ${biz}: invoice ${invoice.number} for ${amt} is due on ${due}. If you've already paid, thank you!`,
      funny: `Hi ${client.name}! This is ${biz}'s invoice ${invoice.number} for ${amt}. Its due ${due}. Our coffee is getting nervous without it.`,
      firm: `Hi ${client.name}, this is a reminder that invoice ${invoice.number} for ${amt} is due on ${due}. Please arrange payment. Thanks.`,
      ethical: `Hi ${client.name}, just a respectful reminder from ${biz}: invoice ${invoice.number} for ${amt} is due on ${due}. Let us know if you need anything.`
    },
    es: {
      gentle: `Hola ${client.name}, recordatorio amable de ${biz}: la factura ${invoice.number} por ${amt} vence el ${due}. Gracias.`,
      funny: `Hola ${client.name}! La factura ${invoice.number} por ${amt} vence el ${due}. Nuestro cafe ya esta preparando el recibo.`,
      firm: `Hola ${client.name}, la factura ${invoice.number} por ${amt} vence el ${due}. Por favor realiza el pago.`,
      ethical: `Hola ${client.name}, un recordatorio respetuoso de ${biz}: la factura ${invoice.number} por ${amt} vence el ${due}.`
    },
    fr: {
      gentle: `Bonjour ${client.name}, petit rappel de ${biz} : la facture ${invoice.number} de ${amt} est due le ${due}. Merci.`,
      funny: `Bonjour ${client.name}! La facture ${invoice.number} de ${amt} est due le ${due}. Notre cafe commence a s'inquieter.`,
      firm: `Bonjour ${client.name}, la facture ${invoice.number} de ${amt} est due le ${due}. Merci de proceder au paiement.`,
      ethical: `Bonjour ${client.name}, rappel respectueux de ${biz} : la facture ${invoice.number} de ${amt} est due le ${due}.`
    },
    hi: {
      gentle: `Namaste ${client.name}, ${biz} se vinamra yaad dilana: invoice ${invoice.number} ${amt} ka due ${due} hai. Shukriya.`,
      funny: `Namaste ${client.name}! ${biz} ka invoice ${invoice.number} (${amt}) ${due} ko due hai. Hamara coffee cup bhi follow-up kar raha hai.`,
      firm: `Namaste ${client.name}, invoice ${invoice.number} (${amt}) ${due} ko due hai. Kripya payment karen.`,
      ethical: `Namaste ${client.name}, ${biz} se vinamra reminder: invoice ${invoice.number} (${amt}) ${due} ko due hai. Dhanyavaad.`
    }
  };

  const toneKey = (tone || 'ethical').toLowerCase();
  const bucket = templates[lang] || templates.en;
  return bucket[toneKey] || bucket.ethical || templates.en.ethical;
}

function buildFormalEmail({ invoice, client, business }) {
  const biz = business?.businessName || 'LYNQ';
  const description = invoice.description || 'invoice';
  const amount = `${invoice.currency || 'USD'} ${invoice.amount}`;
  const due = invoice.dueDate ? new Date(invoice.dueDate).toLocaleDateString('en-US') : 'soon';
  const payUrl = `${APP_BASE_URL}${invoice.paymentLink}`;
  const subject = `Payment due: ${description} (${invoice.number})`;

  const text = [
    `Dear ${client.name},`,
    '',
    `Trust you're doing well.`,
    '',
    `Just a respectful reminder that your payment for the ${description} (Invoice ${invoice.number}) totaling ${amount} is due on ${due}.`,
    `Pay at the earliest to avoid involvement with higher authorities and management.`,
    '',
    `Payment link: ${payUrl}`,
    '',
    `Best,`,
    `Team ${biz}`
  ].join('\n');

  const html = `
    <div style="font-family: Arial, sans-serif; color:#111; line-height:1.5;">
      <p>Dear ${client.name},</p>
      <p>Trust you're doing well.</p>
      <p>Just a respectful reminder that your payment for the ${description} (Invoice ${invoice.number}) totaling <strong>${amount}</strong> is due on <strong>${due}</strong>.</p>
      <p>Pay at the earliest to avoid involvement with higher authorities and management.</p>
      <p>
        <a href="${payUrl}" style="display:inline-block; padding:12px 18px; background:#111; color:#fff; text-decoration:none; border-radius:6px;">
          Pay Now
        </a>
      </p>
      <p>Best,<br/>Team ${biz}</p>
    </div>
  `;

  return { subject, text, html };
}

function buildInvoicePdf({ invoice, client, business }) {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  doc.on('end', () => {});

  const biz = business?.businessName || 'LYNQ';
  doc.fontSize(20).text(`${biz} Invoice`, { align: 'right' });
  doc.moveDown();
  doc.fontSize(12).text(`Invoice Number: ${invoice.number}`);
  doc.text(`Issue Date: ${new Date(invoice.createdAt).toLocaleDateString('en-US')}`);
  doc.text(`Due Date: ${invoice.dueDate || 'n/a'}`);
  doc.moveDown();
  doc.text(`Billed To: ${client.name}`);
  if (client.email) doc.text(`Email: ${client.email}`);
  if (client.phone) doc.text(`Phone: ${client.phone}`);
  doc.moveDown();
  doc.text(`Description: ${invoice.description || 'n/a'}`);
  doc.text(`Amount: ${invoice.currency || 'USD'} ${invoice.amount}`);
  doc.moveDown();
  doc.text(`Status: ${invoice.status}`);
  doc.end();

  return new Promise((resolve) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let pathname = url.pathname;
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.join(PUBLIC_DIR, pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not Found');
    }
    const ext = path.extname(filePath).toLowerCase();
    const type = ext === '.js' ? 'application/javascript'
      : ext === '.css' ? 'text/css'
      : 'text/html';
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
}

function renderPayPage(invoice, business) {
  const safeBiz = business?.businessName || 'LYNQ';
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Pay Invoice</title>
  <style>
    body { font-family: Arial, sans-serif; background:#f6f6f6; margin:0; padding:40px; }
    .card { max-width:520px; margin:0 auto; background:#fff; border-radius:12px; padding:24px; box-shadow:0 8px 30px rgba(0,0,0,0.08); }
    button { background:#111; color:#fff; border:none; padding:12px 16px; border-radius:8px; cursor:pointer; }
  </style>
</head>
<body>
  <div class="card">
    <h2>${safeBiz} - Invoice ${invoice.number}</h2>
    <p>Amount: ${invoice.currency || 'USD'} ${invoice.amount}</p>
    <p>Status: ${invoice.status}</p>
    <form method="POST">
      <button type="submit">Mark as Paid (Mock)</button>
    </form>
  </div>
</body>
</html>`;
}

function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split('/').filter(Boolean);

  if (req.method === 'POST' && url.pathname === '/api/login') {
    return readBody(req).then((body) => {
      const db = readDb();
      if (!db.admin || !db.admin.passwordHash || !db.admin.passwordSalt) {
        return json(res, 400, { error: 'Admin password not set yet.' });
      }
      const computed = hashPassword(String(body.password || ''), db.admin.passwordSalt);
      if (computed !== db.admin.passwordHash) {
        return json(res, 401, { error: 'Invalid password' });
      }
      const token = crypto.randomUUID();
      db.admin.sessionToken = token;
      db.admin.lastLoginAt = nowIso();
      writeDb(db);
      return json(res, 200, { token });
    }).catch(() => json(res, 400, { error: 'Invalid JSON' }));
  }

  if (req.method === 'GET' && url.pathname === '/api/state') {
    const db = readDb();
    if (db.admin && !checkAuth(req, db)) {
      return json(res, 401, { error: 'Unauthorized' });
    }
    return json(res, 200, { ...db, admin: sanitizeAdmin(db.admin) });
  }

  if (req.method === 'POST' && url.pathname === '/api/admin') {
    return readBody(req).then((body) => {
      const db = readDb();
      if (db.admin && !checkAuth(req, db)) {
        return json(res, 401, { error: 'Unauthorized' });
      }
      db.admin = {
        id: db.admin?.id || id(),
        businessName: body.businessName || 'LYNQ',
        bankAccountName: body.bankAccountName || '',
        bankAccountNumber: body.bankAccountNumber || '',
        ifsc: body.ifsc || '',
        pan: body.pan || '',
        email: body.email || '',
        phone: body.phone || '',
        address: body.address || '',
        passwordSalt: db.admin?.passwordSalt || (body.password ? crypto.randomBytes(16).toString('hex') : ''),
        passwordHash: db.admin?.passwordHash || '',
        sessionToken: db.admin?.sessionToken || '',
        updatedAt: nowIso()
      };
      if (body.password) {
        db.admin.passwordSalt = crypto.randomBytes(16).toString('hex');
        db.admin.passwordHash = hashPassword(String(body.password), db.admin.passwordSalt);
      }
      writeDb(db);
      return json(res, 200, sanitizeAdmin(db.admin));
    }).catch(() => json(res, 400, { error: 'Invalid JSON' }));
  }

  if (req.method === 'POST' && url.pathname === '/api/clients') {
    const db = readDb();
    if (db.admin && !checkAuth(req, db)) {
      return json(res, 401, { error: 'Unauthorized' });
    }
    return readBody(req).then((body) => {
      const client = {
        id: id(),
        name: body.name || 'Client',
        email: body.email || '',
        phone: body.phone || '',
        language: body.language || 'en',
        createdAt: nowIso()
      };
      db.clients.push(client);
      writeDb(db);
      return json(res, 200, client);
    }).catch(() => json(res, 400, { error: 'Invalid JSON' }));
  }

  if (req.method === 'POST' && url.pathname === '/api/invoices') {
    const db = readDb();
    if (db.admin && !checkAuth(req, db)) {
      return json(res, 401, { error: 'Unauthorized' });
    }
    return readBody(req).then((body) => {
      const client = db.clients.find((c) => c.id === body.clientId);
      if (!client) return json(res, 400, { error: 'Client not found' });
      const invoiceId = id();
      const invoice = {
        id: invoiceId,
        number: body.number || `INV-${Date.now()}`,
        clientId: client.id,
        amount: Number(body.amount || 0),
        currency: body.currency || 'USD',
        dueDate: body.dueDate || '',
        description: body.description || '',
        status: 'unpaid',
        paymentLink: buildPaymentLink(invoiceId),
        createdAt: nowIso()
      };
      db.invoices.push(invoice);
      writeDb(db);
      return json(res, 200, invoice);
    }).catch(() => json(res, 400, { error: 'Invalid JSON' }));
  }

  if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'invoices' && parts[3] === 'mark-paid') {
    const invoiceId = parts[2];
    const db = readDb();
    if (db.admin && !checkAuth(req, db)) {
      return json(res, 401, { error: 'Unauthorized' });
    }
    const invoice = db.invoices.find((i) => i.id === invoiceId);
    if (!invoice) return json(res, 404, { error: 'Invoice not found' });
    invoice.status = 'paid';
    invoice.paidAt = nowIso();
    writeDb(db);
    return json(res, 200, invoice);
  }

  if (req.method === 'POST' && url.pathname === '/api/reminders') {
    const db = readDb();
    if (db.admin && !checkAuth(req, db)) {
      return json(res, 401, { error: 'Unauthorized' });
    }
    return readBody(req).then((body) => {
      const invoice = db.invoices.find((i) => i.id === body.invoiceId);
      if (!invoice) return json(res, 400, { error: 'Invoice not found' });
      const reminder = {
        id: id(),
        invoiceId: invoice.id,
        scheduleAt: body.scheduleAt || nowIso(),
        channelSms: Boolean(body.channelSms),
        channelEmail: Boolean(body.channelEmail),
        tone: body.tone || 'ethical',
        language: body.language || null,
        status: 'scheduled',
        createdAt: nowIso(),
        lastSentAt: null
      };
      db.reminders.push(reminder);
      writeDb(db);
      return json(res, 200, reminder);
    }).catch(() => json(res, 400, { error: 'Invalid JSON' }));
  }

  if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'reminders' && parts[3] === 'send-now') {
    const reminderId = parts[2];
    const db = readDb();
    if (db.admin && !checkAuth(req, db)) {
      return json(res, 401, { error: 'Unauthorized' });
    }
    const reminder = db.reminders.find((r) => r.id === reminderId);
    if (!reminder) return json(res, 404, { error: 'Reminder not found' });
    const result = sendReminder(db, reminder);
    writeDb(db);
    return json(res, 200, result);
  }

  if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'reminders' && parts[3] === 'cancel') {
    const reminderId = parts[2];
    const db = readDb();
    if (db.admin && !checkAuth(req, db)) {
      return json(res, 401, { error: 'Unauthorized' });
    }
    const reminder = db.reminders.find((r) => r.id === reminderId);
    if (!reminder) return json(res, 404, { error: 'Reminder not found' });
    reminder.status = 'cancelled';
    writeDb(db);
    return json(res, 200, reminder);
  }

  json(res, 404, { error: 'Not Found' });
}

function sendReminder(db, reminder) {
  const invoice = db.invoices.find((i) => i.id === reminder.invoiceId);
  if (!invoice) return { error: 'Invoice not found' };
  const client = db.clients.find((c) => c.id === invoice.clientId);
  if (!client) return { error: 'Client not found' };
  const message = buildReminderMessage({
    language: reminder.language || client.language,
    tone: reminder.tone,
    invoice,
    client,
    business: db.admin
  });

  const channels = [];
  if (reminder.channelSms) channels.push('sms');
  if (reminder.channelEmail) channels.push('email');
  if (channels.length === 0) channels.push('sms');

  for (const channel of channels) {
    let provider = 'mock';
    if (channel === 'email' && mailer && client.email) {
      provider = 'smtp';
      const { subject, text, html } = buildFormalEmail({ invoice, client, business: db.admin });
      buildInvoicePdf({ invoice, client, business: db.admin }).then((pdfBuffer) => {
        mailer.sendMail({
          from: SMTP_FROM,
          to: client.email,
          subject,
          text,
          html,
          attachments: [
            {
              filename: `${invoice.number}.pdf`,
              content: pdfBuffer
            }
          ]
        }).catch(() => {});
      }).catch(() => {});
    }
    db.messages.push({
      id: id(),
      invoiceId: invoice.id,
      channel,
      to: channel === 'sms' ? client.phone : client.email,
      message,
      provider,
      sentAt: nowIso()
    });
  }

  reminder.status = 'sent';
  reminder.lastSentAt = nowIso();
  return { reminder, message };
}

function processDueReminders() {
  const db = readDb();
  const now = Date.now();
  let changed = false;
  for (const reminder of db.reminders) {
    if (reminder.status !== 'scheduled') continue;
    const due = Date.parse(reminder.scheduleAt || '');
    if (!Number.isNaN(due) && due <= now) {
      sendReminder(db, reminder);
      changed = true;
    }
  }
  if (changed) writeDb(db);
}

setInterval(processDueReminders, 30000);

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) return handleApi(req, res);

    if (url.pathname.startsWith('/pay/')) {
      const parts = url.pathname.split('/').filter(Boolean);
      const invoiceId = parts[1];
      const db = readDb();
      const invoice = db.invoices.find((i) => i.id === invoiceId);
      if (!invoice) {
        res.writeHead(404);
        return res.end('Invoice not found');
      }
      if (req.method === 'POST') {
        invoice.status = 'paid';
        invoice.paidAt = nowIso();
        writeDb(db);
        res.writeHead(303, { Location: url.pathname });
        return res.end();
      }
      const html = renderPayPage(invoice, db.admin);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(html);
    }

    return serveStatic(req, res);
  } catch (err) {
    res.writeHead(500);
    res.end('Server error');
  }
});

server.listen(PORT, () => {
  console.log(`LYNQ Invoice app running at http://localhost:${PORT}`);
});
