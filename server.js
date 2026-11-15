// Scala 40 game server.
// Serves the game page and runs online tables over WebSocket. The server holds every hand and
// checks every move with the rules engine; each player is sent only what they are allowed to see.
//
// Fly.io may run more than one machine. A table lives in the memory of the machine that created it,
// so invite links carry that machine's id (?m=...) and requests that land on another machine are
// handed over with Fly's `fly-replay` header.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const S = require('./src/engine.js');

const PORT = process.env.PORT || 8080;
const MACHINE = process.env.FLY_MACHINE_ID || 'local';
const MAX_SEATS = 4;
const TABLE_TTL_MS = 24 * 60 * 60 * 1000;

const page = fs.readFileSync(path.join(__dirname, 'dist', 'scala40.html'));
const tables = new Map(); // code -> table

function newCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from(crypto.randomBytes(4), (b) => alphabet[b % alphabet.length]).join('');
  } while (tables.has(code));
  return code;
}
const newToken = () => crypto.randomBytes(16).toString('hex');

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function lobbyInfo(t, seatIdx) {
  return {
    code: t.code,
    machine: MACHINE,
    seat: seatIdx,
    isHost: seatIdx === 0,
    started: !!t.game,
    seats: t.seats.map((s) => ({ name: s.name, connected: !!(s.ws && s.ws.readyState === 1) })),
  };
}

function broadcast(t) {
  t.touched = Date.now();
  t.seats.forEach((seat, i) => {
    if (!seat.ws) return;
    send(seat.ws, {
      type: 'state',
      lobby: lobbyInfo(t, i),
      view: t.game ? S.viewFor(t.game, i) : null,
    });
  });
}

function joinSeat(ws, t, seatIdx) {
  const seat = t.seats[seatIdx];
  if (seat.ws && seat.ws !== ws) {
    send(seat.ws, { type: 'kicked', error: 'This seat was opened on another device.' });
    try { seat.ws.close(); } catch (e) { /* ignore */ }
  }
  seat.ws = ws;
  ws.table = t;
  ws.seat = seatIdx;
  send(ws, { type: 'joined', code: t.code, machine: MACHINE, token: seat.token, seat: seatIdx });
  send(ws, { type: 'chatHistory', messages: t.chat });
  broadcast(t);
}

const ACTIONS = {
  draw: (g) => S.drawStock(g),
  take: (g) => S.takeDiscard(g),
  lay: (g, a) => S.layMeld(g, a.ids || []),
  attach: (g, a) => S.attach(g, a.meldId, a.ids || []),
  swap: (g, a) => S.swapJoker(g, a.meldId, a.id),
  discard: (g, a) => S.discard(g, a.id),
  reset: (g) => S.resetTurn(g),
};

function handle(ws, msg) {
  const name = String(msg.name || '').trim().slice(0, 16);

  if (msg.type === 'create') {
    if (!name) return send(ws, { type: 'error', error: 'Type your name first.' });
    const t = { code: newCode(), seats: [{ name, token: newToken(), ws: null }], game: null, chat: [], touched: Date.now() };
    tables.set(t.code, t);
    return joinSeat(ws, t, 0);
  }

  if (msg.type === 'join') {
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
  if (!t) return send(ws, { type: 'error', error: 'You are not at a table.' });
  const me = ws.seat;

  if (msg.type === 'chat') {
    const text = String(msg.text || '').trim().slice(0, 200);
    if (!text) return;
    const now = Date.now();
    if (ws.lastChat && now - ws.lastChat < 400) return; // simple flood guard
    ws.lastChat = now;
    const entry = { from: t.seats[me].name, seat: me, text, at: now };
    t.chat.push(entry);
    if (t.chat.length > 100) t.chat.shift();
    t.touched = now;
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

// ---------- HTTP + WebSocket ----------

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') { res.writeHead(200); return res.end('ok'); }
  if (url.pathname === '/' || url.pathname.startsWith('/t/')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end(page);
  }
  res.writeHead(404); res.end('Not found');
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/ws') return socket.destroy();
  const target = url.searchParams.get('m');
  if (target && MACHINE !== 'local' && target !== MACHINE) {
    // Hand the connection to the machine that holds this table.
    socket.write(`HTTP/1.1 200 OK\r\nfly-replay: instance=${target}\r\nContent-Length: 0\r\n\r\n`);
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch (e) { return; }
    try { handle(ws, msg); } catch (e) {
      console.error(e);
      send(ws, { type: 'error', error: 'Something went wrong on the server.' });
    }
  });
  ws.on('close', () => {
    const t = ws.table;
    if (t && t.seats[ws.seat] && t.seats[ws.seat].ws === ws) {
      t.seats[ws.seat].ws = null;
      broadcast(t);
    }
  });
});

// Keep connections alive through proxies, and forget tables nobody has used for a day.
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
  const now = Date.now();
  for (const [code, t] of tables) if (now - t.touched > TABLE_TTL_MS) tables.delete(code);
}, 25000);

server.listen(PORT, '0.0.0.0', () => console.log(`Scala 40 on port ${PORT} (machine ${MACHINE})`));
