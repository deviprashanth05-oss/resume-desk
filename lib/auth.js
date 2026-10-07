const crypto = require('crypto'), { promisify } = require('util');
const db = require('./db');
const scrypt = promisify(crypto.scrypt);
const COOKIE = 'rd_sid', DAYS = 30;
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16), N = 16384;
  const h = await scrypt(pw, salt, 64, { N, r: 8, p: 1 });
  return 'scrypt$' + N + '$' + salt.toString('base64') + '$' + h.toString('base64');
}
async function verifyPassword(pw, stored) {
  try {
    const [alg, N, s, h] = String(stored).split('$'); if (alg !== 'scrypt') return false;
    const hb = Buffer.from(h, 'base64'), d = await scrypt(pw, Buffer.from(s, 'base64'), hb.length, { N: +N, r: 8, p: 1 });
    return crypto.timingSafeEqual(d, hb);
  } catch (e) { return false; }
}
let DUMMY = null; hashPassword('dummy-password-for-timing').then(h => { DUMMY = h; });
const dummyVerify = pw => verifyPassword(pw, DUMMY || 'x');

function parseCookies(req) {
  const o = {}; String(req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return o;
}
const isSecure = req => process.env.COOKIE_SECURE === 'true' || (process.env.COOKIE_SECURE !== 'false' && req.secure);
function setCookie(req, res, value, maxAge) {
  res.append('Set-Cookie', COOKIE + '=' + encodeURIComponent(value) + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAge + (isSecure(req) ? '; Secure' : ''));
}
async function createSession(req, res, userId) {
  const sid = crypto.randomBytes(32).toString('base64url'), now = Date.now();
  await db.run('INSERT INTO sessions(id_hash,user_id,created_at,expires_at,last_seen,ip,ua) VALUES(?,?,?,?,?,?,?)',
    [sha(sid), userId, now, now + DAYS * 864e5, now, req.ip || '', String(req.headers['user-agent'] || '').slice(0, 200)]);
  setCookie(req, res, sid, DAYS * 86400);
}
async function destroySession(req, res) {
  const sid = parseCookies(req)[COOKIE]; if (sid) await db.run('DELETE FROM sessions WHERE id_hash=?', [sha(sid)]);
  setCookie(req, res, '', 0);
}
// Attach req.user (or null). Sliding expiry, updates last_seen at most every 10 minutes.
async function attachUser(req, res, next) {
  req.user = null;
  const sid = parseCookies(req)[COOKIE];
  try {
    if (sid) {
      const now = Date.now();
      const row = await db.get(
        `SELECT s.id_hash, s.expires_at, s.last_seen AS s_seen, u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id_hash=?`,
        [sha(sid)]);
      if (row && row.expires_at > now && row.status === 'active') {
        req.user = { id: row.id, email: row.email, name: row.name, role: row.role, status: row.status, daily_limit: row.daily_limit, must_change: row.must_change, created_at: row.created_at };
        req.sessionHash = row.id_hash;
        if (now - row.s_seen > 600000) {
          await db.run('UPDATE sessions SET last_seen=?, expires_at=? WHERE id_hash=?', [now, now + DAYS * 864e5, row.id_hash]);
          await db.run('UPDATE users SET last_seen=? WHERE id=?', [now, row.id]);
          setCookie(req, res, sid, DAYS * 86400);
        }
      } else if (row && (row.expires_at <= now || row.status !== 'active')) {
        await db.run('DELETE FROM sessions WHERE id_hash=?', [row.id_hash]);
      }
    }
  } catch (e) { console.error('attachUser error', e); }
  next();
}
const requireAuth = (req, res, next) => req.user ? next() : res.status(401).json({ code: 'unauthorized', error: 'Please sign in.' });
const requireAdmin = (req, res, next) => (req.user && req.user.role === 'admin') ? next() : res.status(req.user ? 403 : 401).json({ code: req.user ? 'forbidden' : 'unauthorized', error: 'Admins only.' });

// tiny in-memory limiter (per process; fine for a single-server deploy)
const buckets = new Map();
function limited(key, max, windowMs) {
  const now = Date.now(); let b = buckets.get(key);
  if (!b || b.exp < now) { b = { n: 0, exp: now + windowMs }; buckets.set(key, b); }
  b.n++;
  if (buckets.size > 20000) for (const [k, v] of buckets) if (v.exp < now) buckets.delete(k);
  return b.n > max;
}
const peek = key => { const b = buckets.get(key); return b && b.exp > Date.now() ? b.n : 0; };
const clear = key => buckets.delete(key);
const normEmail = e => String(e || '').trim().toLowerCase();
const validEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 254;
module.exports = { hashPassword, verifyPassword, dummyVerify, createSession, destroySession, attachUser, requireAuth, requireAdmin, limited, peek, clear, normEmail, validEmail, COOKIE };
