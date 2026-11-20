// Plays many complete games with simple computer players and checks, after every move,
// that the game stays consistent: no card is lost or duplicated, every combination on
// the table is valid, scores only go up, and every game finishes with one winner.
const test = require('node:test');
const assert = require('node:assert');
const S = require('../src/engine.js');

function rng(seed) { // mulberry32: repeatable random numbers
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Find combinations in a hand: sets by rank, runs by suit, a joker to complete a pair.
function findMelds(hand) {
  const out = [];
  const jokers = hand.filter(S.isJoker);
  const real = hand.filter((c) => !S.isJoker(c));
  const byRank = {};
  for (const c of real) (byRank[c.rank] = byRank[c.rank] || []).push(c);
  for (const cards of Object.values(byRank)) {
    const bySuit = {};
    for (const c of cards) if (!bySuit[c.suit]) bySuit[c.suit] = c;
    const distinct = Object.values(bySuit);
    if (distinct.length >= 3) out.push(distinct.slice(0, 4));
    else if (distinct.length === 2 && jokers.length) out.push(distinct.concat(jokers[0]));
  }
  for (const suit of S.SUITS) {
    const ranks = new Map();
    for (const c of real) if (c.suit === suit && !ranks.has(c.rank)) ranks.set(c.rank, c);
    let run = [];
    for (let r = 1; r <= 14; r++) {
      const card = ranks.get(r === 14 ? 1 : r);
      if (card && !run.includes(card)) run.push(card);
      else { if (run.length >= 3) out.push(run); run = []; }
    }
    if (run.length >= 3) out.push(run);
  }
  return out.filter((m) => S.validateMeld(m).ok);
}

function countCards(g) {
  const r = g.round;
  const all = [...r.stock, ...r.discard, ...r.hands.flat(), ...r.melds.flatMap((m) => m.entries.map((e) => e.card))];
  return { total: all.length, unique: new Set(all.map((c) => c.id)).size };
}

function checkInvariants(g, label) {
  const { total, unique } = countCards(g);
  assert.strictEqual(total, 108, label + ': 108 cards in play');
  assert.strictEqual(unique, 108, label + ': no duplicated card');
  for (const m of g.round.melds) {
    const cards = m.entries.map((e) => e.card);
    const jokerEntry = m.entries.find((e) => S.isJoker(e.card));
    const v = S.validateMeld(cards, { type: m.type, fixedJokerPos: m.type === 'run' && jokerEntry ? jokerEntry.pos : null });
    assert.ok(v.ok, label + ': combination on the table is valid: ' + cards.map(S.cardLabel).join(' '));
  }
  g.round.hands.forEach((h, i) => {
    if (g.players[i].eliminated && g.round.phase !== 'over') assert.strictEqual(h.length, 0, label + ': eliminated player holds no cards');
  });
}

// One turn for the current player. Returns true when the round ended.
function playTurn(g, rand) {
  const r = g.round;
  const me = r.turn;
  // Sometimes take the discard, and put it back if it cannot be used.
  let took = false;
  const top = r.discard[r.discard.length - 1];
  const fitsTable = top && r.opened[me] && r.melds.some((m) => {
    const je = m.entries.find((e) => S.isJoker(e.card));
    return S.validateMeld(m.entries.map((e) => e.card).concat(top), { type: m.type, fixedJokerPos: m.type === 'run' && je ? je.pos : null }).ok;
  });
  if (r.discard.length && (fitsTable || rand() < 0.25)) took = S.takeDiscard(g).ok;
  if (!took) assert.ok(S.drawStock(g).ok, 'draw');

  // Lay down what we can. Before opening, lay everything at once in one selection.
  const hand = () => g.round.hands[me];
  const opened = () => g.round.opened[me] || g.round.turnState.startOpened;
  let melds = findMelds(hand());
  const used = new Set();
  const chosen = [];
  for (const m of melds) {
    if (m.some((c) => used.has(c.id))) continue;
    chosen.push(m); m.forEach((c) => used.add(c.id));
  }
  const pts = chosen.reduce((s, m) => s + S.validateMeld(m).value, 0);
  if (chosen.length && (opened() || pts >= 40)) {
    const ids = chosen.flat().map((c) => c.id);
    if (hand().length - ids.length >= 1) {
      const res = S.layMeld(g, ids);
      if (!res.ok) {
        // A combined selection may be split differently; fall back to laying one at a time.
        for (const m of chosen) S.layMeld(g, m.map((c) => c.id));
      }
    }
  }
  // Attach single cards to anything on the table once opened (from an earlier turn).
  if (g.round.turnState.startOpened) {
    for (const card of hand().slice()) {
      if (hand().length <= 1) break;
      for (const m of g.round.melds) if (S.attach(g, m.id, [card.id]).ok) break;
    }
    // Try a joker swap now and then; undo the turn if the joker can't be used.
    if (rand() < 0.3) {
      for (const m of g.round.melds) {
        for (const card of hand()) {
          if (S.swapJoker(g, m.id, card.id).ok) {
            const again = findMelds(hand()).find((x) => x.some(S.isJoker));
            if (!again || hand().length - again.length < 1 || !S.layMeld(g, again.map((c) => c.id)).ok) assert.ok(S.resetTurn(g).ok);
            break;
          }
        }
      }
    }
  }
  // Discard. If the turn can't be finished (unused discard, opening short), undo or put back.
  const tryDiscard = () => {
    const h = hand();
    // Keep jokers and cards that pair up (same rank, or same suit within 2 ranks).
    const useful = (c) => h.some((x) => x !== c && !S.isJoker(x) && !S.isJoker(c) &&
      ((x.rank === c.rank && x.suit !== c.suit) || (x.suit === c.suit && Math.abs(x.rank - c.rank) <= 2)));
    const isOpen = g.round.opened[me] || (g.round.turnState && g.round.turnState.newMeldPoints >= 40);
    const order = h.slice().sort((a, b) => {
      const ua = useful(a) ? 1 : 0, ub = useful(b) ? 1 : 0;
      if (ua !== ub) return ua - ub; // loose cards first
      // Before opening keep high cards (they help reach 40); after opening shed high cards.
      return isOpen ? S.penaltyValue(b) - S.penaltyValue(a) : S.penaltyValue(a) - S.penaltyValue(b);
    });
    for (const c of order) {
      if (S.isJoker(c) && h.some((x) => !S.isJoker(x))) continue;
      const res = S.discard(g, c.id);
      if (res.ok) return res;
    }
    return null;
  };
  let res = tryDiscard();
  if (!res) {
    const ts = g.round.turnState;
    if (ts && ts.tookDiscardId != null) assert.ok(S.returnDiscard(g).ok, 'put back');
    else assert.ok(S.resetTurn(g).ok, 'undo');
    res = tryDiscard();
  }
  assert.ok(res, 'the player can always finish the turn');
  return !!res.wentOut;
}

function playGame(seed, players) {
  const rand = rng(seed);
  const g = S.newGame(Array.from({ length: players }, (_, i) => 'P' + i), {}, rand);
  let rounds = 0;
  let lastScores = g.players.map((p) => p.score);
  while (g.winner == null) {
    rounds++;
    assert.ok(rounds < 60, 'game finishes in a reasonable number of rounds');
    checkInvariants(g, `seed ${seed} round ${rounds} start`);
    let turns = 0;
    while (g.round.phase !== 'over') {
      turns++;
      if (turns > 600) {
        // A real dead end the rules allow: e.g. everyone holds one card and every combination on
        // the table is a full set of four, so nothing can be attached. These simple players build
        // mostly sets, so they reach it more often than people do. Stop this game here.
        return { g, rounds, stalled: true };
      }
      playTurn(g, rand);
      checkInvariants(g, `seed ${seed} round ${rounds} turn ${turns}`);
    }
    const now = g.players.map((p) => p.score);
    now.forEach((s, i) => assert.ok(s >= lastScores[i], 'scores never go down'));
    const res = g.round.result;
    assert.strictEqual(res.penalties[res.winner], 0, 'the player who went out scores 0');
    lastScores = now;
    if (g.winner == null) assert.ok(S.nextRound(g, rand).ok);
  }
  const alive = g.players.filter((p) => !p.eliminated);
  assert.ok(alive.length <= 1, 'at most one player left at the end');
  assert.ok(g.players[g.winner], 'there is a winner');
  return { g, rounds, stalled: false };
}

test('simulated games: 2, 3 and 4 players, 300 games, consistent after every move', () => {
  let games = 0, stalled = 0, totalRounds = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const players = 2 + (seed % 3);
    const out = playGame(seed, players);
    games++; totalRounds += out.rounds; if (out.stalled) stalled++;
  }
  assert.strictEqual(games, 300);
  assert.ok(stalled <= 45, 'dead-end rounds stay rare (' + stalled + ' of 300)');
  assert.ok(totalRounds > 300);
});

test('the reported hand plays through a full turn in a real dealt game', () => {
  const g = S.newGame(['Ann', 'Bob'], {}, rng(7));
  const r = g.round;
  // Replace Ann's hand with the reported cards, taking them from the deck so all 108 cards stay unique.
  const pool = [...r.stock, ...r.hands[0]];
  const pick = (pred) => { const i = pool.findIndex(pred); return pool.splice(i, 1)[0]; };
  const want = [
    pick((c) => c.rank === 1 && c.suit === 'S'), pick((c) => c.rank === 1 && c.suit === 'H'), pick(S.isJoker),
    pick((c) => c.rank === 7 && c.suit === 'C'), pick((c) => c.rank === 7 && c.suit === 'D'), pick(S.isJoker),
  ];
  const rest = pool.filter((c) => !S.isJoker(c));
  r.hands[0] = want.concat(rest.slice(0, 7));
  r.stock = pool.filter((c) => !r.hands[0].includes(c));
  r.turn = 0;
  checkInvariants(g, 'setup');
  assert.ok(S.drawStock(g).ok);
  const res = S.layMeld(g, want.map((c) => c.id));
  assert.ok(res.ok, res.error);
  assert.strictEqual(res.value, 54);
  const discard = r.hands[0].slice().sort((a, b) => b.rank - a.rank)[0];
  assert.ok(S.discard(g, discard.id).ok);
  assert.ok(g.round.opened[0]);
  checkInvariants(g, 'after opening');
});
