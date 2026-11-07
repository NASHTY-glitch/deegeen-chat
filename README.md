# Deegeen Chat

A WhatsApp-style 1-to-1 chat app that runs on **its own server** — its own accounts,
its own database, no connection to WhatsApp or any other service. (Working name
"Deegeen Chat" is a placeholder: change `APP_NAME` in `server/server.mjs` and in
`public/app.js` — one constant each — to rename it.)

## What's in v1

- Accounts: register with username + phone number + password/PIN (stored only as a
  salted scrypt hash). Login returns a session token.
- Chat list with last message, time, and unread-count badges; a "New chat" list of
  all other registered users.
- 1-to-1 chat: text + photo messages (photos as data URLs, ~1.5MB cap).
- Live delivery over WebSocket, with a 3-second polling fallback in the client.
- Message ticks: ✓ sent → ✓✓ delivered → ✓✓ (blue) read, updating live.
- Messages sent while you're offline are delivered when you reconnect.
- Phone web client served by the same server — open the URL on a phone and use
  "Add to Home screen" to install it like an app.

## Run it locally

```bash
cd ~/workspace/whatsapp-style-app
npm install        # one dependency: ws
npm start          # or: PORT=3000 node server/server.mjs
```

Then open http://localhost:3000 in a browser (or on a phone on the same network,
using the machine's LAN address). Data lives in `server/data/chat.db`
(override with the `CHAT_DATA_DIR` env var).

## Test

```bash
npm test           # node test/two-clients.mjs
```

Spawns the server on a test port with a throwaway database and runs a scripted
two-client conversation: register → live text delivery → delivered receipt →
read receipt → photo delivery → history → offline queueing. 14 assertions.

## Going live (what it still needs)

Nothing is deployed yet. To let two real phones in different places use it:

1. A host for the Node server (any small VPS or free-tier app host) running
   `node server/server.mjs` with a public URL — hosting choice and any cost are
   the owner's decision before anything is deployed.
2. HTTPS on that URL (the host or a reverse proxy provides it) so logins and
   `wss://` WebSocket connections are encrypted.
3. That's it: the same URL serves the app to any phone. Each person opens it,
   registers, and uses "Add to Home screen".

Not in v1 (possible later, one at a time): groups, status/stories, voice notes,
calls, push notifications, an Android APK wrapper.
