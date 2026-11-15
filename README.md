# Scala 40

Prototype of Scala 40 (Italian rummy) for friends: pass-and-play on one screen, 2–4 players.

- `src/engine.js` — rules engine (standard rules, documented at the top of the file)
- `src/index.html` — the game page
- `test/engine.test.js` — rule tests (`npm test`)
- `npm run build` — writes `dist/scala40.html`, a single self-contained page

Next step: online multiplayer (server-run game, invite links).
