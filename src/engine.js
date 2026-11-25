// Scala 40 rules engine — pure JavaScript, no dependencies.
// Works in the browser (global `Scala40`) and in Node (module.exports).
//
// Standard rules implemented:
//  - 2 French decks + 4 jokers (108 cards), 13 cards each, one card face up on the discard pile.
//  - Turn = draw (stock, or top of discard pile) -> lay down / attach / swap jokers -> discard one card.
//  - Sets: 3-4 cards of the same rank, all different suits. Runs: 3+ consecutive cards of one suit,
//    Ace low (A-2-3) or high (Q-K-A), no wrap-around. At most one joker per combination.
//  - Opening: your own new combinations laid in one turn must total at least 40 points.
//  - Taking the discard: only to use it in the same turn (to open, or after having opened).
//  - Attaching and joker swaps: only after you have opened, from your next turn onward.
//    A joker taken back from the table must be used in the same turn.
//  - Going out: you must finish with a discard (you can never lay down your last card).
//  - Penalties: Joker 25, Ace 11, K/Q/J 10, others face value; never opened = 100.
//    Going out in one turn without having opened before ("chiusura in mano") doubles the penalties.
//  - A player reaching 101 is eliminated; the last player standing wins.

(function (root) {
  'use strict';

  const SUITS = ['S', 'H', 'D', 'C'];
  const SUIT_SYMBOL = { S: '♠', H: '♥', D: '♦', C: '♣' };
  const RANK_LABEL = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K' };

  const DEFAULT_OPTIONS = {
    handSize: 13,
    openingPoints: 40,
    eliminationScore: 101,
    notOpenedPenalty: 100,
    jokerPenalty: 25,
    doubleOnCloseInHand: true,
  };

  // ---------- cards ----------

  function makeDeck() {
    const cards = [];
    let id = 0;
    for (let d = 0; d < 2; d++) {
      for (const suit of SUITS) {
        for (let rank = 1; rank <= 13; rank++) cards.push({ id: id++, rank, suit });
      }
      cards.push({ id: id++, rank: 0, suit: null }); // jokers
      cards.push({ id: id++, rank: 0, suit: null });
    }
    return cards;
  }

  function isJoker(c) { return c.rank === 0; }

  function cardLabel(c) {
    if (isJoker(c)) return 'Joker';
    return (RANK_LABEL[c.rank] || String(c.rank)) + SUIT_SYMBOL[c.suit];
  }

  // Penalty value of a card left in hand.
  function penaltyValue(c, opts) {
    if (isJoker(c)) return (opts || DEFAULT_OPTIONS).jokerPenalty;
    if (c.rank === 1) return 11;
    if (c.rank >= 11) return 10;
    return c.rank;
  }

  // Value of a position in a run (1 = low ace, 14 = high ace) or of a rank in a set.
  function posValue(pos) {
    if (pos === 1 || pos === 14) return pos === 1 ? 1 : 11;
    if (pos >= 11) return 10;
    return pos;
  }
  function setRankValue(rank) {
    if (rank === 1) return 11;
    if (rank >= 11) return 10;
    return rank;
  }

  function shuffle(arr, rng) {
    const r = rng || Math.random;
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // ---------- combination validation ----------

  // Returns { ok, type, entries, value } or { ok:false, error }.
  // entries: for runs [{card, pos}] ordered by pos; for sets [{card}].
  // opts.type forces 'set' or 'run'; opts.fixedJokerPos keeps an existing joker where it was.
  function validateMeld(cards, opts) {
    opts = opts || {};
    if (!cards || cards.length < 3) return { ok: false, error: 'A combination needs at least 3 cards.' };
    const jokers = cards.filter(isJoker);
    if (jokers.length > 1) return { ok: false, error: 'Only one joker per combination.' };
    const tries = opts.type ? [opts.type] : ['set', 'run'];
    let lastError = 'Not a valid set or run.';
    for (const t of tries) {
      const res = t === 'set' ? validateSet(cards) : validateRun(cards, opts.fixedJokerPos);
      if (res.ok) return res;
      lastError = res.error;
    }
    return { ok: false, error: lastError };
  }

  function validateSet(cards) {
    if (cards.length > 4) return { ok: false, error: 'A set has at most 4 cards.' };
    const real = cards.filter((c) => !isJoker(c));
    if (real.length === 0) return { ok: false, error: 'A set needs real cards.' };
    const rank = real[0].rank;
    if (!real.every((c) => c.rank === rank)) return { ok: false, error: 'All cards in a set must have the same rank.' };
    const suits = new Set(real.map((c) => c.suit));
    if (suits.size !== real.length) return { ok: false, error: 'A set cannot repeat a suit.' };
    return {
      ok: true,
      type: 'set',
      rank,
      entries: cards.map((card) => ({ card })),
      value: setRankValue(rank) * cards.length,
    };
  }

  function validateRun(cards, fixedJokerPos) {
    const real = cards.filter((c) => !isJoker(c));
    const joker = cards.find(isJoker) || null;
    if (real.length < 2) return { ok: false, error: 'A run needs at least 2 real cards.' };
    const suit = real[0].suit;
    if (!real.every((c) => c.suit === suit)) return { ok: false, error: 'All cards in a run must be the same suit.' };
    const hasAce = real.some((c) => c.rank === 1);
    const options = hasAce ? [false, true] : [false];
    for (const aceHigh of options) {
      const mapped = real.map((c) => ({ card: c, pos: c.rank === 1 ? (aceHigh ? 14 : 1) : c.rank }));
      const positions = mapped.map((m) => m.pos);
      if (new Set(positions).size !== positions.length) continue; // duplicate rank
      mapped.sort((a, b) => a.pos - b.pos);
      const min = mapped[0].pos;
      const max = mapped[mapped.length - 1].pos;
      const gaps = max - min + 1 - mapped.length;
      const jokerCount = joker ? 1 : 0;
      if (gaps > jokerCount) continue;
      let jokerPos = null;
      if (joker) {
        let candidates;
        if (gaps === 1) {
          const present = new Set(positions);
          candidates = [];
          for (let p = min; p <= max; p++) if (!present.has(p)) candidates.push(p);
        } else {
          candidates = [];
          if (max + 1 <= 14) candidates.push(max + 1);
          if (min - 1 >= 1) candidates.push(min - 1);
        }
        if (fixedJokerPos != null) {
          if (!candidates.includes(fixedJokerPos)) continue;
          jokerPos = fixedJokerPos;
        } else {
          if (candidates.length === 0) continue;
          jokerPos = candidates[0];
        }
      }
      const entries = mapped.slice();
      if (joker) entries.push({ card: joker, pos: jokerPos });
      entries.sort((a, b) => a.pos - b.pos);
      if (entries[0].pos < 1 || entries[entries.length - 1].pos > 14) continue;
      const value = entries.reduce((s, e) => s + posValue(e.pos), 0);
      return { ok: true, type: 'run', suit, entries, value };
    }
    return { ok: false, error: 'Not a valid run (same suit, consecutive, Ace low or high, no wrap-around).' };
  }

  // Split a selection of cards into valid combinations, e.g. A♠ A♥ Joker + 7♣ 7♦ Joker.
  // Every card must be used. Returns the split worth the most points:
  // { ok, melds: [validateMeld results], value } or { ok:false, error }.
  function splitIntoMelds(cards) {
    const whole = validateMeld(cards);
    if (whole.ok) return { ok: true, melds: [whole], value: whole.value };
    if (!cards || cards.length < 6) return { ok: false, error: dupSuitHint(cards) || whole.error };
    let best = null;
    let steps = 0;
    function search(rest, acc, total) {
      if (++steps > 200000) return;
      if (rest.length === 0) { if (!best || total > best.value) best = { melds: acc.slice(), value: total }; return; }
      const [first, ...others] = rest;
      const n = others.length;
      // Choose 2 or more companions for the first remaining card; leftovers must be 0 or at least 3.
      for (let mask = 1; mask < (1 << n); mask++) {
        let bits = 0; for (let m = mask; m; m &= m - 1) bits++;
        if (bits < 2) continue;
        const left = n - bits;
        if (left !== 0 && left < 3) continue;
        const group = [first], remaining = [];
        for (let i = 0; i < n; i++) (mask & (1 << i) ? group : remaining).push(others[i]);
        const v = validateMeld(group);
        if (!v.ok) continue;
        acc.push(v);
        search(remaining, acc, total + v.value);
        acc.pop();
        if (steps > 200000) return;
      }
    }
    search(cards.slice(), [], 0);
    if (!best) {
      return { ok: false, error: dupSuitHint(cards) || 'These cards do not make valid combinations. Each set or run needs at least 3 cards and at most one joker.' };
    }
    return { ok: true, melds: best.melds, value: best.value };
  }

  // ---------- game ----------

  // With two decks a hand can hold the same card twice (e.g. A♠ A♠); a set can't use both.
  function dupSuitHint(cards) {
    const seen = {};
    for (const c of cards) {
      if (isJoker(c)) continue;
      const k = c.rank + c.suit;
      if (seen[k]) return `You have ${cardLabel(c)} twice: a set needs every card in a different suit, so those two can't go in the same set.`;
      seen[k] = true;
    }
    return null;
  }

  function clone(x) { return JSON.parse(JSON.stringify(x)); }

  function newGame(names, options, rng) {
    if (!names || names.length < 2 || names.length > 6) throw new Error('Scala 40 needs 2 to 6 players.');
    const g = {
      opts: Object.assign({}, DEFAULT_OPTIONS, options || {}),
      players: names.map((name) => ({ name, score: 0, eliminated: false })),
      roundNumber: 0,
      dealer: names.length - 1,
      round: null,
      history: [],
      winner: null,
      log: [],
    };
    startRound(g, rng);
    return g;
  }

  function activeIndexes(g) {
    return g.players.map((p, i) => (p.eliminated ? -1 : i)).filter((i) => i >= 0);
  }

  function nextActive(g, from) {
    const n = g.players.length;
    for (let k = 1; k <= n; k++) {
      const i = (from + k) % n;
      if (!g.players[i].eliminated) return i;
    }
    return from;
  }

  function startRound(g, rng) {
    g.roundNumber += 1;
    g.dealer = nextActive(g, g.dealer);
    const deck = shuffle(makeDeck(), rng);
    const hands = g.players.map(() => []);
    for (let k = 0; k < g.opts.handSize; k++) {
      for (const i of activeIndexes(g)) hands[i].push(deck.pop());
    }
    const discard = [deck.pop()];
    const first = nextActive(g, g.dealer);
    g.round = {
      stock: deck,
      discard,
      hands,
      melds: [],
      nextMeldId: 1,
      opened: g.players.map(() => false),
      turn: first,
      phase: 'draw', // 'draw' -> 'play' -> (discard) -> next player's 'draw'; 'over' at round end
      turnState: null,
      snapshot: null,
      result: null,
    };
    g.log.push(`Round ${g.roundNumber}: ${g.players[g.dealer].name} deals. ${g.players[first].name} starts.`);
    return g;
  }

  function fail(error) { return { ok: false, error }; }

  function findInHand(hand, ids) {
    const cards = [];
    for (const id of ids) {
      const c = hand.find((x) => x.id === id);
      if (!c) return null;
      cards.push(c);
    }
    return cards;
  }

  function removeFromHand(hand, ids) {
    for (const id of ids) {
      const i = hand.findIndex((x) => x.id === id);
      if (i >= 0) hand.splice(i, 1);
    }
  }

  function beginTurnState(g) {
    const r = g.round;
    r.turnState = {
      startOpened: r.opened[r.turn],
      tookDiscardId: null,
      newMeldIds: [],
      newMeldPoints: 0,
      jokersToUse: [],
    };
  }

  function drawStock(g) {
    const r = g.round;
    if (r.phase !== 'draw') return fail('You have already drawn this turn.');
    if (r.stock.length === 0) {
      const top = r.discard.pop();
      r.stock = shuffle(r.discard);
      r.discard = top ? [top] : [];
      g.log.push('The stock ran out: the discard pile was reshuffled.');
      if (r.stock.length === 0) return fail('No cards left to draw.');
    }
    const c = r.stock.pop();
    r.hands[r.turn].push(c);
    beginTurnState(g);
    r.phase = 'play';
    r.snapshot = clone(r);
    g.log.push(`${g.players[r.turn].name} draws from the stock.`);
    return { ok: true, card: c };
  }

  function takeDiscard(g) {
    const r = g.round;
    if (r.phase !== 'draw') return fail('You have already drawn this turn.');
    if (r.discard.length === 0) return fail('The discard pile is empty.');
    const c = r.discard.pop();
    r.hands[r.turn].push(c);
    beginTurnState(g);
    r.turnState.tookDiscardId = c.id;
    r.phase = 'play';
    r.snapshot = clone(r);
    g.log.push(`${g.players[r.turn].name} takes ${cardLabel(c)} from the discard pile.`);
    return { ok: true, card: c };
  }

  // Undo everything done since the draw.
  function resetTurn(g) {
    const r = g.round;
    if (r.phase !== 'play' || !r.snapshot) return fail('Nothing to reset.');
    const snap = clone(r.snapshot);
    g.round = snap;
    g.round.snapshot = clone(snap);
    g.log.push(`${g.players[snap.turn].name} undoes their turn.`);
    return { ok: true };
  }

  // Took the discard but can't use it: put it back on the pile (undoing anything laid this turn)
  // and draw from the stock instead.
  function returnDiscard(g) {
    let r = g.round;
    if (r.phase !== 'play' || !r.turnState || r.turnState.tookDiscardId == null) return fail('You did not take the discard this turn.');
    const id = r.turnState.tookDiscardId;
    if (r.snapshot) { g.round = clone(r.snapshot); r = g.round; }
    const hand = r.hands[r.turn];
    const i = hand.findIndex((c) => c.id === id);
    if (i < 0) return fail('That card is no longer in your hand.');
    const [card] = hand.splice(i, 1);
    r.discard.push(card);
    r.phase = 'draw';
    r.turnState = null;
    r.snapshot = null;
    g.log.push(`${g.players[r.turn].name} puts ${cardLabel(card)} back.`);
    const res = drawStock(g);
    if (!res.ok) return res;
    return { ok: true, card: res.card, returned: card };
  }

  function useJokers(ts, cards) {
    for (const c of cards) {
      const i = ts.jokersToUse.indexOf(c.id);
      if (i >= 0) ts.jokersToUse.splice(i, 1);
    }
  }

  // Lay down the selected cards. The selection may hold one combination or several at once
  // (they are split automatically); either everything is laid or nothing is.
  function layMeld(g, cardIds) {
    const r = g.round;
    if (r.phase !== 'play') return fail('Draw a card first.');
    const hand = r.hands[r.turn];
    if (!cardIds || new Set(cardIds).size !== cardIds.length) return fail('Select each card only once.');
    const cards = findInHand(hand, cardIds);
    if (!cards) return fail('Those cards are not in your hand.');
    if (hand.length - cards.length < 1) return fail('You must keep one card to discard.');
    const split = splitIntoMelds(cards);
    if (!split.ok) return fail(split.error);
    const ts = r.turnState;
    const laid = [];
    for (const v of split.melds) {
      const meld = { id: r.nextMeldId++, owner: r.turn, type: v.type, entries: v.entries };
      r.melds.push(meld);
      laid.push(meld);
      ts.newMeldIds.push(meld.id);
      ts.newMeldPoints += v.value;
      g.log.push(`${g.players[r.turn].name} lays down a ${v.type}: ${meldCards(meld).map(cardLabel).join(' ')}.`);
    }
    removeFromHand(hand, cardIds);
    useJokers(ts, cards);
    return { ok: true, meld: laid[0], melds: laid, count: laid.length, value: split.value };
  }

  function meldCards(meld) { return meld.entries.map((e) => e.card); }

  function jokerPosOf(meld) {
    const e = meld.entries.find((x) => isJoker(x.card));
    return e && meld.type === 'run' ? e.pos : null;
  }

  function attach(g, meldId, cardIds) {
    const r = g.round;
    if (r.phase !== 'play') return fail('Draw a card first.');
    const ts = r.turnState;
    if (!ts.startOpened) return fail('You can attach cards only after you have opened, from your next turn.');
    const meld = r.melds.find((m) => m.id === meldId);
    if (!meld) return fail('No such combination.');
    const hand = r.hands[r.turn];
    const cards = findInHand(hand, cardIds);
    if (!cards || cards.length === 0) return fail('Select cards from your hand to attach.');
    if (hand.length - cards.length < 1) return fail('You must keep one card to discard.');
    const v = validateMeld(meldCards(meld).concat(cards), { type: meld.type, fixedJokerPos: jokerPosOf(meld) });
    if (!v.ok) return fail('Those cards do not fit that combination.');
    meld.entries = v.entries;
    removeFromHand(hand, cardIds);
    useJokers(ts, cards);
    g.log.push(`${g.players[r.turn].name} attaches ${cards.map(cardLabel).join(' ')} to ${g.players[meld.owner].name}'s ${meld.type}.`);
    return { ok: true, meld };
  }

  // Swap a joker on the table for the real card it stands for; the joker goes to the hand.
  function swapJokerSafe(g, meldId, cardId) {
    const r = g.round;
    const meld = r.melds.find((m) => m.id === meldId);
    const je = meld && meld.entries.find((e) => isJoker(e.card));
    const jokerCard = je ? je.card : null;
    const res = swapJokerCore(g, meldId, cardId);
    if (!res.ok) return res;
    const hand = r.hands[r.turn];
    hand.splice(hand.findIndex((c) => c.id === cardId), 1);
    hand.push(jokerCard);
    r.turnState.jokersToUse.push(jokerCard.id);
    g.log.push(`${g.players[r.turn].name} swaps a joker off the table.`);
    return { ok: true, joker: jokerCard };
  }

  function swapJokerCore(g, meldId, cardId) {
    const r = g.round;
    if (r.phase !== 'play') return fail('Draw a card first.');
    const ts = r.turnState;
    if (!ts.startOpened) return fail('You can swap jokers only after you have opened, from your next turn.');
    const meld = r.melds.find((m) => m.id === meldId);
    if (!meld) return fail('No such combination.');
    const je = meld.entries.find((e) => isJoker(e.card));
    if (!je) return fail('That combination has no joker.');
    const hand = r.hands[r.turn];
    const card = hand.find((c) => c.id === cardId);
    if (!card || isJoker(card)) return fail('Select the real card the joker stands for.');
    if (meld.type === 'run') {
      const suit = meld.entries.find((e) => !isJoker(e.card)).card.suit;
      const wantRank = je.pos === 14 ? 1 : je.pos;
      if (card.suit !== suit || card.rank !== wantRank) return fail('That card is not the one the joker stands for.');
    } else {
      if (meld.entries.length < 4) return fail('In a set, the joker can be taken only from a full set of four.');
      const real = meld.entries.filter((e) => !isJoker(e.card)).map((e) => e.card);
      const missing = SUITS.filter((s) => !real.some((c) => c.suit === s));
      if (card.rank !== real[0].rank || !missing.includes(card.suit)) return fail('That card is not the one the joker stands for.');
    }
    je.card = card;
    return { ok: true };
  }

  function discardCard(g, cardId) {
    const r = g.round;
    if (r.phase !== 'play') return fail('Draw a card first.');
    const ts = r.turnState;
    const hand = r.hands[r.turn];
    const card = hand.find((c) => c.id === cardId);
    if (!card) return fail('That card is not in your hand.');
    if (ts.tookDiscardId != null && hand.some((c) => c.id === ts.tookDiscardId)) {
      return fail('You took the discard: use it in a combination this turn, or press "Put it back" to return it and draw from the deck.');
    }
    if (ts.jokersToUse.length) return fail('You must use the joker you took from the table this turn.');
    if (!ts.startOpened && ts.newMeldIds.length > 0 && ts.newMeldPoints < g.opts.openingPoints) {
      return fail(`To open you need at least ${g.opts.openingPoints} points (you have ${ts.newMeldPoints}). Add combinations or reset the turn` +
        (ts.tookDiscardId != null ? ', or press "Put it back" to return the card you took and draw from the deck.' : '.'));
    }
    if (!ts.startOpened && ts.newMeldPoints >= g.opts.openingPoints) {
      r.opened[r.turn] = true;
      g.log.push(`${g.players[r.turn].name} opens with ${ts.newMeldPoints} points.`);
    }
    hand.splice(hand.indexOf(card), 1);
    r.discard.push(card);
    g.log.push(`${g.players[r.turn].name} discards ${cardLabel(card)}.`);
    r.snapshot = null;
    if (hand.length === 0) {
      endRound(g, r.turn, !ts.startOpened);
      return { ok: true, wentOut: true };
    }
    r.turn = nextActive(g, r.turn);
    r.phase = 'draw';
    r.turnState = null;
    return { ok: true };
  }

  function endRound(g, winnerIdx, closedInHand) {
    const r = g.round;
    const doubled = closedInHand && g.opts.doubleOnCloseInHand;
    const penalties = g.players.map(() => 0);
    for (const i of activeIndexes(g)) {
      if (i === winnerIdx) continue;
      let p = r.opened[i]
        ? r.hands[i].reduce((s, c) => s + penaltyValue(c, g.opts), 0)
        : g.opts.notOpenedPenalty;
      if (doubled) p *= 2;
      penalties[i] = p;
      g.players[i].score += p;
    }
    const newlyOut = [];
    for (const i of activeIndexes(g)) {
      if (g.players[i].score >= g.opts.eliminationScore) {
        g.players[i].eliminated = true;
        newlyOut.push(i);
      }
    }
    r.phase = 'over';
    r.result = { winner: winnerIdx, closedInHand, doubled, penalties, eliminated: newlyOut };
    g.history.push({ round: g.roundNumber, winner: winnerIdx, penalties, doubled });
    g.log.push(`${g.players[winnerIdx].name} goes out${doubled ? ' in one turn (penalties doubled)' : ''}.`);
    const left = activeIndexes(g);
    if (left.length <= 1) g.winner = left.length === 1 ? left[0] : winnerIdx;
  }

  function nextRound(g, rng) {
    if (g.winner != null) return fail('The game is over.');
    if (!g.round || g.round.phase !== 'over') return fail('The round is still being played.');
    startRound(g, rng);
    return { ok: true };
  }

  // Sort helper for displaying a hand: by suit then rank, jokers last.
  function sortHand(hand) {
    const order = { S: 0, H: 1, C: 2, D: 3 };
    return hand.slice().sort((a, b) => {
      if (isJoker(a) !== isJoker(b)) return isJoker(a) ? 1 : -1;
      if (isJoker(a)) return a.id - b.id;
      if (a.suit !== b.suit) return order[a.suit] - order[b.suit];
      return a.rank - b.rank;
    });
  }

  // What one player is allowed to see: their own hand, everyone's counts, the table.
  function viewFor(g, seat) {
    const r = g.round;
    const ts = r.turnState;
    return clone({
      roundNumber: g.roundNumber,
      dealer: g.dealer,
      turn: r.turn,
      phase: r.phase,
      me: seat,
      players: g.players.map((p, i) => ({ name: p.name, score: p.score, eliminated: p.eliminated, opened: r.opened[i], cards: r.hands[i].length })),
      hand: r.hands[seat] || [],
      melds: r.melds,
      discardTop: r.discard.length ? r.discard[r.discard.length - 1] : null,
      stockCount: r.stock.length,
      turnState: seat === r.turn && ts ? { startOpened: ts.startOpened, newMeldPoints: ts.newMeldPoints, tookDiscardId: ts.tookDiscardId, jokersToUse: ts.jokersToUse } : null,
      result: r.result,
      winner: g.winner,
      openingPoints: g.opts.openingPoints,
      log: g.log.slice(-8),
    });
  }

  const api = {
    SUITS, SUIT_SYMBOL, DEFAULT_OPTIONS,
    makeDeck, shuffle, isJoker, cardLabel, penaltyValue,
    validateMeld, splitIntoMelds,
    newGame, nextRound, drawStock, takeDiscard, resetTurn, returnDiscard,
    layMeld, attach, swapJoker: swapJokerSafe, discard: discardCard,
    sortHand, activeIndexes, viewFor,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Scala40 = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
