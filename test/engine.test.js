const test = require('node:test');
const assert = require('node:assert');
const S = require('../src/engine.js');

let nextId = 1000;
const c = (rank, suit) => ({ id: nextId++, rank, suit });
const J = () => ({ id: nextId++, rank: 0, suit: null });

test('deck has 108 cards with 4 jokers', () => {
  const d = S.makeDeck();
  assert.strictEqual(d.length, 108);
  assert.strictEqual(d.filter(S.isJoker).length, 4);
});

test('sets', () => {
  assert.ok(S.validateMeld([c(7, 'S'), c(7, 'H'), c(7, 'D')]).ok);
  assert.ok(!S.validateMeld([c(7, 'S'), c(7, 'S'), c(7, 'D')]).ok, 'repeated suit');
  assert.ok(S.validateMeld([c(9, 'S'), c(9, 'H'), J()]).ok);
  assert.strictEqual(S.validateMeld([c(1, 'S'), c(1, 'H'), c(1, 'D')]).value, 33);
  assert.ok(!S.validateMeld([c(9, 'S'), J(), J()]).ok, 'two jokers');
});

test('runs: ace low and high, no wrap', () => {
  const low = S.validateMeld([c(1, 'H'), c(2, 'H'), c(3, 'H')]);
  assert.ok(low.ok); assert.strictEqual(low.value, 6);
  const high = S.validateMeld([c(12, 'H'), c(13, 'H'), c(1, 'H')]);
  assert.ok(high.ok); assert.strictEqual(high.value, 31);
  assert.ok(!S.validateMeld([c(13, 'H'), c(1, 'H'), c(2, 'H')]).ok, 'wrap');
  assert.ok(!S.validateMeld([c(5, 'H'), c(6, 'S'), c(7, 'H')]).ok, 'mixed suits');
});

test('runs with a joker fill gaps or extend', () => {
  const gap = S.validateMeld([c(5, 'C'), J(), c(7, 'C')]);
  assert.ok(gap.ok); assert.strictEqual(gap.entries[1].pos, 6); assert.strictEqual(gap.value, 18);
  const ext = S.validateMeld([c(12, 'C'), c(13, 'C'), J()]);
  assert.ok(ext.ok); assert.strictEqual(ext.entries[2].pos, 14);
  assert.ok(!S.validateMeld([c(5, 'C'), J(), c(8, 'C')]).ok);
});

// Build a game with a rigged round for rule tests.
function rigged(hands, discardTop, stock) {
  const g = S.newGame(['A', 'B', 'C'], {}, () => 0.5);
  const r = g.round;
  r.hands = hands;
  r.discard = [discardTop];
  r.stock = stock || [c(4, 'S'), c(4, 'H'), c(4, 'D'), c(4, 'C'), c(9, 'D'), c(9, 'C')];
  r.turn = 0;
  r.phase = 'draw';
  r.melds = [];
  r.opened = [false, false, false];
  return g;
}

test('opening needs 40 points, and resetting the turn works', () => {
  const k1 = c(13, 'S'), k2 = c(13, 'H'), k3 = c(13, 'D');
  const q1 = c(12, 'S'), q2 = c(12, 'H'), q3 = c(12, 'D');
  const keep = c(2, 'C');
  const g = rigged([[k1, k2, k3, q1, q2, q3, keep], [c(5, 'S')], [c(6, 'S')]], c(3, 'C'));
  assert.ok(S.drawStock(g).ok);
  assert.ok(S.layMeld(g, [k1.id, k2.id, k3.id]).ok); // 30 points
  const r1 = S.discard(g, keep.id);
  assert.ok(!r1.ok && /40/.test(r1.error));
  assert.ok(S.resetTurn(g).ok);
  assert.strictEqual(g.round.melds.length, 0);
  assert.ok(S.layMeld(g, [k1.id, k2.id, k3.id]).ok);
  assert.ok(S.layMeld(g, [q1.id, q2.id, q3.id]).ok); // 60 points
  assert.ok(S.discard(g, keep.id).ok);
  assert.ok(g.round.opened[0]);
});

test('discard pickup must be used this turn', () => {
  const top = c(9, 'H');
  const g = rigged([[c(2, 'S'), c(5, 'D')], [c(5, 'S')], [c(6, 'S')]], top);
  assert.ok(S.takeDiscard(g).ok);
  const r = S.discard(g, g.round.hands[0][0].id);
  assert.ok(!r.ok);
});

test('cannot attach before opening, nor lay down the last card', () => {
  const a = c(5, 'H'), b = c(6, 'H'), d = c(7, 'H');
  const g = rigged([[a, b, d], [c(5, 'S')], [c(6, 'S')]], c(3, 'C'), [c(8, 'H')]);
  assert.ok(S.drawStock(g).ok);
  // 4 cards: 5,6,7,8 of hearts — laying all four would leave nothing to discard.
  const all = g.round.hands[0].map((x) => x.id);
  assert.ok(!S.layMeld(g, all).ok);
});

test('joker swap in a run, joker must then be used', () => {
  const g = rigged([[c(6, 'C'), c(9, 'S'), c(9, 'H'), c(2, 'D')], [c(5, 'S')], [c(6, 'S')]], c(3, 'C'), [c(9, 'D')]);
  g.round.opened[0] = true;
  const joker = J();
  g.round.melds.push({ id: 50, owner: 1, type: 'run', entries: [{ card: c(5, 'C'), pos: 5 }, { card: joker, pos: 6 }, { card: c(7, 'C'), pos: 7 }] });
  assert.ok(S.drawStock(g).ok);
  const six = g.round.hands[0].find((x) => x.rank === 6);
  assert.ok(S.swapJoker(g, 50, six.id).ok);
  assert.ok(g.round.hands[0].some(S.isJoker));
  const two = g.round.hands[0].find((x) => x.rank === 2);
  assert.ok(!S.discard(g, two.id).ok, 'joker must be used');
  const nines = g.round.hands[0].filter((x) => x.rank === 9).map((x) => x.id);
  const jk = g.round.hands[0].find(S.isJoker).id;
  assert.ok(S.layMeld(g, [nines[0], nines[1], jk]).ok || S.layMeld(g, nines.concat(jk)).ok);
  assert.ok(S.discard(g, two.id).ok);
});

test('scoring: penalties, never-opened 100, doubling on close in hand, elimination', () => {
  const k1 = c(13, 'S'), k2 = c(13, 'H'), k3 = c(13, 'D'), k4 = c(13, 'C');
  const last = c(2, 'C');
  const g = rigged([[k1, k2, k3, k4], [c(1, 'S'), J()], [c(6, 'S')]], c(3, 'C'), [c(12, 'S'), c(12, 'H'), last]);
  g.round.opened = [false, true, false];
  g.round.stock = [last];
  assert.ok(S.drawStock(g).ok); // draws the 2C
  assert.ok(S.layMeld(g, [k1.id, k2.id, k3.id, k4.id]).ok); // 40 points
  const res = S.discard(g, last.id);
  assert.ok(res.ok && res.wentOut);
  const rr = g.round.result;
  assert.ok(rr.doubled);
  assert.strictEqual(rr.penalties[1], (11 + 25) * 2);
  assert.strictEqual(rr.penalties[2], 200);
  assert.ok(g.players[2].eliminated);
});

test('putting the discard back returns it and draws from the stock', () => {
  const top = c(9, 'H');
  const stockCard = c(4, 'S');
  const g = rigged([[c(2, 'S'), c(5, 'D')], [c(5, 'S')], [c(6, 'S')]], top, [stockCard]);
  assert.ok(S.takeDiscard(g).ok);
  const res = S.returnDiscard(g);
  assert.ok(res.ok);
  assert.strictEqual(g.round.discard[g.round.discard.length - 1].id, top.id);
  assert.ok(g.round.hands[0].some((x) => x.id === stockCard.id));
  assert.ok(!g.round.hands[0].some((x) => x.id === top.id));
  assert.strictEqual(g.round.phase, 'play');
  assert.ok(S.discard(g, g.round.hands[0][0].id).ok);
});

test('the taken discard can be put back even after laying it in a combination that does not open', () => {
  const top = c(4, 'H');
  const stockCard = c(10, 'C');
  const g = rigged([[c(2, 'H'), c(3, 'H'), c(9, 'S')], [c(5, 'S')], [c(6, 'S')]], top, [stockCard]);
  assert.ok(S.takeDiscard(g).ok);
  const ids = g.round.hands[0].filter((x) => x.suit === 'H').map((x) => x.id);
  assert.ok(S.layMeld(g, ids).ok); // 2-3-4 of hearts = 9 points, not enough to open
  const bad = S.discard(g, g.round.hands[0][0].id);
  assert.ok(!bad.ok && /Put it back/.test(bad.error));
  const res = S.returnDiscard(g);
  assert.ok(res.ok);
  assert.strictEqual(g.round.melds.length, 0);
  assert.strictEqual(g.round.discard[g.round.discard.length - 1].id, top.id);
  assert.strictEqual(g.round.hands[0].length, 4);
  assert.ok(g.round.hands[0].some((x) => x.id === stockCard.id));
  assert.ok(S.discard(g, stockCard.id).ok);
});
