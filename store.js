// Saved state for the Scala 40 server: accounts, sign-in sessions, the open/closed switch and tables.
// Everything lives in one JSON file on the permanent disk (/data on Fly.io), written atomically.
// Passwords are never stored: only salted scrypt hashes.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, 'data'));
const FILE = path.join(DATA_DIR, 'scala40.json');
const SESSION_DAYS = 14;

let db = { users: {}, sessions: {}, site: { open: true }, tables: {} };
let saveTimer = null;

function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    db = Object.assign(db, JSON.parse(fs.readFileSync(FILE, 'utf8')));
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Could not read saved data:', e.message);
  }
  return db;
}

function saveNow() {
  clearTimeout(saveTimer); saveTimer = null;
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, FILE);
}
function save() { if (!saveTimer) saveTimer = setTimeout(saveNow, 250); }

// ---------- passwords ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return 'scrypt$16384$' + salt.toString('base64') + '$' + hash.toString('base64');
}
function checkPassword(pw, stored) {
  if (!stored) return false;
  const [kind, n, salt, hash] = stored.split('$');
  if (kind !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const got = crypto.scryptSync(String(pw), Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: 8, p: 1 });
  return crypto.timingSafeEqual(expected, got);
}
function tempPassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(12), (b) => alphabet[b % alphabet.length]).join('');
}

// ---------- users ----------
const cleanUsername = (u) => String(u || '').trim().toLowerCase();

function ensureAdmin() {
  const admin = db.users.admin;
  if (admin && !admin.mustChange) return null;
  // No admin yet, or the temporary password was never changed: issue a fresh temporary one.
  const pw = tempPassword();
  db.users.admin = Object.assign(admin || { username: 'admin', name: 'Admin', role: 'admin', status: 'active', created: Date.now() },
    { hash: hashPassword(pw), mustChange: true });
  saveNow();
  return pw;
}

function publicUser(u) {
  return u && { username: u.username, name: u.name, role: u.role, status: u.status, mustChange: !!u.mustChange, created: u.created, lastLogin: u.lastLogin || null };
}

// ---------- sessions (only a hash of the cookie value is stored) ----------
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function createSession(username) {
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions[sha(token)] = { username, expires: Date.now() + SESSION_DAYS * 86400000 };
  save();
  return token;
}
function userForToken(token) {
  if (!token) return null;
  const s = db.sessions[sha(token)];
  if (!s || s.expires < Date.now()) return null;
  const u = db.users[s.username];
  if (!u || u.status !== 'active') return null;
  return u;
}
function endSession(token) { if (token) { delete db.sessions[sha(token)]; save(); } }
function endSessionsFor(username) {
  for (const [k, s] of Object.entries(db.sessions)) if (s.username === username) delete db.sessions[k];
  save();
}
function pruneSessions() {
  const now = Date.now();
  for (const [k, s] of Object.entries(db.sessions)) if (s.expires < now) delete db.sessions[k];
}

module.exports = {
  DATA_DIR, load, save, saveNow, get db() { return db; },
  hashPassword, checkPassword, tempPassword, cleanUsername, ensureAdmin, publicUser,
  createSession, userForToken, endSession, endSessionsFor, pruneSessions,
};
