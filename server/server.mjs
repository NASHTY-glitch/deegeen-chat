// Deegeen Chat — backend server.
// One Node process: REST API + WebSocket + serves the phone web client from ../public.
// Storage: built-in node:sqlite. Passwords: scrypt hashes only. No external services.

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
const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024; // ~1.5MB decoded photo cap
const MAX_BODY_BYTES = 3 * 1024 * 1024;

// ---------- database ----------
const db = new DatabaseSync(path.join(DATA_DIR, 'chat.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    phone TEXT NOT NULL,
    pass_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender TEXT NOT NULL,
    recipient TEXT NOT NULL,
    text TEXT,
    image TEXT,
    state TEXT NOT NULL DEFAULT 'sent',  -- sent -> delivered -> read
    created_at INTEGER NOT NULL
  );
`);

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

function authUser(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  const row = db.prepare('SELECT username FROM sessions WHERE token = ?').get(token);
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
function deliverMessage(msg) {
  if (msg.state !== 'sent') return msg;
  if (!isOnline(msg.to)) return msg;
  pushTo(msg.to, { type: 'message', message: msg });
  db.prepare("UPDATE messages SET state = 'delivered' WHERE id = ?").run(msg.id);
  const updated = { ...msg, state: 'delivered' };
  pushTo(msg.from, { type: 'receipt', ids: [msg.id], state: 'delivered', with: msg.to });
  return updated;
}

// When a user connects, deliver anything waiting for them.
function deliverPending(username) {
  const rows = db
    .prepare("SELECT * FROM messages WHERE recipient = ? AND state = 'sent' ORDER BY id ASC")
    .all(username);
  for (const r of rows) deliverMessage(msgRowToObj(r));
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
    const existing = db.prepare('SELECT username FROM users WHERE username = ?').get(username);
    if (existing) return sendJson(res, 409, { error: 'username already taken' });
    const passHash = await hashPassword(String(password));
    db.prepare('INSERT INTO users (username, phone, pass_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(username, String(phone), passHash, Date.now());
    const token = randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions (token, username, created_at) VALUES (?, ?, ?)')
      .run(token, username, Date.now());
    return sendJson(res, 201, { token, username });
  }

  if (req.method === 'POST' && route === '/api/login') {
    const { username, password } = await readJson(req);
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username || '');
    if (!user || !(await verifyPassword(String(password || ''), user.pass_hash)))
      return sendJson(res, 401, { error: 'wrong username or password' });
    const token = randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions (token, username, created_at) VALUES (?, ?, ?)')
      .run(token, username, Date.now());
    return sendJson(res, 200, { token, username });
  }

  // everything below requires auth
  const me = authUser(req);
  if (!me) return sendJson(res, 401, { error: 'not logged in' });

  if (req.method === 'GET' && route === '/api/users') {
    const rows = db
      .prepare('SELECT username, phone FROM users WHERE username != ? ORDER BY username ASC')
      .all(me);
    return sendJson(res, 200, { users: rows });
  }

  if (req.method === 'GET' && route === '/api/conversations') {
    // Last message + unread count per other user, for the chat list.
    const others = db
      .prepare('SELECT username FROM users WHERE username != ?')
      .all(me)
      .map((r) => r.username);
    const convs = [];
    for (const other of others) {
      const last = db
        .prepare(
          `SELECT * FROM messages
           WHERE (sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?)
           ORDER BY id DESC LIMIT 1`
        )
        .get(me, other, other, me);
      if (!last) continue;
      const unread = db
        .prepare(
          "SELECT COUNT(*) AS n FROM messages WHERE sender = ? AND recipient = ? AND state != 'read'"
        )
        .get(other, me).n;
      convs.push({ with: other, last: msgRowToObj(last), unread });
    }
    convs.sort((a, b) => b.last.id - a.last.id);
    return sendJson(res, 200, { conversations: convs });
  }

  if (req.method === 'GET' && route === '/api/messages') {
    const other = url.searchParams.get('with');
    if (!other) return sendJson(res, 400, { error: 'missing ?with=<username>' });
    const rows = db
      .prepare(
        `SELECT * FROM messages
         WHERE (sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?)
         ORDER BY id ASC`
      )
      .all(me, other, other, me);
    return sendJson(res, 200, { messages: rows.map(msgRowToObj) });
  }

  if (req.method === 'POST' && route === '/api/messages') {
    const { to, text, image } = await readJson(req);
    if (!to) return sendJson(res, 400, { error: 'missing recipient' });
    if (!text && !image) return sendJson(res, 400, { error: 'empty message' });
    const recipient = db.prepare('SELECT username FROM users WHERE username = ?').get(to);
    if (!recipient) return sendJson(res, 404, { error: 'recipient not found' });
    if (image) {
      if (typeof image !== 'string' || !image.startsWith('data:image/'))
        return sendJson(res, 400, { error: 'image must be a data URL' });
      const approxBytes = Math.floor((image.length * 3) / 4);
      if (approxBytes > MAX_IMAGE_BYTES)
        return sendJson(res, 413, { error: 'photo too large (max ~1.5MB)' });
    }
    const info = db
      .prepare(
        "INSERT INTO messages (sender, recipient, text, image, state, created_at) VALUES (?, ?, ?, ?, 'sent', ?)"
      )
      .run(me, to, text || null, image || null, Date.now());
    const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(info.lastInsertRowid));
    const msg = deliverMessage(msgRowToObj(row));
    return sendJson(res, 201, { message: msg });
  }

  if (req.method === 'POST' && route === '/api/messages/read') {
    const { with: other } = await readJson(req);
    if (!other) return sendJson(res, 400, { error: 'missing conversation user' });
    const rows = db
      .prepare(
        "SELECT id FROM messages WHERE sender = ? AND recipient = ? AND state != 'read'"
      )
      .all(other, me);
    if (rows.length) {
      db.prepare(
        "UPDATE messages SET state = 'read' WHERE sender = ? AND recipient = ? AND state != 'read'"
      ).run(other, me);
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
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/ws') return socket.destroy();
  const token = url.searchParams.get('token');
  const row = token && db.prepare('SELECT username FROM sessions WHERE token = ?').get(token);
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
  deliverPending(username);
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
