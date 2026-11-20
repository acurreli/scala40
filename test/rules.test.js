// Detailed rule tests for the Scala 40 engine: combinations, opening, laying several
// combinations at once, attaching, jokers, the discard pile, going out and scoring.
const test = require('node:test');
const assert = require('node:assert');
const S = require('../src/engine.js');

let nextId = 5000;
const c = (rank, suit) => ({ id: nextId++, rank, suit });
const J = () => ({ id: nextId++, rank: 0, suit: null });
const ids = (...cards) => cards.map((x) => x.id);

// A 3-player game whose round we set up by hand. Player 0 is to move, in the draw phase.
function rigged(hands, { discard, stock, opened } = {}) {
  const g = S.newGame(['Ann', 'Bob', 'Cleo'], {}, () => 0.5);
  const r = g.round;
  r.hands = hands;
  r.discard = discard || [c(3, 'C')];
  r.stock = stock || [c(4, 'S'), c(9, 'D'), c(10, 'C'), c(2, 'H')];
  r.turn = 0;
  r.phase = 'draw';
  r.melds = [];
  r.opened = opened || [false, false, false];
  r.turnState = null;
  r.snapshot = null;
  return g;
}
const filler = () => [c(5, 'S'), c(8, 'D')];

// ---------------------------------------------------------------- combinations
test('sets: 3 or 4 cards, same rank, different suits', () => {
  assert.ok(S.validateMeld([c(7, 'S'), c(7, 'H'), c(7, 'D')]).ok);
  assert.ok(S.validateMeld([c(7, 'S'), c(7, 'H'), c(7, 'D'), c(7, 'C')]).ok);
  assert.ok(!S.validateMeld([c(7, 'S'), c(7, 'H')]).ok, 'two cards');
  assert.ok(!S.validateMeld([c(7, 'S'), c(7, 'S'), c(7, 'D')]).ok, 'same suit twice (two decks)');
  assert.ok(!S.validateMeld([c(7, 'S'), c(7, 'H'), c(8, 'D')]).ok, 'mixed ranks');
  assert.ok(!S.validateMeld([c(7, 'S'), c(7, 'H'), c(7, 'D'), c(7, 'C'), J()]).ok, 'five cards');
});

test('sets with a joker', () => {
  const aces = S.validateMeld([c(1, 'S'), c(1, 'H'), J()]);
  assert.ok(aces.ok); assert.strictEqual(aces.type, 'set'); assert.strictEqual(aces.value, 33);
  const sevens = S.validateMeld([c(7, 'C'), c(7, 'D'), J()]);
  assert.ok(sevens.ok); assert.strictEqual(sevens.value, 21);
  assert.strictEqual(S.validateMeld([c(13, 'S'), c(13, 'H'), c(13, 'D'), J()]).value, 40);
  assert.ok(!S.validateMeld([c(9, 'S'), J(), J()]).ok, 'two jokers');
  assert.ok(!S.validateMeld([J(), J(), J()]).ok, 'only jokers');
});

test('set values: aces 11, figures 10, others face value', () => {
  assert.strictEqual(S.validateMeld([c(1, 'S'), c(1, 'H'), c(1, 'D')]).value, 33);
  assert.strictEqual(S.validateMeld([c(11, 'S'), c(11, 'H'), c(11, 'D')]).value, 30);
  assert.strictEqual(S.validateMeld([c(12, 'S'), c(12, 'H'), c(12, 'D')]).value, 30);
  assert.strictEqual(S.validateMeld([c(2, 'S'), c(2, 'H'), c(2, 'D')]).value, 6);
});

test('runs: same suit, consecutive, ace low or high, no wrap-around', () => {
  assert.strictEqual(S.validateMeld([c(1, 'H'), c(2, 'H'), c(3, 'H')]).value, 6);
  assert.strictEqual(S.validateMeld([c(12, 'H'), c(13, 'H'), c(1, 'H')]).value, 31);
  assert.strictEqual(S.validateMeld([c(10, 'S'), c(11, 'S'), c(12, 'S'), c(13, 'S'), c(1, 'S')]).value, 51);
  assert.ok(S.validateMeld([c(4, 'D'), c(5, 'D'), c(6, 'D'), c(7, 'D'), c(8, 'D'), c(9, 'D')]).ok);
  assert.ok(!S.validateMeld([c(13, 'H'), c(1, 'H'), c(2, 'H')]).ok, 'wrap K-A-2');
  assert.ok(!S.validateMeld([c(5, 'H'), c(6, 'S'), c(7, 'H')]).ok, 'mixed suits');
  assert.ok(!S.validateMeld([c(5, 'H'), c(7, 'H'), c(8, 'H')]).ok, 'gap without joker');
  assert.ok(!S.validateMeld([c(5, 'H'), c(5, 'H'), c(6, 'H')]).ok, 'repeated rank');
  // A full 14-card run A..K..A is impossible with a single deck of ranks, but A-2..K is fine:
  const full = []; for (let r = 1; r <= 13; r++) full.push(c(r, 'C'));
  assert.ok(S.validateMeld(full).ok);
});

test('runs with a joker: fills a gap or extends, one joker only', () => {
  const gap = S.validateMeld([c(5, 'C'), J(), c(7, 'C')]);
  assert.ok(gap.ok); assert.strictEqual(gap.value, 18);
  const top = S.validateMeld([c(12, 'C'), c(13, 'C'), J()]);
  assert.ok(top.ok); assert.strictEqual(top.entries[2].pos, 14);
  const low = S.validateMeld([c(2, 'C'), c(3, 'C'), J()]);
  assert.ok(low.ok);
  assert.ok(!S.validateMeld([c(5, 'C'), J(), c(8, 'C')]).ok, 'gap of two');
  assert.ok(!S.validateMeld([c(5, 'C'), J(), J(), c(8, 'C')]).ok, 'two jokers');
});

// ---------------------------------------------------------------- several combinations at once
test('splitIntoMelds: the reported case, two aces + joker and two sevens + joker = 54', () => {
  const res = S.splitIntoMelds([c(1, 'S'), c(1, 'H'), J(), c(7, 'C'), c(7, 'D'), J()]);
  assert.ok(res.ok);
  assert.strictEqual(res.melds.length, 2);
  assert.strictEqual(res.value, 54);
});

test('splitIntoMelds: mixed set and run, cards in any order', () => {
  const res = S.splitIntoMelds([c(8, 'H'), c(13, 'S'), c(6, 'H'), c(13, 'D'), c(7, 'H'), c(13, 'C')]);
  assert.ok(res.ok);
  assert.strictEqual(res.melds.length, 2);
  assert.strictEqual(res.value, 21 + 30);
});

test('splitIntoMelds: three combinations', () => {
  const res = S.splitIntoMelds([
    c(2, 'S'), c(2, 'H'), c(2, 'D'),
    c(9, 'C'), c(10, 'C'), c(11, 'C'),
    c(1, 'S'), c(1, 'D'), J(),
  ]);
  assert.ok(res.ok);
  assert.strictEqual(res.melds.length, 3);
  assert.strictEqual(res.value, 6 + 29 + 33);
});

test('splitIntoMelds: refuses when any card is left over or nothing fits', () => {
  assert.ok(!S.splitIntoMelds([c(1, 'S'), c(1, 'H'), J(), c(7, 'C'), c(7, 'D')]).ok, 'five cards, one pair');
  assert.ok(!S.splitIntoMelds([c(1, 'S'), c(1, 'H'), J(), c(7, 'C'), c(7, 'D'), c(9, 'S')]).ok, 'second group invalid');
  assert.ok(!S.splitIntoMelds([c(1, 'S'), c(1, 'S'), J(), c(7, 'C'), c(7, 'D'), J()]).ok, 'aces of the same suit');
});

test('splitIntoMelds: a whole 13-card hand is handled quickly', () => {
  const hand = [c(1, 'S'), c(2, 'S'), c(3, 'S'), c(4, 'S'), c(9, 'H'), c(9, 'D'), c(9, 'C'), c(11, 'D'), c(12, 'D'), c(13, 'D'), c(5, 'C'), c(5, 'H'), J()];
  const t0 = Date.now();
  const res = S.splitIntoMelds(hand);
  assert.ok(res.ok);
  assert.ok(Date.now() - t0 < 1500, 'fast enough');
  const bad = [c(1, 'S'), c(3, 'S'), c(5, 'H'), c(7, 'D'), c(9, 'C'), c(11, 'S'), c(13, 'H'), c(2, 'D'), c(4, 'C'), c(6, 'S'), c(8, 'H'), c(10, 'D'), c(12, 'C')];
  const t1 = Date.now();
  assert.ok(!S.splitIntoMelds(bad).ok);
  assert.ok(Date.now() - t1 < 1500, 'fast enough on a hopeless hand');
});

// ---------------------------------------------------------------- opening
test('REPORTED BUG: opening with A A Joker + 7 7 Joker selected together (54 points)', () => {
  const a1 = c(1, 'S'), a2 = c(1, 'H'), j1 = J(), s1 = c(7, 'C'), s2 = c(7, 'D'), j2 = J();
  const g = rigged([[a1, a2, j1, s1, s2, j2, ...filler()], [c(5, 'H')], [c(6, 'H')]]);
  assert.ok(S.drawStock(g).ok);
  const res = S.layMeld(g, ids(a1, a2, j1, s1, s2, j2));
  assert.ok(res.ok, res.error);
  assert.strictEqual(res.count, 2);
  assert.strictEqual(res.value, 54);
  assert.strictEqual(g.round.melds.length, 2);
  const keep = g.round.hands[0][0];
  assert.ok(S.discard(g, keep.id).ok);
  assert.ok(g.round.opened[0], 'player has opened');
});

test('opening: the same two combinations laid one at a time also works', () => {
  const a1 = c(1, 'S'), a2 = c(1, 'H'), j1 = J(), s1 = c(7, 'C'), s2 = c(7, 'D'), j2 = J();
  const g = rigged([[a1, a2, j1, s1, s2, j2, ...filler()], [c(5, 'H')], [c(6, 'H')]]);
  assert.ok(S.drawStock(g).ok);
  assert.ok(S.layMeld(g, ids(a1, a2, j1)).ok);
  assert.ok(S.layMeld(g, ids(s1, s2, j2)).ok);
  assert.ok(S.discard(g, g.round.hands[0][0].id).ok);
  assert.ok(g.round.opened[0]);
});

test('opening: under 40 is refused at the discard, exactly 40 is accepted', () => {
  const k = [c(13, 'S'), c(13, 'H'), c(13, 'D')];
  const g = rigged([[...k, ...filler()], [c(5, 'H')], [c(6, 'H')]]);
  assert.ok(S.drawStock(g).ok);
  assert.ok(S.layMeld(g, ids(...k)).ok);
  const r1 = S.discard(g, g.round.hands[0][0].id);
  assert.ok(!r1.ok && /40/.test(r1.error));
  assert.ok(!g.round.opened[0]);

  const k4 = [c(13, 'S'), c(13, 'H'), c(13, 'D'), c(13, 'C')];
  const g2 = rigged([[...k4, ...filler()], [c(5, 'H')], [c(6, 'H')]]);
  assert.ok(S.drawStock(g2).ok);
  assert.ok(S.layMeld(g2, ids(...k4)).ok);
  assert.ok(S.discard(g2, g2.round.hands[0][0].id).ok);
  assert.ok(g2.round.opened[0]);
});

test('opening: a turn without laying anything just discards', () => {
  const g = rigged([[...filler(), c(9, 'S')], [c(5, 'H')], [c(6, 'H')]]);
  assert.ok(S.drawStock(g).ok);
  assert.ok(S.discard(g, g.round.hands[0][0].id).ok);
  assert.ok(!g.round.opened[0]);
  assert.strictEqual(g.round.turn, 1);
});

test('after opening, a small combination needs no minimum', () => {
  const t = [c(2, 'S'), c(2, 'H'), c(2, 'D')];
  const g = rigged([[...t, ...filler()], [c(5, 'H')], [c(6, 'H')]], { opened: [true, false, false] });
  assert.ok(S.drawStock(g).ok);
  assert.ok(S.layMeld(g, ids(...t)).ok);
  assert.ok(S.discard(g, g.round.hands[0][0].id).ok);
});

test('lay down: must keep a card to discard, cards must be in hand, no duplicates', () => {
  const t = [c(2, 'S'), c(2, 'H'), c(2, 'D')];
  const g = rigged([[...t], [c(5, 'H')], [c(6, 'H')]], { stock: [c(2, 'C')], opened: [true, false, false] });
  assert.ok(S.drawStock(g).ok);
  assert.ok(!S.layMeld(g, g.round.hands[0].map((x) => x.id)).ok, 'all four twos leaves nothing to discard');
  assert.ok(!S.layMeld(g, [t[0].id, t[0].id, t[1].id]).ok, 'same card twice');
  assert.ok(!S.layMeld(g, [t[0].id, t[1].id, 99999]).ok, 'card not in hand');
  const g2 = rigged([[...t, c(9, 'S')], [c(5, 'H')], [c(6, 'H')]]);
  assert.ok(!S.layMeld(g2, ids(...t)).ok, 'must draw first');
});

// ---------------------------------------------------------------- discard pile
test('taking the discard: must be used this turn, or put back', () => {
  const top = c(9, 'H');
  const g = rigged([[c(9, 'S'), c(9, 'D'), c(9, 'C'), c(13, 'S'), c(13, 'H'), c(13, 'D'), c(2, 'C')], [c(5, 'H')], [c(6, 'H')]], { discard: [top] });
  assert.ok(S.takeDiscard(g).ok);
  assert.ok(!S.discard(g, g.round.hands[0][6].id).ok, 'cannot discard while holding it');
  const nines = g.round.hands[0].filter((x) => x.rank === 9).map((x) => x.id);
  const kings = g.round.hands[0].filter((x) => x.rank === 13).map((x) => x.id);
  assert.ok(S.layMeld(g, nines.concat(kings)).ok, '4 nines + 3 kings = 66');
  assert.ok(S.discard(g, g.round.hands[0][0].id).ok);
  assert.ok(g.round.opened[0]);
});

test('taking the discard to open needs 40 including it; otherwise put it back', () => {
  const top = c(9, 'H');
  const g = rigged([[c(9, 'S'), c(9, 'D'), c(2, 'C'), c(5, 'D')], [c(5, 'H')], [c(6, 'H')]], { discard: [top], stock: [c(4, 'S')] });
  assert.ok(S.takeDiscard(g).ok);
  const nines = g.round.hands[0].filter((x) => x.rank === 9).map((x) => x.id);
  assert.ok(S.layMeld(g, nines).ok); // 27 points
  assert.ok(!S.discard(g, g.round.hands[0][0].id).ok, '27 is not enough to open');
  assert.ok(S.returnDiscard(g).ok);
  assert.strictEqual(g.round.melds.length, 0, 'the laid set went back to the hand');
  assert.strictEqual(g.round.discard[g.round.discard.length - 1].id, top.id);
  assert.ok(S.discard(g, g.round.hands[0][0].id).ok);
});

test('drawing twice, or taking from an empty discard pile, is refused', () => {
  const g = rigged([[...filler()], [c(5, 'H')], [c(6, 'H')]], { discard: [] });
  assert.ok(!S.takeDiscard(g).ok);
  assert.ok(S.drawStock(g).ok);
  assert.ok(!S.drawStock(g).ok);
  assert.ok(!S.takeDiscard(g).ok);
});

test('when the stock runs out, the discard pile is reshuffled into it', () => {
  const g = rigged([[...filler()], [c(5, 'H')], [c(6, 'H')]], { stock: [], discard: [c(2, 'S'), c(3, 'S'), c(4, 'S')] });
  const top = g.round.discard[2];
  assert.ok(S.drawStock(g).ok);
  assert.strictEqual(g.round.discard.length, 1);
  assert.strictEqual(g.round.discard[0].id, top.id, 'top discard stays');
  assert.strictEqual(g.round.hands[0].length, 3);
});

test('undo puts the hand and table back to just after the draw', () => {
  const t = [c(13, 'S'), c(13, 'H'), c(13, 'D'), c(13, 'C')];
  const g = rigged([[...t, ...filler()], [c(5, 'H')], [c(6, 'H')]]);
  assert.ok(S.drawStock(g).ok);
  const before = g.round.hands[0].length;
  assert.ok(S.layMeld(g, ids(...t)).ok);
  assert.ok(S.resetTurn(g).ok);
  assert.strictEqual(g.round.hands[0].length, before);
  assert.strictEqual(g.round.melds.length, 0);
  assert.strictEqual(g.round.phase, 'play');
});

// ---------------------------------------------------------------- turns
test('only the current player acts; turns rotate', () => {
  const g = rigged([[...filler(), c(9, 'S')], [c(5, 'H'), c(6, 'D')], [c(6, 'H'), c(7, 'C')]]);
  assert.ok(S.drawStock(g).ok);
  assert.ok(S.discard(g, g.round.hands[0][0].id).ok);
  assert.strictEqual(g.round.turn, 1);
  assert.strictEqual(g.round.phase, 'draw');
  assert.ok(S.drawStock(g).ok);
  assert.ok(S.discard(g, g.round.hands[1][0].id).ok);
  assert.strictEqual(g.round.turn, 2);
});

// ---------------------------------------------------------------- attaching
test('attaching: only after opening, from the next turn, to anyone\'s combination', () => {
  const g = rigged([[c(8, 'H'), ...filler(), c(10, 'S')], [c(5, 'H')], [c(6, 'H')]], { stock: [c(4, 'S'), c(9, 'D')] });
  g.round.melds.push({ id: 90, owner: 1, type: 'run', entries: [{ card: c(5, 'H'), pos: 5 }, { card: c(6, 'H'), pos: 6 }, { card: c(7, 'H'), pos: 7 }] });
  g.round.nextMeldId = 91;
  assert.ok(S.drawStock(g).ok);
  const eight = g.round.hands[0].find((x) => x.rank === 8);
  assert.ok(!S.attach(g, 90, [eight.id]).ok, 'not opened yet');

  const g2 = rigged([[c(8, 'H'), ...filler(), c(10, 'S')], [c(5, 'H')], [c(6, 'H')]], { opened: [true, false, false] });
  g2.round.melds.push({ id: 90, owner: 1, type: 'run', entries: [{ card: c(5, 'H'), pos: 5 }, { card: c(6, 'H'), pos: 6 }, { card: c(7, 'H'), pos: 7 }] });
  assert.ok(S.drawStock(g2).ok);
  const e2 = g2.round.hands[0].find((x) => x.rank === 8);
  assert.ok(S.attach(g2, 90, [e2.id]).ok, 'attach to an opponent\'s run');
  assert.strictEqual(g2.round.melds[0].entries.length, 4);
  const ten = g2.round.hands[0].find((x) => x.rank === 10);
  assert.ok(!S.attach(g2, 90, [ten.id]).ok, '10 does not fit 5-8');
});

test('attaching in the same turn you opened is refused', () => {
  const k4 = [c(13, 'S'), c(13, 'H'), c(13, 'D'), c(13, 'C')];
  const extra = c(8, 'H');
  const g = rigged([[...k4, extra, ...filler()], [c(5, 'H')], [c(6, 'H')]]);
  g.round.melds.push({ id: 90, owner: 1, type: 'run', entries: [{ card: c(5, 'H'), pos: 5 }, { card: c(6, 'H'), pos: 6 }, { card: c(7, 'H'), pos: 7 }] });
  g.round.nextMeldId = 91;
  assert.ok(S.drawStock(g).ok);
  assert.ok(S.layMeld(g, ids(...k4)).ok);
  assert.ok(!S.attach(g, 90, [extra.id]).ok);
});

test('attaching to a set: fourth suit fits, repeated suit does not', () => {
  const g = rigged([[c(9, 'C'), c(9, 'S'), ...filler()], [c(5, 'H')], [c(6, 'H')]], { opened: [true, false, false] });
  g.round.melds.push({ id: 90, owner: 1, type: 'set', entries: [{ card: c(9, 'S') }, { card: c(9, 'H') }, { card: c(9, 'D') }] });
  assert.ok(S.drawStock(g).ok);
  const nineS = g.round.hands[0].find((x) => x.rank === 9 && x.suit === 'S');
  const nineC = g.round.hands[0].find((x) => x.rank === 9 && x.suit === 'C');
  assert.ok(!S.attach(g, 90, [nineS.id]).ok);
  assert.ok(S.attach(g, 90, [nineC.id]).ok);
});

test('attaching keeps a run joker where it is', () => {
  const g = rigged([[c(4, 'D'), c(8, 'D'), ...filler()], [c(5, 'H')], [c(6, 'H')]], { opened: [true, false, false] });
  g.round.melds.push({ id: 90, owner: 1, type: 'run', entries: [{ card: c(5, 'D'), pos: 5 }, { card: J(), pos: 6 }, { card: c(7, 'D'), pos: 7 }] });
  assert.ok(S.drawStock(g).ok);
  const four = g.round.hands[0].find((x) => x.rank === 4);
  assert.ok(S.attach(g, 90, [four.id]).ok);
  const jokerEntry = g.round.melds[0].entries.find((e) => S.isJoker(e.card));
  assert.strictEqual(jokerEntry.pos, 6);
});

// ---------------------------------------------------------------- jokers on the table
test('joker swap: run joker for the exact card it stands for', () => {
  const g = rigged([[c(6, 'C'), c(6, 'H'), c(9, 'S'), c(9, 'H'), c(9, 'D'), c(2, 'D')], [c(5, 'S')], [c(6, 'S')]], { opened: [true, false, false] });
  g.round.melds.push({ id: 50, owner: 1, type: 'run', entries: [{ card: c(5, 'C'), pos: 5 }, { card: J(), pos: 6 }, { card: c(7, 'C'), pos: 7 }] });
  assert.ok(S.drawStock(g).ok);
  const sixH = g.round.hands[0].find((x) => x.rank === 6 && x.suit === 'H');
  assert.ok(!S.swapJoker(g, 50, sixH.id).ok, 'wrong suit');
  const sixC = g.round.hands[0].find((x) => x.rank === 6 && x.suit === 'C');
  assert.ok(S.swapJoker(g, 50, sixC.id).ok);
  const two = g.round.hands[0].find((x) => x.rank === 2);
  assert.ok(!S.discard(g, two.id).ok, 'the joker must be used this turn');
  const nines = g.round.hands[0].filter((x) => x.rank === 9).map((x) => x.id);
  const jk = g.round.hands[0].find(S.isJoker).id;
  assert.ok(S.layMeld(g, nines.concat(jk)).ok);
  assert.ok(S.discard(g, two.id).ok);
});

test('joker swap in a set: only from a set of four', () => {
  const g = rigged([[c(9, 'C'), c(9, 'H'), ...filler()], [c(5, 'S')], [c(6, 'S')]], { opened: [true, false, false] });
  g.round.melds.push({ id: 60, owner: 1, type: 'set', entries: [{ card: c(9, 'S') }, { card: c(9, 'D') }, { card: J() }] });
  g.round.melds.push({ id: 61, owner: 2, type: 'set', entries: [{ card: c(4, 'S') }, { card: c(4, 'D') }, { card: c(4, 'H') }, { card: J() }] });
  assert.ok(S.drawStock(g).ok);
  const nineC = g.round.hands[0].find((x) => x.rank === 9 && x.suit === 'C');
  assert.ok(!S.swapJoker(g, 60, nineC.id).ok, 'set of three');
  g.round.hands[0].push(c(4, 'C'));
  const fourC = g.round.hands[0].find((x) => x.rank === 4);
  assert.ok(S.swapJoker(g, 61, fourC.id).ok, 'set of four, missing suit');
});

test('joker swap before opening is refused', () => {
  const g = rigged([[c(6, 'C'), ...filler()], [c(5, 'S')], [c(6, 'S')]]);
  g.round.melds.push({ id: 50, owner: 1, type: 'run', entries: [{ card: c(5, 'C'), pos: 5 }, { card: J(), pos: 6 }, { card: c(7, 'C'), pos: 7 }] });
  assert.ok(S.drawStock(g).ok);
  assert.ok(!S.swapJoker(g, 50, g.round.hands[0][0].id).ok);
});

// ---------------------------------------------------------------- going out and scoring
test('going out after opening earlier: normal penalties', () => {
  const last = c(2, 'C');
  const g = rigged([[c(5, 'S'), c(6, 'S'), c(7, 'S'), last], [c(1, 'S'), J(), c(13, 'H')], [c(6, 'H'), c(4, 'D')]], { opened: [true, true, false], stock: [c(8, 'S')] });
  assert.ok(S.drawStock(g).ok);
  const run = g.round.hands[0].filter((x) => x.suit === 'S').map((x) => x.id);
  assert.ok(S.layMeld(g, run).ok);
  const res = S.discard(g, last.id);
  assert.ok(res.ok && res.wentOut);
  const rr = g.round.result;
  assert.ok(!rr.doubled);
  assert.strictEqual(rr.penalties[0], 0);
  assert.strictEqual(rr.penalties[1], 11 + 25 + 10);
  assert.strictEqual(rr.penalties[2], 100, 'never opened');
  assert.strictEqual(g.round.phase, 'over');
});

test('going out in one turn without having opened doubles penalties (chiusura in mano)', () => {
  const k4 = [c(13, 'S'), c(13, 'H'), c(13, 'D'), c(13, 'C')];
  const last = c(2, 'C');
  const g = rigged([[...k4], [c(1, 'S'), J()], [c(6, 'S')]], { opened: [false, true, false], stock: [last] });
  assert.ok(S.drawStock(g).ok);
  assert.ok(S.layMeld(g, ids(...k4)).ok);
  const res = S.discard(g, last.id);
  assert.ok(res.ok && res.wentOut);
  assert.ok(g.round.result.doubled);
  assert.strictEqual(g.round.result.penalties[1], (11 + 25) * 2);
  assert.strictEqual(g.round.result.penalties[2], 200);
});

test('elimination at 101 and the last player standing wins', () => {
  const k4 = [c(13, 'S'), c(13, 'H'), c(13, 'D'), c(13, 'C')];
  const last = c(2, 'C');
  const g = rigged([[...k4], [c(1, 'S'), J()], [c(6, 'S')]], { opened: [true, true, true], stock: [last] });
  g.players[1].score = 70; // + 36 = 106: out
  g.players[2].score = 50; // + 6 = 56: still in
  assert.ok(S.drawStock(g).ok);
  assert.ok(S.layMeld(g, ids(...k4)).ok);
  assert.ok(S.discard(g, last.id).ok);
  assert.ok(g.players[1].eliminated);
  assert.ok(!g.players[2].eliminated);
  assert.strictEqual(g.winner, null, 'two players left');
  assert.ok(S.nextRound(g, () => 0.3).ok);
  assert.strictEqual(g.round.hands[1].length, 0, 'eliminated player is dealt no cards');
  assert.ok(g.round.turn !== 1);
});

test('the game ends when only one player is left', () => {
  const k4 = [c(13, 'S'), c(13, 'H'), c(13, 'D'), c(13, 'C')];
  const last = c(2, 'C');
  const g = rigged([[...k4], [c(1, 'S'), J()], [c(6, 'S')]], { opened: [true, true, true], stock: [last] });
  g.players[1].score = 90; g.players[2].score = 99;
  g.players[2].score = 96; // + 6 = 102
  assert.ok(S.drawStock(g).ok);
  assert.ok(S.layMeld(g, ids(...k4)).ok);
  assert.ok(S.discard(g, last.id).ok);
  assert.strictEqual(g.winner, 0);
  assert.ok(!S.nextRound(g).ok);
});

// ---------------------------------------------------------------- dealing and views
test('new game: 13 cards each, one face-up discard, 108 cards in all', () => {
  for (const n of [2, 3, 4]) {
    const g = S.newGame(Array.from({ length: n }, (_, i) => 'P' + i));
    const r = g.round;
    r.hands.forEach((h) => assert.strictEqual(h.length, 13));
    assert.strictEqual(r.discard.length, 1);
    assert.strictEqual(r.hands.flat().length + r.stock.length + r.discard.length, 108);
  }
  assert.throws(() => S.newGame(['solo']));
});

test('a player\'s view shows only their own hand', () => {
  const g = S.newGame(['Ann', 'Bob', 'Cleo']);
  const v = S.viewFor(g, 1);
  assert.strictEqual(v.me, 1);
  assert.deepStrictEqual(v.hand.map((x) => x.id), g.round.hands[1].map((x) => x.id));
  assert.ok(!('hands' in v));
  assert.ok(!('stock' in v));
  assert.strictEqual(v.players[0].cards, g.round.hands[0].length);
  const json = JSON.stringify(v);
  for (const card of g.round.hands[0]) assert.ok(!json.includes('"id":' + card.id + ','), 'no card of another player leaks');
});

test('opening with A-A-joker plus 7-7-joker in one selection (54 points)', () => {
  const S = require('../src/engine.js');
  const J = (id) => ({ id, rank: 0, suit: null });
  const cards = [{ id: 1, rank: 1, suit: 'S' }, { id: 2, rank: 1, suit: 'H' }, J(3), { id: 4, rank: 7, suit: 'C' }, { id: 5, rank: 7, suit: 'D' }, J(6)];
  const r = S.splitIntoMelds(cards);
  assert.ok(r.ok); assert.strictEqual(r.value, 54); assert.strictEqual(r.melds.length, 2);
});

test('same card twice in a set gives a clear reason', () => {
  const S = require('../src/engine.js');
  const r = S.splitIntoMelds([{ id: 1, rank: 1, suit: 'S' }, { id: 2, rank: 1, suit: 'S' }, { id: 3, rank: 0, suit: null }]);
  assert.ok(!r.ok); assert.match(r.error, /twice/);
});

test('set joker: no swap with two real cards, swap only for the missing suit with three', () => {
  const S = require('../src/engine.js');
  function setup(meld, hand) {
    const g = S.newGame(['A', 'B'], null, () => 0.5); const r = g.round;
    if (r.phase === 'draw') S.drawStock(g);
    r.turnState.startOpened = true;
    r.melds.push({ id: 99, owner: 1, type: 'set', entries: meld.map((c) => ({ card: c })) });
    r.hands[r.turn].push(...hand); return g;
  }
  const J = { id: 500, rank: 0, suit: null };
  const c = (id, suit) => ({ id, rank: 7, suit });
  assert.ok(!S.swapJoker(setup([c(501, 'C'), c(502, 'D'), J], [c(600, 'H')]), 99, 600).ok);
  assert.ok(!S.swapJoker(setup([c(501, 'C'), c(502, 'D'), J], [c(600, 'S')]), 99, 600).ok);
  assert.ok(S.swapJoker(setup([c(501, 'C'), c(502, 'D'), c(503, 'H'), J], [c(600, 'S')]), 99, 600).ok);
  assert.ok(!S.swapJoker(setup([c(501, 'C'), c(502, 'D'), c(503, 'H'), J], [c(600, 'H')]), 99, 600).ok);
});
