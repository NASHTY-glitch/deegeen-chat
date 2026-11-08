// Deegeen Chat — backend server.
// One Node process: REST API + WebSocket + serves the phone web client from ../public.
// Storage: Turso (hosted SQLite) when TURSO_DATABASE_URL is set — data then
// survives restarts and redeploys — otherwise a local node:sqlite file.
// Passwords: scrypt hashes only.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { WebSocketServer } from 'ws';

const scryptAsync = promisify(scrypt);

export const APP_NAME = 'Deegeen Chat'; // <-- rename the app here (one place)

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const DATA_DIR = process.env.CHAT_DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const PORT = process.env.PORT || 3000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // ~8MB decoded photo cap (client also compresses before sending)
const MAX_BODY_BYTES = 16 * 1024 * 1024;

// ---------- database ----------
// Small async store interface over two backends: get(sql, params),
// all(sql, params), run(sql, params) -> { lastInsertRowid }.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    phone TEXT NOT NULL,
    pass_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender TEXT NOT NULL,
    recipient TEXT NOT NULL,
    text TEXT,
    image TEXT,
    state TEXT NOT NULL DEFAULT 'sent',
    created_at INTEGER NOT NULL
  )`,
];

async function createStore() {
  if (process.env.TURSO_DATABASE_URL) {
    const { createClient } = await import('@libsql/client');
    const client = createClient({
      url: process.env.TURSO_DATABASE_URL,
      authToken: process.env.TURSO_AUTH_TOKEN || '',
    });
    const norm = (v) => (typeof v === 'bigint' ? Number(v) : v);
    const rowsOf = (rs) =>
      rs.rows.map((r) => {
        const o = {};
        for (const c of rs.columns) o[c] = norm(r[c]);
        return o;
      });
    const store = {
      async get(sql, params = []) {
        const rs = await client.execute({ sql, args: params });
        return rowsOf(rs)[0];
      },
      async all(sql, params = []) {
        const rs = await client.execute({ sql, args: params });
        return rowsOf(rs);
      },
      async run(sql, params = []) {
        const rs = await client.execute({ sql, args: params });
        return { lastInsertRowid: rs.lastInsertRowid != null ? Number(rs.lastInsertRowid) : null };
      },
    };
    for (const stmt of SCHEMA) await client.execute(stmt);
    console.log('storage: Turso (persistent)');
    return store;
  }
  const db = new DatabaseSync(path.join(DATA_DIR, 'chat.db'));
  for (const stmt of SCHEMA) db.exec(stmt);
  console.log('storage: local sqlite file');
  return {
    async get(sql, params = []) { return db.prepare(sql).get(...params); },
    async all(sql, params = []) { return db.prepare(sql).all(...params); },
    async run(sql, params = []) {
      const info = db.prepare(sql).run(...params);
      return { lastInsertRowid: Number(info.lastInsertRowid) };
    },
  };
}

const store = await createStore();

// ---------- helpers ----------
async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 64);
  return salt.toString('hex') + ':' + key.toString('hex');
}

async function verifyPassword(password, stored) {
  const [saltHex, keyHex] = stored.split(':');
  const key = await scryptAsync(password, Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(keyHex, 'hex');
  return key.length === expected.length && timingSafeEqual(key, expected);
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  return JSON.parse(raw);
}

async function authUser(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  const row = await store.get('SELECT username FROM sessions WHERE token = ?', [token]);
  return row ? row.username : null;
}

function msgRowToObj(r) {
  return {
    id: r.id,
    from: r.sender,
    to: r.recipient,
    text: r.text,
    image: r.image,
    state: r.state,
    createdAt: r.created_at,
  };
}

// ---------- live sockets ----------
const sockets = new Map(); // username -> Set<WebSocket>

function pushTo(username, payload) {
  const set = sockets.get(username);
  if (!set) return false;
  let sent = false;
  const data = JSON.stringify(payload);
  for (const ws of set) {
    if (ws.readyState === 1) {
      ws.send(data);
      sent = true;
    }
  }
  return sent;
}

function isOnline(username) {
  const set = sockets.get(username);
  if (!set) return false;
  for (const ws of set) if (ws.readyState === 1) return true;
  return false;
}

// Mark a message delivered if the recipient is online, push it, and receipt the sender.
async function deliverMessage(msg) {
  if (msg.state !== 'sent') return msg;
  if (!isOnline(msg.to)) return msg;
  pushTo(msg.to, { type: 'message', message: msg });
  await store.run("UPDATE messages SET state = 'delivered' WHERE id = ?", [msg.id]);
  const updated = { ...msg, state: 'delivered' };
  pushTo(msg.from, { type: 'receipt', ids: [msg.id], state: 'delivered', with: msg.to });
  return updated;
}

// When a user connects, deliver anything waiting for them.
async function deliverPending(username) {
  const rows = await store.all(
    "SELECT * FROM messages WHERE recipient = ? AND state = 'sent' ORDER BY id ASC",
    [username]
  );
  for (const r of rows) await deliverMessage(msgRowToObj(r));
}

// ---------- REST ----------
async function handleApi(req, res, url) {
  const route = url.pathname;

  if (req.method === 'POST' && route === '/api/register') {
    const { username, phone, password } = await readJson(req);
    if (!username || !phone || !password)
      return sendJson(res, 400, { error: 'username, phone and password are required' });
    if (!/^[a-zA-Z0-9_.-]{3,24}$/.test(username))
      return sendJson(res, 400, { error: 'username must be 3-24 chars: letters, numbers, _ . -' });
    if (String(password).length < 4)
      return sendJson(res, 400, { error: 'password/PIN must be at least 4 characters' });
    const existing = await store.get('SELECT username FROM users WHERE username = ?', [username]);
    if (existing) return sendJson(res, 409, { error: 'username already taken' });
    const passHash = await hashPassword(String(password));
    await store.run(
      'INSERT INTO users (username, phone, pass_hash, created_at) VALUES (?, ?, ?, ?)',
      [username, String(phone), passHash, Date.now()]
    );
    const token = randomBytes(32).toString('hex');
    await store.run('INSERT INTO sessions (token, username, created_at) VALUES (?, ?, ?)',
      [token, username, Date.now()]);
    return sendJson(res, 201, { token, username });
  }

  if (req.method === 'POST' && route === '/api/login') {
    const { username, password } = await readJson(req);
    const user = await store.get('SELECT * FROM users WHERE username = ?', [username || '']);
    if (!user || !(await verifyPassword(String(password || ''), user.pass_hash)))
      return sendJson(res, 401, { error: 'wrong username or password' });
    const token = randomBytes(32).toString('hex');
    await store.run('INSERT INTO sessions (token, username, created_at) VALUES (?, ?, ?)',
      [token, username, Date.now()]);
    return sendJson(res, 200, { token, username });
  }

  // everything below requires auth
  const me = await authUser(req);
  if (!me) return sendJson(res, 401, { error: 'not logged in' });

  if (req.method === 'GET' && route === '/api/users') {
    const rows = await store.all(
      'SELECT username, phone FROM users WHERE username != ? ORDER BY username ASC', [me]);
    return sendJson(res, 200, { users: rows });
  }

  if (req.method === 'GET' && route === '/api/conversations') {
    // Last message + unread count per other user, for the chat list.
    const others = (await store.all('SELECT username FROM users WHERE username != ?', [me]))
      .map((r) => r.username);
    const convs = [];
    for (const other of others) {
      const last = await store.get(
        `SELECT * FROM messages
         WHERE (sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?)
         ORDER BY id DESC LIMIT 1`,
        [me, other, other, me]);
      if (!last) continue;
      const unreadRow = await store.get(
        "SELECT COUNT(*) AS n FROM messages WHERE sender = ? AND recipient = ? AND state != 'read'",
        [other, me]);
      convs.push({ with: other, last: msgRowToObj(last), unread: unreadRow.n });
    }
    convs.sort((a, b) => b.last.id - a.last.id);
    return sendJson(res, 200, { conversations: convs });
  }

  if (req.method === 'GET' && route === '/api/messages') {
    const other = url.searchParams.get('with');
    if (!other) return sendJson(res, 400, { error: 'missing ?with=<username>' });
    const rows = await store.all(
      `SELECT * FROM messages
       WHERE (sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?)
       ORDER BY id ASC`,
      [me, other, other, me]);
    return sendJson(res, 200, { messages: rows.map(msgRowToObj) });
  }

  if (req.method === 'POST' && route === '/api/messages') {
    const { to, text, image } = await readJson(req);
    if (!to) return sendJson(res, 400, { error: 'missing recipient' });
    if (!text && !image) return sendJson(res, 400, { error: 'empty message' });
    const recipient = await store.get('SELECT username FROM users WHERE username = ?', [to]);
    if (!recipient) return sendJson(res, 404, { error: 'recipient not found' });
    if (image) {
      if (typeof image !== 'string' || !image.startsWith('data:image/'))
        return sendJson(res, 400, { error: 'image must be a data URL' });
      const approxBytes = Math.floor((image.length * 3) / 4);
      if (approxBytes > MAX_IMAGE_BYTES)
        return sendJson(res, 413, { error: 'photo too large (max ~8MB)' });
    }
    const info = await store.run(
      "INSERT INTO messages (sender, recipient, text, image, state, created_at) VALUES (?, ?, ?, ?, 'sent', ?)",
      [me, to, text || null, image || null, Date.now()]);
    const row = await store.get('SELECT * FROM messages WHERE id = ?', [info.lastInsertRowid]);
    const msg = await deliverMessage(msgRowToObj(row));
    return sendJson(res, 201, { message: msg });
  }

  if (req.method === 'POST' && route === '/api/messages/read') {
    const { with: other } = await readJson(req);
    if (!other) return sendJson(res, 400, { error: 'missing conversation user' });
    const rows = await store.all(
      "SELECT id FROM messages WHERE sender = ? AND recipient = ? AND state != 'read'",
      [other, me]);
    if (rows.length) {
      await store.run(
        "UPDATE messages SET state = 'read' WHERE sender = ? AND recipient = ? AND state != 'read'",
        [other, me]);
      const ids = rows.map((r) => r.id);
      pushTo(other, { type: 'receipt', ids, state: 'read', with: me });
    }
    return sendJson(res, 200, { ok: true, marked: rows.length });
  }

  return sendJson(res, 404, { error: 'unknown route' });
}

// ---------- static client ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, url) {
  let rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (err) {
    return sendJson(res, 500, { error: String(err && err.message || err) });
  }
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', async (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/ws') return socket.destroy();
  const token = url.searchParams.get('token');
  const row = token && (await store.get('SELECT username FROM sessions WHERE token = ?', [token]));
  if (!row) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.username = row.username;
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws) => {
  const username = ws.username;
  if (!sockets.has(username)) sockets.set(username, new Set());
  sockets.get(username).add(ws);
  ws.send(JSON.stringify({ type: 'hello', app: APP_NAME, username }));
  deliverPending(username).catch(() => {});
  ws.on('close', () => {
    const set = sockets.get(username);
    if (set) {
      set.delete(ws);
      if (!set.size) sockets.delete(username);
    }
  });
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, () => {
    console.log(`${APP_NAME} server listening on http://localhost:${PORT}`);
  });
}

export { server };
