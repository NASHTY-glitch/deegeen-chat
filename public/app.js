// Deegeen Chat — phone web client. Plain JS, no framework.
// Talks to the same server that served this page: REST + WebSocket, polling fallback.

const APP_NAME = 'Deegeen Chat'; // must match the backend's APP_NAME

const $ = (id) => document.getElementById(id);

let token = localStorage.getItem('dc_token') || null;
let me = localStorage.getItem('dc_username') || null;
let currentChat = null; // username we are chatting with
let knownMessages = new Map(); // id -> message (for current chat)
let ws = null;

// ---------- API ----------
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

// ---------- screens ----------
function show(screenId) {
  for (const id of ['screen-auth', 'screen-list', 'screen-chat'])
    $(id).classList.toggle('hidden', id !== screenId);
}

// ---------- auth ----------
$('tab-login').onclick = () => setAuthTab('login');
$('tab-register').onclick = () => setAuthTab('register');
function setAuthTab(which) {
  $('tab-login').classList.toggle('active', which === 'login');
  $('tab-register').classList.toggle('active', which === 'register');
  $('form-login').classList.toggle('hidden', which !== 'login');
  $('form-register').classList.toggle('hidden', which !== 'register');
  $('auth-error').textContent = '';
}

$('form-register').onsubmit = async (e) => {
  e.preventDefault();
  try {
    const data = await api('POST', '/api/register', {
      username: $('reg-username').value.trim(),
      phone: $('reg-phone').value.trim(),
      password: $('reg-password').value,
    });
    onLoggedIn(data);
  } catch (err) { $('auth-error').textContent = err.message; }
};

$('form-login').onsubmit = async (e) => {
  e.preventDefault();
  try {
    const data = await api('POST', '/api/login', {
      username: $('login-username').value.trim(),
      password: $('login-password').value,
    });
    onLoggedIn(data);
  } catch (err) { $('auth-error').textContent = err.message; }
};

function onLoggedIn(data) {
  token = data.token;
  me = data.username;
  localStorage.setItem('dc_token', token);
  localStorage.setItem('dc_username', me);
  $('me-label').textContent = '@' + me;
  connectWs();
  openList();
}

$('btn-logout').onclick = () => {
  token = null; me = null; currentChat = null;
  localStorage.removeItem('dc_token');
  localStorage.removeItem('dc_username');
  if (ws) ws.close();
  show('screen-auth');
};

// ---------- chat list ----------
function fmtTime(ts) {
  const d = new Date(ts);
  const today = new Date();
  if (d.toDateString() === today.toDateString())
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

function ticksHtml(m) {
  if (m.from !== me) return '';
  if (m.state === 'read') return '<span class="ticks read">✓✓</span>';
  if (m.state === 'delivered') return '<span class="ticks">✓✓</span>';
  return '<span class="ticks">✓</span>';
}

async function openList() {
  show('screen-list');
  currentChat = null;
  await refreshList();
}

async function refreshList() {
  if (!token || currentChat) return;
  try {
    const [{ conversations }, { users }] = await Promise.all([
      api('GET', '/api/conversations'),
      api('GET', '/api/users'),
    ]);
    const list = $('chat-list');
    list.innerHTML = '';
    $('list-empty').classList.toggle('hidden', conversations.length > 0);
    for (const c of conversations) {
      const row = document.createElement('div');
      row.className = 'chat-row';
      const lastText = c.last.image ? '📷 Photo' : (c.last.text || '');
      row.innerHTML = `
        <div class="avatar">${escapeHtml(c.with[0] || '?')}</div>
        <div class="row-main">
          <div class="row-top"><span class="row-name">${escapeHtml(c.with)}</span>
          <span class="row-time">${fmtTime(c.last.createdAt)}</span></div>
          <div class="row-last">${ticksHtml(c.last)} ${escapeHtml(lastText)}</div>
        </div>
        ${c.unread ? `<div class="unread-badge">${c.unread}</div>` : ''}`;
      row.onclick = () => openChat(c.with);
      list.appendChild(row);
    }
    const ulist = $('user-list');
    ulist.innerHTML = '';
    $('users-empty').classList.toggle('hidden', users.length > 0);
    for (const u of users) {
      const row = document.createElement('div');
      row.className = 'chat-row';
      row.innerHTML = `
        <div class="avatar">${escapeHtml(u.username[0] || '?')}</div>
        <div class="row-main">
          <div class="row-name">${escapeHtml(u.username)}</div>
          <div class="row-last">${escapeHtml(u.phone)}</div>
        </div>`;
      row.onclick = () => openChat(u.username);
      ulist.appendChild(row);
    }
  } catch (err) {
    if (String(err.message).includes('not logged in')) $('btn-logout').click();
  }
}

// ---------- chat screen ----------
async function openChat(username) {
  currentChat = username;
  knownMessages = new Map();
  $('chat-title').textContent = username;
  $('messages').innerHTML = '';
  show('screen-chat');
  await loadMessages();
  await api('POST', '/api/messages/read', { with: username }).catch(() => {});
}

$('btn-back').onclick = () => openList();

async function loadMessages() {
  if (!currentChat) return;
  const { messages } = await api('GET', '/api/messages?with=' + encodeURIComponent(currentChat));
  for (const m of messages) addOrUpdateBubble(m);
  scrollToBottom();
}

function scrollToBottom() {
  const box = $('messages');
  box.scrollTop = box.scrollHeight;
}

function addOrUpdateBubble(m) {
  const existing = knownMessages.get(m.id);
  knownMessages.set(m.id, m);
  const box = $('messages');
  let el = box.querySelector(`[data-mid="${m.id}"]`);
  if (!el) {
    el = document.createElement('div');
    el.dataset.mid = m.id;
    box.appendChild(el);
  }
  el.className = 'bubble ' + (m.from === me ? 'mine' : 'theirs');
  el.innerHTML = `
    ${m.image ? `<img src="${m.image}" alt="photo">` : ''}
    ${m.text ? `<div>${escapeHtml(m.text)}</div>` : ''}
    <div class="bubble-meta"><span>${fmtTime(m.createdAt)}</span>${ticksHtml(m)}</div>`;
  if (!existing) scrollToBottom();
}

$('form-send').onsubmit = async (e) => {
  e.preventDefault();
  const text = $('input-text').value.trim();
  if (!text || !currentChat) return;
  $('input-text').value = '';
  try {
    const { message } = await api('POST', '/api/messages', { to: currentChat, text });
    addOrUpdateBubble(message);
  } catch (err) { alert(err.message); }
};

$('file-photo').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || !currentChat) return;
  if (file.size > 1.5 * 1024 * 1024) { alert('Photo too large (max ~1.5MB)'); return; }
  const dataUrl = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
  try {
    const { message } = await api('POST', '/api/messages', { to: currentChat, image: dataUrl });
    addOrUpdateBubble(message);
  } catch (err) { alert(err.message); }
};

// ---------- websocket ----------
function connectWs() {
  if (!token) return;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws?token=${encodeURIComponent(token)}`);
  ws.onmessage = (ev) => {
    let data;
    try { data = JSON.parse(ev.data); } catch { return; }
    if (data.type === 'message') {
      const m = data.message;
      if (currentChat === m.from) {
        addOrUpdateBubble(m);
        api('POST', '/api/messages/read', { with: m.from }).catch(() => {});
      } else {
        refreshList();
      }
    } else if (data.type === 'receipt') {
      if (currentChat === data.with) {
        for (const id of data.ids) {
          const m = knownMessages.get(id);
          if (m) addOrUpdateBubble({ ...m, state: data.state });
        }
      }
    }
  };
  ws.onclose = () => { ws = null; setTimeout(connectWs, 3000); };
  ws.onerror = () => { try { ws.close(); } catch {} };
}

// ---------- polling fallback (every ~3s) ----------
setInterval(() => {
  if (!token) return;
  if (currentChat) loadMessages().catch(() => {});
  else refreshList();
}, 3000);

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ---------- boot ----------
document.title = APP_NAME;
if (token && me) {
  $('me-label').textContent = '@' + me;
  connectWs();
  openList();
} else {
  show('screen-auth');
}
