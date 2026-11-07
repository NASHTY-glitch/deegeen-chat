// Two-client end-to-end test for Deegeen Chat.
// Spawns the real server on a test port with a throwaway database, then:
//   register A + B -> A texts B -> B gets it live on WebSocket -> A sees "delivered"
//   -> B marks read -> A gets the read receipt -> A sends a photo -> arrives intact
//   -> B fetches history -> both messages are there. Also smoke-checks GET /.
// Run: npm test   (or: node test/two-clients.mjs)

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 34567;
const BASE = `http://127.0.0.1:${PORT}`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deegeen-chat-test-'));

let passed = 0;
function assert(cond, label) {
  if (!cond) throw new Error('ASSERT FAILED: ' + label);
  passed++;
  console.log('  PASS  ' + label);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, route, token, body) {
  const res = await fetch(BASE + route, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${route} -> ${res.status}: ${data.error || ''}`);
  return data;
}

function connectWs(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${token}`);
    ws.events = [];
    ws.waiters = [];
    ws.on('message', (raw) => {
      const data = JSON.parse(raw.toString());
      ws.events.push(data);
      ws.waiters = ws.waiters.filter((w) => !w(data));
    });
    ws.waitFor = (pred, timeoutMs = 5000) =>
      new Promise((res2, rej2) => {
        const found = ws.events.find(pred);
        if (found) return res2(found);
        const timer = setTimeout(() => rej2(new Error('ws waitFor timeout')), timeoutMs);
        ws.waiters.push((data) => {
          if (pred(data)) { clearTimeout(timer); res2(data); return true; }
          return false;
        });
      });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

// 1x1 transparent PNG
const PHOTO =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const server = spawn('node', [path.join(__dirname, '..', 'server', 'server.mjs')], {
  env: { ...process.env, PORT: String(PORT), CHAT_DATA_DIR: tmpDir },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

try {
  // wait for server
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/'); break; } catch { await sleep(200); }
  }

  console.log('— smoke: client page —');
  const home = await (await fetch(BASE + '/')).text();
  assert(home.includes('Deegeen Chat') && home.includes('app.js'), 'GET / serves the client HTML');

  console.log('— register two users —');
  const a = await api('POST', '/api/register', null, { username: 'alice', phone: '+2348000000001', password: 'pin-a-1234' });
  const b = await api('POST', '/api/register', null, { username: 'bob', phone: '+2348000000002', password: 'pin-b-1234' });
  assert(a.token && b.token, 'register returns session tokens for A and B');
  const usersForA = await api('GET', '/api/users', a.token);
  assert(usersForA.users.some((u) => u.username === 'bob'), 'A can see B in the user list');

  console.log('— connect both over WebSocket —');
  const wsA = await connectWs(a.token);
  const wsB = await connectWs(b.token);
  await wsB.waitFor((d) => d.type === 'hello');
  assert(true, 'both WebSocket connections open');

  console.log('— A sends B a text message —');
  const sent = await api('POST', '/api/messages', a.token, { to: 'bob', text: 'Hello Bob, from Alice!' });
  const liveMsg = await wsB.waitFor((d) => d.type === 'message' && d.message.id === sent.message.id);
  assert(liveMsg.message.text === 'Hello Bob, from Alice!', 'B receives the text live over WebSocket');
  assert(sent.message.state === 'delivered', "A's copy is 'delivered' once B is online");
  const delReceipt = await wsA.waitFor((d) => d.type === 'receipt' && d.state === 'delivered' && d.ids.includes(sent.message.id));
  assert(!!delReceipt, 'A receives the delivered receipt');

  console.log('— B marks the conversation read —');
  await api('POST', '/api/messages/read', b.token, { with: 'alice' });
  const readReceipt = await wsA.waitFor((d) => d.type === 'receipt' && d.state === 'read' && d.ids.includes(sent.message.id));
  assert(!!readReceipt, 'A receives the read receipt (blue ticks)');
  const histA = await api('GET', '/api/messages?with=bob', a.token);
  assert(histA.messages.find((m) => m.id === sent.message.id)?.state === 'read', "message state is 'read' in A's history");

  console.log('— A sends B a photo —');
  const photoSent = await api('POST', '/api/messages', a.token, { to: 'bob', image: PHOTO });
  const livePhoto = await wsB.waitFor((d) => d.type === 'message' && d.message.id === photoSent.message.id);
  assert(livePhoto.message.image === PHOTO, 'photo arrives at B intact (data URL identical)');

  console.log('— B fetches history —');
  const histB = await api('GET', '/api/messages?with=alice', b.token);
  assert(histB.messages.length === 2, 'history for B contains exactly the 2 messages');
  assert(histB.messages[0].text === 'Hello Bob, from Alice!' && histB.messages[1].image === PHOTO,
    'history order and content match what was sent');

  console.log('— offline->online delivery —');
  wsB.close();
  await sleep(300);
  const offlineSent = await api('POST', '/api/messages', a.token, { to: 'bob', text: 'You were offline for this one' });
  assert(offlineSent.message.state === 'sent', "message stays 'sent' while B is offline");
  const wsB2 = await connectWs(b.token);
  const caughtUp = await wsB2.waitFor((d) => d.type === 'message' && d.message.id === offlineSent.message.id);
  assert(caughtUp.message.text === 'You were offline for this one', 'B receives the queued message on reconnect');
  wsB2.close();
  wsA.close();

  console.log(`\nALL TESTS PASSED (${passed} assertions)`);
} finally {
  server.kill('SIGTERM');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
