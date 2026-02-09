const state = {
  admin: null,
  clients: [],
  invoices: [],
  reminders: [],
  messages: []
};

const adminForm = document.getElementById('admin-form');
const clientForm = document.getElementById('client-form');
const invoiceForm = document.getElementById('invoice-form');
const reminderForm = document.getElementById('reminder-form');
const loginForm = document.getElementById('login-form');
const loginPanel = document.getElementById('login-panel');
const loginSummary = document.getElementById('login-summary');
const appSections = document.getElementById('app-sections');
const logoutBtn = document.getElementById('logout-btn');
const testReminderBtn = document.getElementById('test-reminder-btn');

const adminSummary = document.getElementById('admin-summary');
const clientsList = document.getElementById('clients-list');
const invoicesList = document.getElementById('invoices-list');
const remindersList = document.getElementById('reminders-list');
const messagesList = document.getElementById('messages-list');

let authToken = localStorage.getItem('lynq_token') || '';

function setAuthUi({ isAuthed, hasAdmin }) {
  if (!hasAdmin) {
    loginPanel.classList.add('hidden');
    appSections.classList.remove('hidden');
    return;
  }
  if (isAuthed) {
    loginPanel.classList.add('hidden');
    appSections.classList.remove('hidden');
  } else {
    loginPanel.classList.remove('hidden');
    appSections.classList.add('hidden');
  }
}

async function apiFetch(path, options = {}) {
  const headers = options.headers ? { ...options.headers } : {};
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  const res = await fetch(path, { ...options, headers });
  if (res.status === 401) {
    setAuthUi({ isAuthed: false, hasAdmin: true });
    throw new Error('Unauthorized');
  }
  return res;
}

async function fetchState() {
  const res = await apiFetch('/api/state');
  const data = await res.json();
  Object.assign(state, data);
  setAuthUi({ isAuthed: Boolean(authToken), hasAdmin: Boolean(state.admin) });
  renderAll();
}

function setFormValues(form, values) {
  for (const [key, value] of Object.entries(values || {})) {
    const input = form.elements[key];
    if (!input) continue;
    input.value = value || '';
  }
}

function formToJson(form) {
  const data = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') {
      data[el.name] = el.checked;
    } else {
      data[el.name] = el.value;
    }
  }
  return data;
}

function renderAdmin() {
  if (state.admin) {
    setFormValues(adminForm, state.admin);
    adminSummary.textContent = `Admin saved for ${state.admin.businessName}. Last updated ${new Date(state.admin.updatedAt).toLocaleString()}.`;
  } else {
    adminSummary.textContent = 'No admin profile saved yet.';
  }
}

function renderClients() {
  clientsList.innerHTML = '';
  const clientSelect = invoiceForm.elements.clientId;
  clientSelect.innerHTML = '';
  state.clients.forEach((client) => {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <strong>${client.name}</strong>
      <span>${client.email || 'No email'} | ${client.phone || 'No phone'}</span>
      <span>Language: ${client.language}</span>
    `;
    clientsList.appendChild(card);

    const opt = document.createElement('option');
    opt.value = client.id;
    opt.textContent = `${client.name} (${client.language})`;
    clientSelect.appendChild(opt);
  });
}

function renderInvoices() {
  invoicesList.innerHTML = '';
  const invoiceSelect = reminderForm.elements.invoiceId;
  invoiceSelect.innerHTML = '';
  state.invoices.forEach((invoice) => {
    const client = state.clients.find((c) => c.id === invoice.clientId);
    const card = document.createElement('div');
    card.className = 'card';
    const payLink = invoice.paymentLink || '';
    card.innerHTML = `
      <strong>${invoice.number}</strong>
      <span>Client: ${client ? client.name : 'Unknown'}</span>
      <span>Amount: ${invoice.currency} ${invoice.amount}</span>
      <span>Due: ${invoice.dueDate || 'n/a'}</span>
      <span>Status: ${invoice.status}</span>
      <span>Pay Link: <a href="${payLink}" target="_blank">${payLink}</a></span>
      <div class="card-actions">
        <button class="secondary" data-action="mark-paid" data-id="${invoice.id}">Mark Paid</button>
      </div>
    `;
    invoicesList.appendChild(card);

    const opt = document.createElement('option');
    opt.value = invoice.id;
    opt.textContent = `${invoice.number} (${invoice.currency} ${invoice.amount})`;
    invoiceSelect.appendChild(opt);
  });
}

function renderReminders() {
  remindersList.innerHTML = '';
  state.reminders.forEach((reminder) => {
    const invoice = state.invoices.find((i) => i.id === reminder.invoiceId);
    const client = invoice ? state.clients.find((c) => c.id === invoice.clientId) : null;
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <strong>Reminder for ${invoice ? invoice.number : 'Unknown'}</strong>
      <span>Client: ${client ? client.name : 'Unknown'}</span>
      <span>Schedule: ${reminder.scheduleAt}</span>
      <span>Tone: ${reminder.tone} | Language: ${reminder.language || (client ? client.language : 'n/a')}</span>
      <span>Status: ${reminder.status}</span>
      <div class="card-actions">
        <button class="secondary" data-action="send-now" data-id="${reminder.id}">Send Now</button>
        <button class="secondary" data-action="cancel" data-id="${reminder.id}">Cancel</button>
      </div>
    `;
    remindersList.appendChild(card);
  });
}

function renderMessages() {
  messagesList.innerHTML = '';
  state.messages.slice().reverse().forEach((msg) => {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <strong>${msg.channel.toUpperCase()} to ${msg.to || 'n/a'}</strong>
      <span>${msg.message}</span>
      <span>Sent: ${new Date(msg.sentAt).toLocaleString()}</span>
    `;
    messagesList.appendChild(card);
  });
}

function renderAll() {
  renderAdmin();
  renderClients();
  renderInvoices();
  renderReminders();
  renderMessages();
}

adminForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = formToJson(adminForm);
  const res = await apiFetch('/api/admin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (res.ok) {
    if (!authToken && payload.password) {
      try {
        const loginRes = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: payload.password })
        });
        if (loginRes.ok) {
          const data = await loginRes.json();
          authToken = data.token;
          localStorage.setItem('lynq_token', authToken);
        }
      } catch (_) {}
    }
    adminForm.elements.password.value = '';
    await fetchState();
  }
});

clientForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = formToJson(clientForm);
  const res = await apiFetch('/api/clients', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (res.ok) {
    clientForm.reset();
    await fetchState();
  }
});

invoiceForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = formToJson(invoiceForm);
  const res = await apiFetch('/api/invoices', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (res.ok) {
    invoiceForm.reset();
    await fetchState();
  }
});

reminderForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = formToJson(reminderForm);
  if (!payload.scheduleAt) {
    payload.scheduleAt = new Date().toISOString();
  } else {
    payload.scheduleAt = new Date(payload.scheduleAt).toISOString();
  }
  const res = await apiFetch('/api/reminders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (res.ok) {
    reminderForm.reset();
    await fetchState();
  }
});

invoicesList.addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  if (btn.dataset.action === 'mark-paid') {
    await apiFetch(`/api/invoices/${btn.dataset.id}/mark-paid`, { method: 'POST' });
    await fetchState();
  }
});

remindersList.addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  if (btn.dataset.action === 'send-now') {
    await apiFetch(`/api/reminders/${btn.dataset.id}/send-now`, { method: 'POST' });
    await fetchState();
  }
  if (btn.dataset.action === 'cancel') {
    await apiFetch(`/api/reminders/${btn.dataset.id}/cancel`, { method: 'POST' });
    await fetchState();
  }
});

logoutBtn.addEventListener('click', () => {
  authToken = '';
  localStorage.removeItem('lynq_token');
  loginSummary.textContent = 'Logged out.';
  setAuthUi({ isAuthed: false, hasAdmin: Boolean(state.admin) });
});

testReminderBtn.addEventListener('click', async () => {
  const invoiceId = reminderForm.elements.invoiceId.value;
  if (!invoiceId) return;
  const payload = {
    invoiceId,
    scheduleAt: new Date().toISOString(),
    channelSms: false,
    channelEmail: true,
    tone: 'ethical',
    language: ''
  };
  const res = await apiFetch('/api/reminders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (res.ok) {
    const reminder = await res.json();
    await apiFetch(`/api/reminders/${reminder.id}/send-now`, { method: 'POST' });
    await fetchState();
  }
});

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = formToJson(loginForm);
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (res.ok) {
    const data = await res.json();
    authToken = data.token;
    localStorage.setItem('lynq_token', authToken);
    loginForm.reset();
    loginSummary.textContent = 'Login successful.';
    await fetchState();
  } else {
    loginSummary.textContent = 'Invalid password. Try again.';
  }
});

fetchState().catch(() => {
  setAuthUi({ isAuthed: false, hasAdmin: true });
});
