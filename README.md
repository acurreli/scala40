# Scala 40

Scala 40 (Italian rummy) for friends — live at https://scala40.fly.dev

- **Play online:** create a table, send the invite link, 2–4 players each on their own device.
- **Pass and play:** everyone shares one screen.

Code:
- `src/engine.js` — rules engine (standard rules, documented at the top of the file)
- `server.js` — web server + online tables over WebSocket (the server holds the hands and checks every move)
- `src/index.html`, `src/client.js` — the game page
- `test/engine.test.js` — rule tests (`npm test`)
- `npm run build` — writes `dist/scala40.html`

Every push to `main` deploys to Fly.io automatically.
