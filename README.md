# Scala 40

Scala 40 (Italian rummy) for friends — live at https://scala40.fly.dev

- **Play online:** the organizer (admin) or a delegate signs in at `/admin`, creates a table on the home page and sends the invite link. 2–4 players, each on their own device. Players never need an account.
- **Pass and play:** everyone shares one screen.

## Admin
- First start: the server prints a temporary admin password in the Fly.io log (`username: admin`). Sign in at `/admin` and choose your own.
- Forgot the admin password? Set the Fly.io secret `ADMIN_RESET_PASSWORD=1`; the next start prints a new temporary password. Remove the secret afterwards.
- The admin can open/close the game room (closing ends every game) and create, pause, resume, rename, reset or delete delegates.
- Passwords are stored only as salted scrypt hashes.

## Code
- `src/engine.js` — rules engine (standard rules, documented at the top of the file)
- `server.js` — web server, accounts API, online tables over WebSocket
- `store.js` — saved state on the `/data` disk (accounts, sessions, open/closed, tables)
- `src/index.html`, `src/client.js` — the game page; `src/admin.html` — the admin page
- `test/engine.test.js` — rule tests (`npm test`); `npm run build` writes `dist/`

Every push to `main` deploys to Fly.io automatically. The server stops when idle and restarts on the next visit; games are restored from disk.
