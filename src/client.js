// Scala 40 page: online tables (server-run) and pass-and-play (runs locally in the browser).
(function () {
  'use strict';
  const S = window.Scala40;
  const $ = (id) => document.getElementById(id);

  let mode = null;            // 'online' | 'local'
  let localGame = null;       // pass-and-play game
  let view = null;            // what is drawn: S.viewFor(...) shape
  let lobby = null;           // online table info
  let ws = null;
  const online = { code: null, machine: null, token: null, joined: false };
  let selected = new Set();
  let revealedFor = null;
  let lastDrawnId = null;
  let message = { text: '', kind: '' };
  let handOrder = {};
  let drag = null;
  let chat = [];
  let unread = 0;
  const phone = () => window.matchMedia('(max-width: 640px)').matches;
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- small helpers ----------
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem('scala40:' + k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem('scala40:' + k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
  };
  function say(text, kind) { message = { text, kind: kind || '' }; }
  function show(id, on) { $(id).classList.toggle('hidden', !on); }
  function rankLabel(r) { return r === 1 ? 'A' : r === 11 ? 'J' : r === 12 ? 'Q' : r === 13 ? 'K' : String(r); }
  function posLabel(p) { return rankLabel(p === 14 ? 1 : p); }
  function esc(s) { return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])); }

  function cardEl(card, extra) {
    const d = document.createElement('div');
    d.className = 'card';
    if (S.isJoker(card)) {
      d.classList.add('joker');
      d.innerHTML = '<span>★</span><span class="sub">' + (extra && extra.stands ? extra.stands : 'Joker') + '</span><span class="big">★</span>';
    } else {
      if (card.suit === 'H' || card.suit === 'D') d.classList.add('red');
      const sym = S.SUIT_SYMBOL[card.suit];
      d.innerHTML = '<span>' + rankLabel(card.rank) + sym + '</span><span class="big">' + sym + '</span>';
    }
    d.setAttribute('aria-label', S.cardLabel(card));
    return d;
  }

  // ---------- home ----------
  const savedName = store.get('name') || '';
  $('joinName').value = savedName;

  $('codeForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = $('codeInput').value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length < 4) { $('homeErr').textContent = 'Type the table code you were given (4 letters or numbers).'; return; }
    location.href = '/t/' + code;
  });
  $('joinHome').onclick = () => { history.replaceState(null, '', '/'); show('join', false); show('home', true); };

  // Is the game room open? Tables are set up only from the admin page.
  async function loadAccount() {
    let open = true;
    try { const r = await (await fetch('/api/me', { credentials: 'same-origin' })).json(); open = r.site.open; } catch (e) { /* offline */ }
    $('onlineIntro').textContent = open
      ? 'To join a game you need an invite link or a table code from the organizer. Got a link? Just open it. Got a code? Type it here.'
      : 'The game room is closed right now. Ask the organizer to open it.';
    show('codeForm', open);
  }
  loadAccount();

  function refreshLocal() { view = S.viewFor(localGame, localGame.round.turn); render(); }
  function resetUi() { selected.clear(); revealedFor = null; lastDrawnId = null; handOrder = {}; say(''); }

  // ---------- online ----------
  function send(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }

  function connect(onOpen) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const m = online.machine ? '?m=' + encodeURIComponent(online.machine) : '';
    ws = new WebSocket(proto + '://' + location.host + '/ws' + m);
    ws.onopen = () => { show('banner', false); onOpen(); };
    ws.onmessage = (ev) => onServer(JSON.parse(ev.data));
    ws.onclose = () => {
      if (online.closedByServer) { online.closedByServer = false; return; }
      if (!online.joined) {
        $('homeErr').textContent = $('joinErr').textContent = 'Could not reach the game server. Check your connection and try again.';
        return;
      }
      show('banner', true);
      setTimeout(() => connect(() => send({ type: 'join', code: online.code, token: online.token })), 2000);
    };
  }

  function onServer(msg) {
    if (msg.type === 'joined') {
      Object.assign(online, { code: msg.code, machine: msg.machine, token: msg.token, joined: true });
      store.set('table:' + msg.code, { token: msg.token, machine: msg.machine });
      history.replaceState(null, '', '/t/' + msg.code + '?m=' + encodeURIComponent(msg.machine));
      show('home', false); show('join', false);
      return;
    }
    if (msg.type === 'state') {
      const before = view;
      lobby = msg.lobby;
      view = msg.view;
      if (view && before && (before.roundNumber !== view.roundNumber)) { selected.clear(); lastDrawnId = null; }
      if (view && view.turn !== view.me) selected.clear();
      render();
      runPendingFly();
      if (before && view && before.roundNumber === view.roundNumber && before.turn === view.turn &&
          before.phase === 'draw' && view.phase === 'play' && view.turn !== view.me) {
        const fromDiscard = !!before.discardTop && (!view.discardTop || view.discardTop.id !== before.discardTop.id);
        flyCard(fromDiscard ? $('discardTop') : $('stockBtn'), document.querySelector('.pchip[data-seat="' + view.turn + '"]'), fromDiscard ? before.discardTop : null);
      }
      return;
    }
    if (msg.type === 'done') { afterAction(msg.info.action, msg.info); return; }
    if (msg.type === 'chatHistory') { chat = msg.messages || []; renderChat(); return; }
    if (msg.type === 'chat') {
      chat.push(msg.message); if (chat.length > 100) chat.shift();
      if (phone() && !$('chat').classList.contains('open') && msg.message.seat !== (lobby && lobby.seat)) unread++;
      renderChat(true); updateChatToggle(); return;
    }
    if (msg.type === 'error') {
      if (!online.joined || msg.fatal) {
        online.joined = false;
        $('joinErr').textContent = $('homeErr').textContent = msg.error;
        if (msg.fatal) { show('join', true); }
        return;
      }
      say(msg.error, 'err'); render();
      return;
    }
    if (msg.type === 'kicked') { online.joined = false; say(msg.error, 'err'); render(); }
    if (msg.type === 'closed') {
      online.closedByServer = true;
      online.joined = false; view = null; lobby = null;
      ['lobby', 'roundOver', 'handoff', 'invitePanel', 'join'].forEach((id) => show(id, false));
      $('chat').classList.remove('open');
      history.replaceState(null, '', '/');
      $('homeErr').textContent = msg.error;
      show('home', true);
      loadAccount();
    }
  }

  // Opening an invite link: /t/CODE?m=MACHINE
  function bootFromUrl() {
    const m = location.pathname.match(/^\/t\/([A-Za-z0-9]+)/);
    if (!m) { show('home', true); return; }
    mode = 'online';
    online.code = m[1].toUpperCase();
    online.machine = new URLSearchParams(location.search).get('m');
    const saved = store.get('table:' + online.code);
    $('joinTitle').textContent = 'Join table ' + online.code;
    if (saved && saved.token) {
      online.token = saved.token;
      online.machine = online.machine || saved.machine;
      connect(() => send({ type: 'join', code: online.code, token: saved.token }));
      return;
    }
    show('join', true);
  }
  $('joinBtn').onclick = () => {
    const name = $('joinName').value.trim();
    if (!name) { $('joinErr').textContent = 'Type your name first.'; return; }
    store.set('name', name);
    $('joinErr').textContent = '';
    connect(() => send({ type: 'join', code: online.code, name }));
  };
  $('copyBtn').onclick = async () => {
    const link = $('inviteLink').value;
    try { await navigator.clipboard.writeText(link); $('copyBtn').textContent = 'Copied'; }
    catch (e) { $('inviteLink').select(); $('copyBtn').textContent = 'Select and copy'; }
    setTimeout(() => { $('copyBtn').textContent = 'Copy link'; }, 2000);
  };
  $('startBtn').onclick = () => send({ type: 'start' });
  function inviteUrl() { return location.origin + '/t/' + lobby.code + '?m=' + encodeURIComponent(lobby.machine); }
  $('inviteBtn').onclick = () => {
    $('invCode').textContent = lobby.code;
    $('invLink').value = inviteUrl();
    $('invNote').textContent = 'This link lets anyone at this table get back in from any device. New players can only join before the cards are dealt, so start a new table if someone else wants in.';
    show('invitePanel', true);
  };
  $('invClose').onclick = () => show('invitePanel', false);
  $('invCopy').onclick = async () => {
    try { await navigator.clipboard.writeText($('invLink').value); $('invCopy').textContent = 'Copied'; }
    catch (e) { $('invLink').select(); $('invCopy').textContent = 'Select and copy'; }
    setTimeout(() => { $('invCopy').textContent = 'Copy link'; }, 2000);
  };

  // ---------- actions (same for both modes) ----------
  const LOCAL = {
    draw: (g) => S.drawStock(g), take: (g) => S.takeDiscard(g),
    lay: (g, a) => S.layMeld(g, a.ids), attach: (g, a) => S.attach(g, a.meldId, a.ids),
    swap: (g, a) => S.swapJoker(g, a.meldId, a.id), discard: (g, a) => S.discard(g, a.id),
    reset: (g) => S.resetTurn(g),
    putBack: (g) => S.returnDiscard(g),
  };
  function act(action, args) {
    if (mode === 'online') { send({ type: 'act', action, args: args || {} }); return; }
    const res = LOCAL[action](localGame, args || {});
    if (!res.ok) { say(res.error, 'err'); render(); return res; }
    afterAction(action, { cardId: res.card && res.card.id, value: res.value, count: res.count });
    refreshLocal();
    return res;
  }
  function afterAction(action, info) {
    selected.clear();
    if (action === 'putBack') {
      lastDrawnId = info.cardId;
      say('You put the card back and drew from the deck.', 'ok');
      pendingFly = { from: 'stock', id: info.cardId };
    } else if (action === 'draw' || action === 'take') {
      lastDrawnId = info.cardId;
      say(action === 'take' ? 'Use the card you took in a combination this turn.' : '', 'ok');
      pendingFly = { from: action === 'take' ? 'discard' : 'stock', id: info.cardId };
    } else if (action === 'lay') say('Laid down ' + (info.count > 1 ? info.count + ' combinations' : 'a combination') + ', worth ' + info.value + ' points.', 'ok');
    else if (action === 'attach') say('Attached.', 'ok');
    else if (action === 'swap') say('You took the joker. Use it in a combination this turn.', 'ok');
    else if (action === 'reset') say('Turn undone: you are back to just after your draw.', 'ok');
    else if (action === 'discard') { lastDrawnId = null; say(''); }
    render();
    runPendingFly();
  }

  // ---------- card animation: from the deck (or discard pile) to the hand ----------
  let pendingFly = null;
  function runPendingFly() {
    if (!pendingFly) return;
    const f = pendingFly;
    // Online, the new card arrives with the next state update; wait until it is in the hand.
    const target = document.querySelector('#hand .card[data-id="' + f.id + '"]');
    if (!target) { if (mode !== 'online') pendingFly = null; return; }
    pendingFly = null;
    const card = view.hand.find((c) => c.id === f.id);
    flyCard(f.from === 'discard' ? $('discardTop') : $('stockBtn'), target, card, true);
  }
  function flyCard(fromEl, toEl, card, faceUpAtEnd) {
    if (reduceMotion || !fromEl || !toEl || !fromEl.animate) return;
    const a = fromEl.getBoundingClientRect(), b = toEl.getBoundingClientRect();
    if (!a.width || !b.width) return;
    let ghost;
    if (card && (faceUpAtEnd || card)) ghost = cardEl(card);
    else { ghost = document.createElement('div'); ghost.className = 'back'; }
    ghost.classList.add('flying');
    const w = 64, h = 92;
    ghost.style.width = w + 'px'; ghost.style.height = h + 'px';
    ghost.style.left = (a.left + a.width / 2 - w / 2) + 'px';
    ghost.style.top = (a.top + a.height / 2 - h / 2) + 'px';
    document.body.appendChild(ghost);
    const dx = (b.left + b.width / 2) - (a.left + a.width / 2);
    const dy = (b.top + b.height / 2) - (a.top + a.height / 2);
    const scale = toEl.classList.contains('card') ? b.width / w : 0.45;
    if (toEl.classList.contains('card')) toEl.style.visibility = 'hidden';
    const anim = ghost.animate([
      { transform: 'translate(0,0) scale(1) rotate(0deg)' },
      { transform: 'translate(' + dx * 0.55 + 'px,' + (dy * 0.55 - 40) + 'px) scale(1.08) rotate(-6deg)', offset: 0.55 },
      { transform: 'translate(' + dx + 'px,' + dy + 'px) scale(' + scale + ') rotate(0deg)', opacity: toEl.classList.contains('card') ? 1 : 0.2 },
    ], { duration: 520, easing: 'cubic-bezier(.3,.7,.3,1)' });
    anim.onfinish = anim.oncancel = () => { ghost.remove(); toEl.style.visibility = ''; };
  }

  // ---------- chat (online tables) ----------
  function renderChat(scroll) {
    const list = $('chatLog');
    list.innerHTML = '';
    if (!chat.length) { const li = document.createElement('li'); li.className = 'empty'; li.textContent = 'No messages yet. Say hello!'; list.appendChild(li); }
    chat.forEach((m) => {
      const li = document.createElement('li');
      const who = document.createElement('span'); who.className = 'from'; who.textContent = m.from + ':';
      li.appendChild(who); li.appendChild(document.createTextNode(' ' + m.text));
      list.appendChild(li);
    });
    if (scroll !== false) list.scrollTop = list.scrollHeight;
  }
  function updateChatToggle() {
    $('chatToggle').textContent = unread ? 'Chat (' + unread + ')' : 'Chat';
    $('chatToggle').setAttribute('aria-expanded', $('chat').classList.contains('open') ? 'true' : 'false');
  }
  $('chatToggle').onclick = () => {
    const open = !$('chat').classList.contains('open');
    $('chat').classList.toggle('open', open);
    if (open) { unread = 0; renderChat(); $('chatInput').focus(); }
    updateChatToggle();
  };
  $('chatClose').onclick = () => { $('chat').classList.remove('open'); updateChatToggle(); };
  $('chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('chatInput').value.trim();
    if (!text) return;
    send({ type: 'chat', text });
    $('chatInput').value = '';
  });

  $('stockBtn').onclick = () => act('draw');
  $('discardBtn').onclick = () => act('take');
  $('layBtn').onclick = () => act('lay', { ids: Array.from(selected) });
  $('discardSelBtn').onclick = () => act('discard', { id: Array.from(selected)[0] });
  $('resetBtn').onclick = () => act('reset');
  $('putBackBtn').onclick = () => act('putBack');
  $('clearBtn').onclick = () => { selected.clear(); render(); };
  $('revealBtn').onclick = () => { revealedFor = view.turn; say(''); render(); };

  function onMeldClick(meldId) {
    const ids = Array.from(selected);
    const meld = view.melds.find((m) => m.id === meldId);
    const hasJoker = meld && meld.entries.some((e) => S.isJoker(e.card));
    if (ids.length === 1 && hasJoker && matchesJoker(meld, view.hand.find((c) => c.id === ids[0]))) {
      act('swap', { meldId, id: ids[0] });
    } else act('attach', { meldId, ids });
  }
  function matchesJoker(meld, card) {
    if (!card || S.isJoker(card)) return false;
    const je = meld.entries.find((e) => S.isJoker(e.card));
    const real = meld.entries.filter((e) => !S.isJoker(e.card)).map((e) => e.card);
    if (meld.type === 'run') return card.suit === real[0].suit && card.rank === (je.pos === 14 ? 1 : je.pos);
    return meld.entries.length === 4 && card.rank === real[0].rank && !real.some((c) => c.suit === card.suit);
  }

  $('nextRoundBtn').onclick = () => {
    if (mode === 'online') {
      if (view.winner != null) send({ type: 'start' }); else send({ type: 'next' });
      return;
    }
    if (view.winner != null) { localGame = null; view = null; show('roundOver', false); show('home', true); return; }
    S.nextRound(localGame); resetUi(); refreshLocal();
  };
  $('rulesBtn').onclick = $('rulesLink').onclick = $('homeRules').onclick = $('lobbyRules').onclick = () => show('rules', true);
  $('closeRules').onclick = () => show('rules', false);

  // ---------- each player arranges their own hand ----------
  function orderedHand() {
    const me = view.me;
    const byId = new Map(view.hand.map((c) => [c.id, c]));
    let ord = (handOrder[me] || []).filter((id) => byId.has(id));
    const known = new Set(ord);
    const fresh = view.hand.filter((c) => !known.has(c.id));
    if (!handOrder[me]) ord = S.sortHand(fresh).map((c) => c.id);
    else ord = ord.concat(fresh.map((c) => c.id));
    handOrder[me] = ord;
    return ord.map((id) => byId.get(id));
  }
  function sortBy(mode2) {
    const suitOrder = { S: 0, H: 1, C: 2, D: 3 };
    const hand = view.hand.slice().sort((a, b) => {
      if (S.isJoker(a) !== S.isJoker(b)) return S.isJoker(a) ? 1 : -1;
      if (S.isJoker(a)) return a.id - b.id;
      if (mode2 === 'rank') return a.rank - b.rank || suitOrder[a.suit] - suitOrder[b.suit];
      return suitOrder[a.suit] - suitOrder[b.suit] || a.rank - b.rank;
    });
    handOrder[view.me] = hand.map((c) => c.id);
    render();
  }
  $('sortSuit').onclick = () => sortBy('suit');
  $('sortRank').onclick = () => sortBy('rank');
  function moveCard(id, beforeId) {
    const ord = handOrder[view.me].filter((x) => x !== id);
    const at = beforeId == null ? ord.length : ord.indexOf(beforeId);
    ord.splice(at < 0 ? ord.length : at, 0, id);
    handOrder[view.me] = ord;
  }
  function toggle(id) { if (selected.has(id)) selected.delete(id); else selected.add(id); render(); }
  function startDrag(ev, id, el) {
    if (ev.button !== undefined && ev.button !== 0) return;
    drag = { id, x: ev.clientX, y: ev.clientY, moving: false, before: null };
    el.setPointerCapture(ev.pointerId);
    el.onpointermove = (e) => {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moving && Math.hypot(dx, dy) < 6) return;
      drag.moving = true;
      el.classList.add('dragging');
      el.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
      document.querySelectorAll('#hand .card.drop-before').forEach((n) => n.classList.remove('drop-before'));
      drag.before = null;
      for (const other of document.querySelectorAll('#hand .card')) {
        if (other === el) continue;
        const rc = other.getBoundingClientRect();
        if (e.clientY < rc.top || (e.clientY <= rc.bottom && e.clientX < rc.left + rc.width / 2)) {
          drag.before = Number(other.dataset.id); other.classList.add('drop-before'); break;
        }
      }
    };
    el.onpointerup = el.onpointercancel = () => {
      el.onpointermove = el.onpointerup = el.onpointercancel = null;
      const d = drag; drag = null;
      if (!d) return;
      if (d.moving) { moveCard(d.id, d.before); render(); } else toggle(d.id);
    };
  }

  // ---------- drawing the screen ----------
  function renderLobby() {
    const waiting = mode === 'online' && online.joined && lobby && (!lobby.started || !view);
    show('lobby', !!waiting);
    if (!waiting) return;
    $('lobbyCode').textContent = lobby.code + (lobby.label ? ' · ' + lobby.label : '');
    $('inviteLink').value = inviteUrl();
    const list = $('seatList'); list.innerHTML = '';
    lobby.seats.forEach((s, i) => {
      const li = document.createElement('li');
      li.innerHTML = '<span class="dot' + (s.connected ? '' : ' off') + '"></span>' + esc(s.name) +
        (i === lobby.seat ? ' (you)' : '') + (i === 0 ? ' · host' : '');
      list.appendChild(li);
    });
    show('startBtn', lobby.isHost);
    $('startBtn').disabled = lobby.seats.length < 2;
    $('lobbyNote').textContent = lobby.isHost
      ? (lobby.seats.length < 2 ? 'Waiting for at least one more player…' : 'Deal when everyone is here.')
      : 'Waiting for ' + lobby.seats[0].name + ' (the host) to deal…';
    $('lobbyErr').textContent = message.kind === 'err' ? message.text : '';
  }

  function render() {
    renderLobby();
    if (!view) return;
    const local = mode === 'local';
    const me = view.me;
    const withChat = mode === 'online';
    show('chat', withChat);
    show('inviteBtn', withChat && !!lobby);
    show('chatToggle', withChat && phone());
    document.querySelector('.table').classList.toggle('withchat', withChat);
    const myTurn = view.turn === me;
    const over = view.phase === 'over';
    const hidden = local && revealedFor !== view.turn && !over;

    $('round').textContent = 'Round ' + view.roundNumber + ' · dealer ' + view.players[view.dealer].name +
      (mode === 'online' && lobby ? ' · table ' + lobby.code : '');
    const pbox = $('players'); pbox.innerHTML = '';
    view.players.forEach((p, i) => {
      const chip = document.createElement('div');
      chip.className = 'pchip' + (i === view.turn && !over ? ' turn' : '') + (p.eliminated ? ' out' : '');
      chip.dataset.seat = i;
      const conn = mode === 'online' && lobby && lobby.seats[i] ? '<span class="dot' + (lobby.seats[i].connected ? '' : ' off') + '" title="' + (lobby.seats[i].connected ? 'online' : 'offline') + '"></span>' : '';
      chip.innerHTML = conn + '<span>' + esc(p.name) + (mode === 'online' && i === me ? ' (you)' : '') + '</span>' +
        '<span class="score">' + p.score + '</span>' +
        (p.eliminated ? '' : '<span class="badge' + (p.opened ? '' : ' no') + '">' + (p.opened ? 'open' : p.cards + '<span class="cw"> cards</span>') + '</span>');
      pbox.appendChild(chip);
    });

    $('stockCount').textContent = view.stockCount + ' in stock';
    const dt = $('discardTop'); dt.innerHTML = '';
    if (view.discardTop) dt.appendChild(cardEl(view.discardTop));
    else { const e = document.createElement('div'); e.className = 'back'; e.style.opacity = '.2'; dt.appendChild(e); }
    const canDraw = view.phase === 'draw' && myTurn && !hidden;
    $('drawHint').textContent = canDraw ? 'Draw a card' : '';
    $('stockBtn').disabled = !canDraw;
    $('discardBtn').disabled = !canDraw || !view.discardTop;

    const logBox = $('log'); logBox.innerHTML = '';
    if (mode === 'online') view.log.slice(-5).forEach((line) => { const li = document.createElement('li'); li.textContent = line; logBox.appendChild(li); });

    const playing = view.phase === 'play' && myTurn && !hidden;
    const ts = view.turnState;
    const mbox = $('melds'); mbox.innerHTML = '';
    if (!view.melds.length) {
      const e = document.createElement('div'); e.className = 'empty';
      e.textContent = 'No combinations on the table yet. Open with sets and runs worth at least ' + view.openingPoints + ' points.';
      mbox.appendChild(e);
    }
    const canTarget = playing && selected.size > 0 && ts && ts.startOpened;
    view.melds.forEach((m) => {
      const box = document.createElement('div');
      box.className = 'meld' + (canTarget ? ' target' : '');
      box.tabIndex = canTarget ? 0 : -1;
      const owner = document.createElement('div'); owner.className = 'owner';
      owner.textContent = view.players[m.owner].name + ' · ' + m.type;
      const row = document.createElement('div'); row.className = 'row';
      m.entries.forEach((e) => {
        let stands = null;
        if (S.isJoker(e.card)) {
          const real = m.entries.find((x) => !S.isJoker(x.card)).card;
          stands = m.type === 'run' ? posLabel(e.pos) + S.SUIT_SYMBOL[real.suit] : rankLabel(real.rank) + '?';
        }
        row.appendChild(cardEl(e.card, { stands }));
      });
      box.appendChild(owner); box.appendChild(row);
      if (canTarget) {
        box.onclick = () => onMeldClick(m.id);
        box.onkeydown = (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onMeldClick(m.id); } };
        box.setAttribute('role', 'button');
        box.setAttribute('aria-label', 'Attach selected cards to ' + view.players[m.owner].name + "'s " + m.type);
      }
      mbox.appendChild(box);
    });

    $('who').textContent = over ? 'Round over'
      : mode === 'online' ? (myTurn ? 'Your turn' : view.players[view.turn].name + "'s turn")
      : view.players[view.turn].name + "'s turn";
    const prog = $('progress');
    if (!over && !view.players[me].opened && !hidden) {
      const pts = ts ? ts.newMeldPoints : 0;
      prog.textContent = 'Opening ' + pts + ' / ' + view.openingPoints;
      prog.className = 'progress' + (pts >= view.openingPoints ? ' done' : '');
    } else { prog.textContent = ''; prog.className = 'progress hidden'; }
    const msg = $('msg'); msg.textContent = message.text; msg.className = 'msg ' + message.kind;

    const hbox = $('hand'); hbox.innerHTML = '';
    if (!hidden) {
      orderedHand().forEach((c) => {
        const el = cardEl(c);
        el.tabIndex = 0;
        el.dataset.id = c.id;
        el.setAttribute('role', 'button');
        el.setAttribute('aria-pressed', selected.has(c.id) ? 'true' : 'false');
        el.title = 'Click to select. Drag to move. Shift + arrow keys also move it.';
        if (selected.has(c.id)) el.classList.add('sel');
        if (c.id === lastDrawnId && view.phase === 'play' && myTurn) el.classList.add('new');
        el.addEventListener('pointerdown', (ev) => startDrag(ev, c.id, el));
        el.onkeydown = (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(c.id); }
          else if (ev.shiftKey && (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight')) {
            ev.preventDefault();
            const ord = handOrder[me]; const i = ord.indexOf(c.id);
            const j = ev.key === 'ArrowLeft' ? i - 1 : i + 1;
            if (j < 0 || j >= ord.length) return;
            ord.splice(i, 1); ord.splice(j, 0, c.id);
            render();
            const again = document.querySelector('#hand .card[data-id="' + c.id + '"]'); if (again) again.focus();
          }
        };
        hbox.appendChild(el);
      });
    }
    $('layBtn').disabled = !playing || selected.size < 3;
    $('discardSelBtn').disabled = !playing || selected.size !== 1;
    $('resetBtn').disabled = !playing;
    const tookId = playing && ts ? ts.tookDiscardId : null;
    const canPutBack = tookId != null && view.hand.some((c) => c.id === tookId);
    show('putBackBtn', canPutBack);
    document.querySelector('.actions').classList.toggle('five', canPutBack);
    $('clearBtn').disabled = selected.size === 0;
    $('sortSuit').disabled = hidden;
    $('sortRank').disabled = hidden;
    const pv = $('preview');
    if (!hidden && selected.size >= 3) {
      const v = S.splitIntoMelds(view.hand.filter((c) => selected.has(c.id)));
      pv.textContent = !v.ok ? 'Not a set or run'
        : v.melds.length === 1 ? 'Valid ' + v.melds[0].type + ' · ' + v.value + ' pts'
        : v.melds.length + ' combinations · ' + v.value + ' pts';
      pv.className = 'preview ' + (v.ok ? 'good' : 'bad');
    } else { pv.textContent = ''; pv.className = 'preview'; }

    show('handoff', local && hidden);
    $('handoffTitle').textContent = view.players[view.turn].name + ', your turn';
    renderRoundOver();
  }

  function renderRoundOver() {
    if (view.phase !== 'over') { show('roundOver', false); return; }
    show('roundOver', true);
    const res = view.result;
    const w = view.players[res.winner].name;
    $('roundTitle').textContent = view.winner != null ? view.players[view.winner].name + ' wins the game!' : w + ' goes out';
    $('roundText').textContent = res.doubled
      ? w + ' went out in a single turn without having opened before, so penalties are doubled.'
      : 'Penalties are the cards left in each hand (100 if never opened). 101 or more and you are out.';
    const t = $('roundTable');
    t.innerHTML = '<tr><th>Player</th><th class="num">This round</th><th class="num">Total</th><th></th></tr>';
    view.players.forEach((p, i) => {
      const tr = document.createElement('tr');
      const status = p.eliminated ? (res.eliminated.includes(i) ? 'eliminated' : 'out') : (i === res.winner ? 'went out' : '');
      tr.innerHTML = '<td>' + esc(p.name) + '</td><td class="num">' + (res.penalties[i] ? '+' + res.penalties[i] : '0') +
        '</td><td class="num">' + p.score + '</td><td>' + status + '</td>';
      t.appendChild(tr);
    });
    const btn = $('nextRoundBtn');
    if (view.winner != null) {
      btn.textContent = mode === 'online' ? 'Play again' : 'New game';
      btn.disabled = mode === 'online' && !(lobby && lobby.isHost);
      if (btn.disabled) btn.textContent = 'Waiting for ' + view.players[0].name + ' to start a new game';
    } else { btn.textContent = 'Deal the next round'; btn.disabled = false; }
  }

  bootFromUrl();
})();
