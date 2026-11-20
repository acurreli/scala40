// End-to-end tests of the real server over HTTP and WebSocket: sign-in, launching and ending
// games, joining by link or code, privacy of hands, playing turns, chat, delegates, the
// open/closed switch, and saving games across a restart.
const test = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'scala40-test-'));
const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
let proc = null;

function startServer() {
  return new Promise((resolve, reject) => {
    proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR: DATA }) });
    let out = '';
    let temp = null;
    proc.stdout.on('data', (d) => {
      out += d;
      const m = out.match(/temporary password: (\S+)/); if (m) temp = m[1];
      if (/Scala 40 on port/.test(out)) resolve(temp);
    });
    proc.stderr.on('data', (d) => process.stderr.write(d));
    proc.on('error', reject);
  });
}
function stopServer() {
  return new Promise((resolve) => { if (!proc) return resolve(); proc.once('exit', resolve); proc.kill('SIGTERM'); proc = null; });
}

class Client { // one browser: keeps its own session cookie
  constructor() { this.cookie = ''; }
  async call(method, url, body) {
    const res = await fetch(BASE + url, {
      method, headers: Object.assign({ 'Content-Type': 'application/json' }, this.cookie ? { cookie: this.cookie } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0];
    let data = {}; try { data = await res.json(); } catch (e) { /* empty */ }
    return { status: res.status, data };
  }
}

function player() { // a WebSocket player that remembers every message
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    ws.msgs = [];
    ws.on('message', (d) => ws.msgs.push(JSON.parse(d)));
    ws.sendj = (m) => ws.send(JSON.stringify(m));
    ws.last = (type) => ws.msgs.filter((m) => m.type === type).pop();
    ws.errors = () => ws.msgs.filter((m) => m.type === 'error').map((m) => m.error);
    ws.on('open', () => resolve(ws));
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await wait(20); }
  return fn();
}

let tempPassword;
const admin = new Client();
const PASSWORD = 'correct-horse-battery';

test.before(async () => {
  execFileSync(process.execPath, ['build.js'], { cwd: ROOT });
  tempPassword = await startServer();
});
test.after(async () => { await stopServer(); fs.rmSync(DATA, { recursive: true, force: true }); });

test('pages are served; the main page has no way to create a table', async () => {
  const home = await (await fetch(BASE + '/')).text();
  assert.ok(home.includes('id="codeForm"'), 'join-by-code box');
  assert.ok(home.includes('href="/admin"'), 'Admin button');
  assert.ok(!home.includes('createBtn'), 'no create button');
  assert.ok(!home.includes('Pass and play'), 'no pass-and-play');
  assert.strictEqual((await fetch(BASE + '/admin')).status, 200);
  assert.strictEqual((await fetch(BASE + '/t/ABCD')).status, 200);
  assert.strictEqual((await fetch(BASE + '/nope')).status, 404);
});

test('anonymous visitors cannot create, list or end tables', async () => {
  const anon = new Client();
  assert.strictEqual((await anon.call('GET', '/api/tables')).status, 401);
  assert.strictEqual((await anon.call('POST', '/api/tables', {})).status, 401);
  assert.strictEqual((await anon.call('POST', '/api/tables/end-all', {})).status, 401);
  const p = await player();
  p.sendj({ type: 'create', name: 'Eve' });
  const err = await until(() => p.errors()[0]);
  assert.match(err, /organizer/);
  p.close();
});

test('admin sign-in: wrong password refused, temporary password must be changed first', async () => {
  assert.ok(tempPassword, 'server printed a temporary password');
  assert.strictEqual((await new Client().call('POST', '/api/login', { username: 'admin', password: 'wrong' })).status, 401);
  assert.strictEqual((await admin.call('POST', '/api/login', { username: 'admin', password: tempPassword })).status, 200);
  const blocked = await admin.call('POST', '/api/tables', {});
  assert.strictEqual(blocked.status, 403);
  assert.strictEqual((await admin.call('POST', '/api/password', { current: tempPassword, next: 'short' })).status, 400);
  assert.strictEqual((await admin.call('POST', '/api/password', { current: tempPassword, next: PASSWORD })).status, 200);
  const me = await admin.call('GET', '/api/me');
  assert.strictEqual(me.data.user.role, 'admin');
  assert.strictEqual(me.data.user.mustChange, false);
  assert.ok(!JSON.stringify(me.data).includes('hash'), 'password hash is never sent');
});

let code;
let ann, bob;
test('admin launches a game; players join by code; first to sit is host', async () => {
  const r = await admin.call('POST', '/api/tables', { label: 'Friday night' });
  assert.strictEqual(r.status, 200);
  code = r.data.table.code;
  assert.match(code, /^[A-Z0-9]{4}$/);
  assert.strictEqual(r.data.table.status, 'waiting');
  assert.strictEqual(r.data.table.label, 'Friday night');

  ann = await player(); ann.sendj({ type: 'join', code, name: 'Ann' });
  const joined = await until(() => ann.last('joined'));
  assert.strictEqual(joined.seat, 0);
  const st = await until(() => ann.last('state'));
  assert.ok(st.lobby.isHost);
  assert.strictEqual(st.lobby.label, 'Friday night');

  bob = await player(); bob.sendj({ type: 'join', code: code.toLowerCase(), name: 'Bob' });
  assert.strictEqual((await until(() => bob.last('joined'))).seat, 1);
  await until(() => ann.last('state') && ann.last('state').lobby.seats.length === 2);

  const nameless = await player(); nameless.sendj({ type: 'join', code });
  assert.match(await until(() => nameless.errors()[0]), /name/);
  nameless.close();
  const bogus = await player(); bogus.sendj({ type: 'join', code: 'ZZZZ', name: 'X' });
  assert.match(await until(() => bogus.errors()[0]), /no longer exists/);
  bogus.close();
});

test('only the host can deal, and not before two players', async () => {
  bob.sendj({ type: 'start' });
  assert.match(await until(() => bob.errors()[0]), /host/);
  ann.sendj({ type: 'start' });
  await until(() => ann.last('state') && ann.last('state').view);
  const va = ann.last('state').view, vb = await until(() => bob.last('state') && bob.last('state').view);
  assert.strictEqual(va.hand.length, 13);
  assert.strictEqual(vb.hand.length, 13);
});

test('each player sees only their own cards', async () => {
  const sa = ann.last('state'), sb = bob.last('state');
  const annIds = new Set(sa.view.hand.map((c) => c.id));
  for (const card of sb.view.hand) assert.ok(!annIds.has(card.id));
  const annRaw = JSON.stringify(ann.msgs);
  for (const card of sb.view.hand) assert.ok(!annRaw.includes(`"id":${card.id},"rank":${card.rank},"suit":"${card.suit}"`), "Bob's card never reaches Ann");
  assert.strictEqual(sa.view.players[1].cards, 13);
});

test('late joiners are refused once the game has started; a full table is refused', async () => {
  const late = await player(); late.sendj({ type: 'join', code, name: 'Late' });
  assert.match(await until(() => late.errors()[0]), /already started/);
  late.close();
  const r = await admin.call('POST', '/api/tables', {});
  const c2 = r.data.table.code;
  const ps = [];
  for (const n of ['P1', 'P2', 'P3', 'P4']) { const p = await player(); p.sendj({ type: 'join', code: c2, name: n }); await until(() => p.last('joined')); ps.push(p); }
  const fifth = await player(); fifth.sendj({ type: 'join', code: c2, name: 'P5' });
  assert.match(await until(() => fifth.errors()[0]), /full/);
  [...ps, fifth].forEach((p) => p.close());
  await admin.call('POST', `/api/tables/${c2}/end`, {});
});

test('playing turns over the network: wrong turn refused, draw and discard work', async () => {
  const turn = ann.last('state').view.turn;
  const [mover, waiter] = turn === 0 ? [ann, bob] : [bob, ann];
  const before = waiter.msgs.length;
  waiter.sendj({ type: 'act', action: 'draw' });
  const refused = await until(() => waiter.msgs.slice(before).find((m) => m.type === 'error'));
  assert.match(refused.error, /not your turn/);

  const n0 = mover.msgs.length;
  mover.sendj({ type: 'act', action: 'draw' });
  const done = await until(() => mover.msgs.slice(n0).find((m) => m.type === 'done'));
  assert.strictEqual(done.info.action, 'draw');
  const hand = await until(() => { const s = mover.last('state'); return s.view.hand.length === 14 && s.view.hand; });
  assert.ok(hand, 'drew a card');
  mover.sendj({ type: 'act', action: 'discard', args: { id: hand[0].id } });
  const after = await until(() => { const s = waiter.last('state'); return s.view.turn !== turn && s; });
  assert.ok(after, 'turn passed');
  assert.strictEqual(after.view.discardTop.id, hand[0].id);
  assert.strictEqual(after.view.players[turn].cards, 13);
});

test('unknown or malformed messages do not crash the server', async () => {
  const p = await player();
  p.send('not json');
  p.sendj({ type: 'act', action: 'explode' });
  p.sendj({ type: 'nonsense' });
  p.sendj({ type: 'join', code: 123, name: { evil: true } });
  await wait(200);
  assert.strictEqual((await fetch(BASE + '/health')).status, 200);
  p.close();
});

test('chat reaches everyone at the table', async () => {
  ann.sendj({ type: 'chat', text: 'ciao a tutti' });
  const m = await until(() => bob.msgs.find((x) => x.type === 'chat'));
  assert.strictEqual(m.message.text, 'ciao a tutti');
  assert.strictEqual(m.message.from, 'Ann');
});

test('a player who reconnects with their token gets their seat and hand back', async () => {
  const token = ann.last('joined').token;
  const hand = ann.last('state').view.hand.map((c) => c.id).sort();
  ann.close();
  await wait(100);
  ann = await player(); ann.sendj({ type: 'join', code, token });
  const j = await until(() => ann.last('joined'));
  assert.strictEqual(j.seat, 0);
  const s = await until(() => ann.last('state'));
  assert.deepStrictEqual(s.view.hand.map((c) => c.id).sort(), hand);
});

test('admin sees the game with players and status', async () => {
  const r = await admin.call('GET', '/api/tables');
  const t = r.data.tables.find((x) => x.code === code);
  assert.strictEqual(t.status, 'playing');
  assert.strictEqual(t.round, 1);
  assert.deepStrictEqual(t.players.map((p) => p.name), ['Ann', 'Bob']);
});

test('games survive a server restart (saved to disk)', async () => {
  const handBefore = ann.last('state').view.hand.map((c) => c.id).sort();
  const token = ann.last('joined').token;
  ann.close(); bob.close();
  await stopServer();
  await startServer();
  assert.strictEqual((await admin.call('GET', '/api/me')).data.user.username, 'admin', 'session kept');
  ann = await player(); ann.sendj({ type: 'join', code, token });
  const s = await until(() => ann.last('state') && ann.last('state').view && ann.last('state'));
  assert.deepStrictEqual(s.view.hand.map((c) => c.id).sort(), handBefore);
  bob = null;
});

test('ending one game tells its players and removes it', async () => {
  const r = await admin.call('POST', `/api/tables/${code}/end`, {});
  assert.strictEqual(r.status, 200);
  const closed = await until(() => ann.last('closed'));
  assert.match(closed.error, /ended this game/);
  assert.ok(!r.data.tables.some((t) => t.code === code));
  const again = await player(); again.sendj({ type: 'join', code, name: 'X' });
  assert.match(await until(() => again.errors()[0]), /no longer exists/);
  again.close();
});

test('end all games', async () => {
  const codes = [];
  for (let i = 0; i < 3; i++) codes.push((await admin.call('POST', '/api/tables', {})).data.table.code);
  const p = await player(); p.sendj({ type: 'join', code: codes[1], name: 'Zoe' }); await until(() => p.last('joined'));
  const r = await admin.call('POST', '/api/tables/end-all', {});
  assert.strictEqual(r.data.tables.length, 0);
  assert.ok(await until(() => p.last('closed')));
  p.close();
});

test('delegates: launch their own games, see only their own; paused delegates are locked out', async () => {
  const made = await admin.call('POST', '/api/admin/delegates', { name: 'Isabella', username: 'isabella' });
  assert.strictEqual(made.status, 200);
  const del = new Client();
  assert.strictEqual((await del.call('POST', '/api/login', { username: 'isabella', password: made.data.tempPassword })).status, 200);
  assert.strictEqual((await del.call('POST', '/api/tables', {})).status, 403, 'must change password first');
  assert.strictEqual((await del.call('POST', '/api/password', { current: made.data.tempPassword, next: 'isabella-secret' })).status, 200);
  const adminGame = (await admin.call('POST', '/api/tables', {})).data.table.code;
  const delGame = (await del.call('POST', '/api/tables', {})).data.table.code;
  const seen = (await del.call('GET', '/api/tables')).data.tables.map((t) => t.code);
  assert.deepStrictEqual(seen, [delGame]);
  assert.strictEqual((await del.call('POST', `/api/tables/${adminGame}/end`, {})).status, 404, "cannot end the admin's game");
  assert.strictEqual((await del.call('GET', '/api/admin/state')).status, 403, 'no admin powers');
  const all = (await admin.call('GET', '/api/tables')).data.tables.map((t) => t.code);
  assert.ok(all.includes(adminGame) && all.includes(delGame), 'admin sees every game');
  await admin.call('POST', '/api/admin/delegates/isabella', { action: 'pause' });
  assert.strictEqual((await del.call('GET', '/api/tables')).status, 401, 'session ended when paused');
  assert.strictEqual((await del.call('POST', '/api/login', { username: 'isabella', password: 'isabella-secret' })).status, 403);
  await admin.call('POST', '/api/tables/end-all', {});
});

test('closing the game room ends games and blocks joining and launching; reopening works', async () => {
  const c3 = (await admin.call('POST', '/api/tables', {})).data.table.code;
  const p = await player(); p.sendj({ type: 'join', code: c3, name: 'Max' }); await until(() => p.last('joined'));
  await admin.call('POST', '/api/admin/site', { open: false });
  assert.ok(await until(() => p.last('closed')));
  assert.strictEqual((await admin.call('POST', '/api/tables', {})).status, 400);
  const q = await player(); q.sendj({ type: 'join', code: c3, name: 'Max' });
  assert.match(await until(() => q.errors()[0]), /closed/);
  q.close(); p.close();
  await admin.call('POST', '/api/admin/site', { open: true });
  assert.strictEqual((await admin.call('POST', '/api/tables', {})).status, 200);
  await admin.call('POST', '/api/tables/end-all', {});
});

test('a full online round can be played to the end through the server', async () => {
  // Two players; the host deals; they play legal turns (draw, discard) until a round ends or
  // 150 turns pass. Checks the server keeps both views in step the whole time.
  const c4 = (await admin.call('POST', '/api/tables', {})).data.table.code;
  const a = await player(); a.sendj({ type: 'join', code: c4, name: 'A' }); await until(() => a.last('joined'));
  const b = await player(); b.sendj({ type: 'join', code: c4, name: 'B' }); await until(() => b.last('joined'));
  a.sendj({ type: 'start' });
  await until(() => a.last('state') && a.last('state').view && b.last('state') && b.last('state').view);
  for (let i = 0; i < 150; i++) {
    const v = a.last('state').view;
    if (v.phase === 'over') break;
    const me = v.turn === 0 ? a : b;
    const n = me.msgs.length;
    me.sendj({ type: 'act', action: 'draw' });
    await until(() => me.msgs.slice(n).some((m) => m.type === 'state'));
    const hand = me.last('state').view.hand;
    const n2 = me.msgs.length;
    me.sendj({ type: 'act', action: 'discard', args: { id: hand[hand.length - 1].id } });
    await until(() => me.msgs.slice(n2).some((m) => m.type === 'state' || m.type === 'error'));
    const sa = a.last('state').view, sb = b.last('state').view;
    assert.strictEqual(sa.turn, sb.turn, 'both see the same turn');
    assert.strictEqual(sa.stockCount, sb.stockCount, 'both see the same stock');
    assert.strictEqual(sa.players[1].cards, sb.hand.length, "A's count of B's cards matches B's hand");
    assert.strictEqual(sb.players[0].cards, sa.hand.length, "B's count of A's cards matches A's hand");
  }
  assert.strictEqual(a.errors().length + b.errors().length, 0, 'no move was refused');
  a.close(); b.close();
  await admin.call('POST', '/api/tables/end-all', {});
});
