// Scala 40 game server.
// - Serves the game page (/ and /t/CODE) and the admin page (/admin).
// - Runs online tables over WebSocket. The server holds every hand and checks every move with the
//   rules engine; each player is sent only what they are allowed to see.
// - Only the admin, or a delegate the admin has created, can create tables. Players join by invite link.
// - Accounts, sessions, the open/closed switch and every table are saved to disk (store.js), so games
//   survive restarts and the server can stop itself when nobody is playing.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const S = require('./src/engine.js');
const store = require('./store.js');

const PORT = process.env.PORT || 8080;
const MACHINE = process.env.FLY_MACHINE_ID || 'local';
const MAX_SEATS = 4;
const TABLE_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const COOKIE = 'scala40_session';

const page = fs.readFileSync(path.join(__dirname, 'dist', 'scala40.html'));
const adminPage = fs.readFileSync(path.join(__dirname, 'dist', 'admin.html'));

// ---------- saved state ----------
const db = store.load();
const tables = new Map(); // code -> { code, seats:[{name, token, ws}], game, chat, touched, createdBy }
for (const t of Object.values(db.tables)) {
  tables.set(t.code, Object.assign(t, { seats: t.seats.map((s) => ({ name: s.name, token: s.token, ws: null })) }));
}
const temp = store.ensureAdmin();
if (temp) {
  console.log('==============================================================');
  console.log('ADMIN SIGN-IN  username: admin   temporary password: ' + temp);
  console.log('Sign in at /admin and choose your own password.');
  console.log('==============================================================');
}

function persistTable(t) {
  db.tables[t.code] = {
    code: t.code, game: t.game, chat: t.chat, touched: t.touched, createdBy: t.createdBy,
    seats: t.seats.map((s) => ({ name: s.name, token: s.token })),
  };
  store.save();
}
function dropTable(code) { tables.delete(code); delete db.tables[code]; store.save(); }

// ---------- helpers ----------
function newCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from(crypto.randomBytes(4), (b) => alphabet[b % alphabet.length]).join(''); } while (tables.has(code));
  return code;
}
const newToken = () => crypto.randomBytes(16).toString('hex');
function send(ws, msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const userFromReq = (req) => store.userForToken(cookies(req)[COOKIE]);

// ---------- tables ----------
function lobbyInfo(t, seatIdx) {
  return {
    code: t.code, machine: MACHINE, seat: seatIdx, isHost: seatIdx === 0, started: !!t.game,
    seats: t.seats.map((s) => ({ name: s.name, connected: !!(s.ws && s.ws.readyState === 1) })),
  };
}
function broadcast(t) {
  t.touched = Date.now();
  persistTable(t);
  t.seats.forEach((seat, i) => {
    if (seat.ws) send(seat.ws, { type: 'state', lobby: lobbyInfo(t, i), view: t.game ? S.viewFor(t.game, i) : null });
  });
}
function joinSeat(ws, t, seatIdx) {
  const seat = t.seats[seatIdx];
  if (seat.ws && seat.ws !== ws) {
    send(seat.ws, { type: 'kicked', error: 'This seat was opened on another device.' });
    try { seat.ws.close(); } catch (e) { /* ignore */ }
  }
  seat.ws = ws; ws.table = t; ws.seat = seatIdx;
  send(ws, { type: 'joined', code: t.code, machine: MACHINE, token: seat.token, seat: seatIdx });
  send(ws, { type: 'chatHistory', messages: t.chat });
  broadcast(t);
}
function endAllTables(reason) {
  for (const t of tables.values()) {
    for (const s of t.seats) {
      if (s.ws) { send(s.ws, { type: 'closed', error: reason }); try { s.ws.close(); } catch (e) { /* ignore */ } }
    }
  }
  tables.clear(); db.tables = {}; store.save();
}

const ACTIONS = {
  draw: (g) => S.drawStock(g),
  take: (g) => S.takeDiscard(g),
  lay: (g, a) => S.layMeld(g, a.ids || []),
  attach: (g, a) => S.attach(g, a.meldId, a.ids || []),
  swap: (g, a) => S.swapJoker(g, a.meldId, a.id),
  discard: (g, a) => S.discard(g, a.id),
  reset: (g) => S.resetTurn(g),
  putBack: (g) => S.returnDiscard(g),
};
const CLOSED_MSG = 'The game room is closed right now. Ask the organizer to open it.';

function handle(ws, msg) {
  const name = String(msg.name || '').trim().slice(0, 16);

  if (msg.type === 'create') {
    if (!db.site.open) return send(ws, { type: 'error', error: CLOSED_MSG });
    const user = store.userForToken(ws.sessionToken);
    if (!user) return send(ws, { type: 'error', error: 'Only the organizer or a delegate can create tables. Sign in first.' });
    if (user.mustChange) return send(ws, { type: 'error', error: 'Choose your own password on the sign-in page first.' });
    if (!name) return send(ws, { type: 'error', error: 'Type your name first.' });
    const t = { code: newCode(), seats: [{ name, token: newToken(), ws: null }], game: null, chat: [], touched: Date.now(), createdBy: user.username };
    tables.set(t.code, t);
    return joinSeat(ws, t, 0);
  }

  if (msg.type === 'join') {
    if (!db.site.open) return send(ws, { type: 'error', fatal: true, error: CLOSED_MSG });
    const t = tables.get(String(msg.code || '').toUpperCase());
    if (!t) return send(ws, { type: 'error', fatal: true, error: 'That table no longer exists. Ask for a new invite link.' });
    const mine = t.seats.findIndex((s) => msg.token && s.token === msg.token);
    if (mine >= 0) return joinSeat(ws, t, mine);
    if (t.game) return send(ws, { type: 'error', fatal: true, error: 'This game has already started.' });
    if (t.seats.length >= MAX_SEATS) return send(ws, { type: 'error', fatal: true, error: 'This table is full (4 players).' });
    if (!name) return send(ws, { type: 'error', error: 'Type your name first.' });
    t.seats.push({ name, token: newToken(), ws: null });
    return joinSeat(ws, t, t.seats.length - 1);
  }

  const t = ws.table;
  if (!t || !tables.has(t.code)) return send(ws, { type: 'error', error: 'You are not at a table.' });
  const me = ws.seat;

  if (msg.type === 'chat') {
    const text = String(msg.text || '').trim().slice(0, 200);
    if (!text) return;
    const now = Date.now();
    if (ws.lastChat && now - ws.lastChat < 400) return;
    ws.lastChat = now;
    const entry = { from: t.seats[me].name, seat: me, text, at: now };
    t.chat.push(entry);
    if (t.chat.length > 100) t.chat.shift();
    t.touched = now; persistTable(t);
    t.seats.forEach((s) => send(s.ws, { type: 'chat', message: entry }));
    return;
  }
  if (msg.type === 'start') {
    if (me !== 0) return send(ws, { type: 'error', error: 'Only the player who created the table can deal.' });
    if (t.game && t.game.winner == null) return send(ws, { type: 'error', error: 'The game has already started.' });
    if (t.seats.length < 2) return send(ws, { type: 'error', error: 'Wait for at least one more player.' });
    t.game = S.newGame(t.seats.map((s) => s.name));
    return broadcast(t);
  }
  if (msg.type === 'next') {
    if (!t.game) return;
    const res = S.nextRound(t.game);
    if (!res.ok) return send(ws, { type: 'error', error: res.error });
    return broadcast(t);
  }
  if (msg.type === 'act') {
    const g = t.game;
    if (!g) return send(ws, { type: 'error', error: 'The game has not started yet.' });
    if (g.round.turn !== me || g.round.phase === 'over') return send(ws, { type: 'error', error: 'It is not your turn.' });
    const fn = ACTIONS[msg.action];
    if (!fn) return send(ws, { type: 'error', error: 'Unknown move.' });
    const res = fn(g, msg.args || {});
    if (!res.ok) return send(ws, { type: 'error', error: res.error });
    const info = { action: msg.action };
    if (res.card) info.cardId = res.card.id;
    if (res.value != null) info.value = res.value;
    send(ws, { type: 'done', info });
    return broadcast(t);
  }
}

// ---------- accounts API ----------
const loginAttempts = new Map(); // ip -> [timestamps]
function tooManyAttempts(ip) {
  const now = Date.now();
  const list = (loginAttempts.get(ip) || []).filter((x) => now - x < 10 * 60000);
  loginAttempts.set(ip, list);
  return list.length >= 10;
}
function json(res, status, body, headers) {
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, headers || {}));
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 10000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { resolve({}); } });
  });
}
function sessionCookie(token, maxAge) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}` + (MACHINE !== 'local' ? '; Secure' : '');
}
function validPassword(pw) { return typeof pw === 'string' && pw.length >= 8 && pw.length <= 128; }
function siteInfo() {
  return { open: !!db.site.open, tables: tables.size, playing: Array.from(tables.values()).filter((t) => t.game).length };
}

async function api(req, res, url) {
  // Only same-origin JSON requests change anything (with the SameSite cookie this blocks cross-site use).
  if (req.method === 'POST' && !String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'Bad request.' });
  const body = req.method === 'POST' ? await readBody(req) : {};
  const user = userFromReq(req);
  const p = url.pathname;

  if (p === '/api/me' && req.method === 'GET') {
    return json(res, 200, { user: store.publicUser(user), site: { open: !!db.site.open } });
  }
  if (p === '/api/login' && req.method === 'POST') {
    const ip = req.headers['fly-client-ip'] || req.socket.remoteAddress;
    if (tooManyAttempts(ip)) return json(res, 429, { error: 'Too many attempts. Wait 10 minutes and try again.' });
    const u = db.users[store.cleanUsername(body.username)];
    if (!u || !store.checkPassword(String(body.password || ''), u.hash)) {
      loginAttempts.get(ip).push(Date.now());
      return json(res, 401, { error: 'Wrong username or password.' });
    }
    if (u.status !== 'active') return json(res, 403, { error: 'This account is paused. Ask the admin to resume it.' });
    u.lastLogin = Date.now(); store.save();
    return json(res, 200, { user: store.publicUser(u) }, { 'Set-Cookie': sessionCookie(store.createSession(u.username), 14 * 86400) });
  }
  if (p === '/api/logout' && req.method === 'POST') {
    store.endSession(cookies(req)[COOKIE]);
    return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
  }
  if (!user) return json(res, 401, { error: 'Please sign in.' });

  if (p === '/api/password' && req.method === 'POST') {
    if (!store.checkPassword(String(body.current || ''), user.hash)) return json(res, 400, { error: 'Your current password is not right.' });
    if (!validPassword(body.next)) return json(res, 400, { error: 'Choose a password of at least 8 characters.' });
    if (body.next === body.current) return json(res, 400, { error: 'Choose a password different from the current one.' });
    user.hash = store.hashPassword(body.next);
    user.mustChange = false;
    store.endSessionsFor(user.username);
    return json(res, 200, { user: store.publicUser(user) }, { 'Set-Cookie': sessionCookie(store.createSession(user.username), 14 * 86400) });
  }

  // Everything below is for the admin only.
  if (user.role !== 'admin') return json(res, 403, { error: 'Only the admin can do that.' });
  if (user.mustChange) return json(res, 403, { error: 'Choose your own password first.' });

  if (p === '/api/admin/state' && req.method === 'GET') {
    const delegates = Object.values(db.users).filter((u) => u.role === 'delegate').map(store.publicUser)
      .sort((a, b) => a.username.localeCompare(b.username));
    return json(res, 200, { site: siteInfo(), delegates });
  }
  if (p === '/api/admin/site' && req.method === 'POST') {
    const open = !!body.open;
    if (!open) endAllTables('The organizer has closed the game room. All games have ended.');
    db.site.open = open; store.save();
    return json(res, 200, { site: siteInfo() });
  }
  if (p === '/api/admin/delegates' && req.method === 'POST') {
    const username = store.cleanUsername(body.username);
    if (!/^[a-z0-9._-]{3,24}$/.test(username)) return json(res, 400, { error: 'Usernames are 3–24 characters: letters, numbers, dots, dashes.' });
    if (db.users[username]) return json(res, 400, { error: 'That username is already taken.' });
    const pw = store.tempPassword();
    db.users[username] = {
      username, name: String(body.name || username).trim().slice(0, 30) || username, role: 'delegate',
      status: 'active', hash: store.hashPassword(pw), mustChange: true, created: Date.now(),
    };
    store.save();
    return json(res, 200, { delegate: store.publicUser(db.users[username]), tempPassword: pw });
  }
  const m = p.match(/^\/api\/admin\/delegates\/([a-z0-9._-]+)$/);
  if (m && req.method === 'POST') {
    const d = db.users[m[1]];
    if (!d || d.role !== 'delegate') return json(res, 404, { error: 'No such delegate.' });
    const action = body.action;
    if (action === 'pause') { d.status = 'paused'; store.endSessionsFor(d.username); }
    else if (action === 'resume') d.status = 'active';
    else if (action === 'rename') d.name = String(body.name || '').trim().slice(0, 30) || d.name;
    else if (action === 'reset') {
      const pw = store.tempPassword();
      d.hash = store.hashPassword(pw); d.mustChange = true; store.endSessionsFor(d.username); store.save();
      return json(res, 200, { delegate: store.publicUser(d), tempPassword: pw });
    } else if (action === 'delete') {
      delete db.users[d.username]; store.endSessionsFor(d.username); store.save();
      return json(res, 200, { deleted: true });
    } else return json(res, 400, { error: 'Unknown action.' });
    store.save();
    return json(res, 200, { delegate: store.publicUser(d) });
  }
  return json(res, 404, { error: 'Not found.' });
}

// ---------- HTTP + WebSocket ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') { res.writeHead(200); return res.end('ok'); }
  if (url.pathname.startsWith('/api/')) {
    return api(req, res, url).catch((e) => { console.error(e); json(res, 500, { error: 'Something went wrong on the server.' }); });
  }
  const html = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' };
  if (url.pathname === '/' || url.pathname.startsWith('/t/')) { res.writeHead(200, html); return res.end(page); }
  if (url.pathname === '/admin') { res.writeHead(200, html); return res.end(adminPage); }
  res.writeHead(404); res.end('Not found');
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/ws') return socket.destroy();
  const target = url.searchParams.get('m');
  if (target && MACHINE !== 'local' && target !== MACHINE && target !== 'local') {
    socket.write(`HTTP/1.1 200 OK\r\nfly-replay: instance=${target}\r\nContent-Length: 0\r\n\r\n`);
    return socket.destroy();
  }
  const sessionToken = cookies(req)[COOKIE];
  wss.handleUpgrade(req, socket, head, (ws) => { ws.sessionToken = sessionToken; wss.emit('connection', ws, req); });
});

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch (e) { return; }
    try { handle(ws, msg); } catch (e) { console.error(e); send(ws, { type: 'error', error: 'Something went wrong on the server.' }); }
  });
  ws.on('close', () => {
    const t = ws.table;
    if (t && t.seats[ws.seat] && t.seats[ws.seat].ws === ws) { t.seats[ws.seat].ws = null; if (tables.has(t.code)) broadcast(t); }
  });
});

setInterval(() => {
  wss.clients.forEach((ws) => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); });
  const now = Date.now();
  for (const [code, t] of tables) if (now - t.touched > TABLE_TTL_MS) dropTable(code);
  store.pruneSessions();
}, 25000);

// Save before Fly.io stops the machine (idle shutdown, deploys, maintenance).
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { try { store.saveNow(); } catch (e) { console.error(e); } process.exit(0); });

server.listen(PORT, '0.0.0.0', () => console.log(`Scala 40 on port ${PORT} (machine ${MACHINE}, data in ${store.DATA_DIR})`));
