const express = require('express'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const db = require('./lib/db');
const A = require('./lib/auth');
const ai = require('./lib/ai');
const PORT = parseInt(process.env.PORT || '3000', 10);
const APP_NAME = process.env.APP_NAME || 'Resume Desk';
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || '';
const PUB = path.join(__dirname, 'public');
const ah = fn => (req, res, next) => fn(req, res, next).catch(next);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY || 'loopback, linklocal, uniquelocal');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; worker-src blob: https://cdnjs.cloudflare.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  next();
});
app.use((req, res, next) => { A.attachUser(req, res, next).catch(next); });
// CSRF: every state-changing request must carry a custom header (browsers block that cross-site) and a same-origin Origin.
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const o = req.headers.origin;
  if (req.headers['x-requested-with'] !== 'resume-desk' || (o && new URL(o).host !== req.headers.host)) return res.status(403).json({ code: 'forbidden', error: 'Blocked request.' });
  next();
});
app.post('/api/ai', A.requireAuth, express.json({ limit: '9mb' }), (req, res, next) => ai.handler(req, res).catch(next));
app.use('/api', express.json({ limit: '1mb' }));

const clean = s => String(s == null ? '' : s).replace(/[\u0000-\u001f<>]/g, '').trim();
const publicUser = u => ({ id: u.id, email: u.email, name: u.name, role: u.role, must_change: !!u.must_change });

/* ---------- public ---------- */
app.get('/api/config', ah(async (req, res) => { const s = await db.getSettings(); res.json({ appName: APP_NAME, signupsOpen: s.signups_open === '1', supportEmail: SUPPORT_EMAIL, announcement: s.announcement }); }));
app.get('/healthz', ah(async (req, res) => { await db.healthCheck(); res.json({ ok: true }); }));

app.post('/api/auth/signup', ah(async (req, res) => {
  const ip = req.ip;
  if (A.limited('signup:' + ip, 10, 3600000)) return res.status(429).json({ code: 'rate_limited', error: 'Too many sign-ups from this network. Try later.' });
  if ((await db.getSettings()).signups_open !== '1') return res.status(403).json({ code: 'closed', error: 'Sign-ups are closed right now.' });
  const b = req.body || {}, email = A.normEmail(b.email), name = clean(b.name).slice(0, 80), pw = String(b.password || '');
  if (!A.validEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (pw.length < 8 || pw.length > 200) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (!b.consent) return res.status(400).json({ error: 'Please accept the Privacy Policy and Terms to continue.' });
  if (await db.get('SELECT 1 x FROM users WHERE email=?', [email])) return res.status(409).json({ error: 'An account with this email already exists. Try signing in.' });
  const now = Date.now();
  let id;
  try {
    const ins = await db.run('INSERT INTO users(email,name,pass_hash,created_at,last_login,last_seen,consent_at) VALUES(?,?,?,?,?,?,?)', [email, name, await A.hashPassword(pw), now, now, now, now]);
    id = ins.insertId;
  } catch (e) { if (e && e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'An account with this email already exists. Try signing in.' }); throw e; }
  await A.createSession(req, res, id);
  res.json({ ok: true });
}));
app.post('/api/auth/login', ah(async (req, res) => {
  const b = req.body || {}, email = A.normEmail(b.email), pw = String(b.password || '');
  if (A.limited('login-ip:' + req.ip, 40, 900000)) return res.status(429).json({ code: 'rate_limited', error: 'Too many attempts. Try again in a few minutes.' });
  const fk = 'fail:' + email;
  if (A.peek(fk) >= 5) return res.status(429).json({ code: 'rate_limited', error: 'Too many wrong passwords for this account. Try again in 15 minutes.' });
  const u = await db.get('SELECT * FROM users WHERE email=?', [email]);
  const ok = u ? await A.verifyPassword(pw, u.pass_hash) : (await A.dummyVerify(pw), false);
  if (!ok) { A.limited(fk, 5, 900000); return res.status(401).json({ error: 'Email or password is incorrect.' }); }
  if (u.status !== 'active') return res.status(403).json({ code: 'disabled', error: 'This account has been disabled. Please contact the admin.' });
  A.clear(fk);
  const now = Date.now(); await db.run('UPDATE users SET last_login=?, last_seen=? WHERE id=?', [now, now, u.id]);
  await A.createSession(req, res, u.id);
  res.json({ ok: true, must_change: !!u.must_change });
}));
app.post('/api/auth/logout', ah(async (req, res) => { await A.destroySession(req, res); res.json({ ok: true }); }));

/* ---------- account ---------- */
app.get('/api/me', A.requireAuth, ah(async (req, res) => res.json({ user: publicUser(req.user), quota: await ai.quotaFor(req.user), announcement: (await db.getSettings()).announcement, tz: db.TZ })));
app.post('/api/me/password', A.requireAuth, ah(async (req, res) => {
  const b = req.body || {}, cur = String(b.current || ''), next = String(b.next || '');
  if (A.limited('pw:' + req.user.id, 10, 900000)) return res.status(429).json({ error: 'Too many attempts. Try later.' });
  const u = await db.get('SELECT pass_hash FROM users WHERE id=?', [req.user.id]);
  if (!(await A.verifyPassword(cur, u.pass_hash))) return res.status(400).json({ error: 'Your current password is not correct.' });
  if (next.length < 8 || next.length > 200) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  await db.run('UPDATE users SET pass_hash=?, must_change=0 WHERE id=?', [await A.hashPassword(next), req.user.id]);
  await db.run('DELETE FROM sessions WHERE user_id=? AND id_hash!=?', [req.user.id, req.sessionHash]);
  res.json({ ok: true });
}));
app.get('/api/me/export', A.requireAuth, ah(async (req, res) => {
  const u = await db.get('SELECT id,email,name,role,created_at,last_login,consent_at FROM users WHERE id=?', [req.user.id]);
  const resumeRows = await db.all('SELECT id,title,data,created_at,updated_at FROM resumes WHERE user_id=?', [req.user.id]);
  const resumes = resumeRows.map(r => ({ ...r, data: JSON.parse(r.data || '{}') }));
  const usage = await db.all('SELECT ts,kind,input_tokens,output_tokens FROM ai_usage WHERE user_id=?', [req.user.id]);
  res.setHeader('Content-Disposition', 'attachment; filename="my-resume-desk-data.json"');
  res.json({ exported_at: new Date().toISOString(), account: u, resumes, ai_usage: usage });
}));
app.delete('/api/me', A.requireAuth, ah(async (req, res) => {
  const u = await db.get('SELECT pass_hash, role FROM users WHERE id=?', [req.user.id]);
  if (!(await A.verifyPassword(String((req.body || {}).password || ''), u.pass_hash))) return res.status(400).json({ error: 'Password is not correct.' });
  if (u.role === 'admin' && (await db.get("SELECT COUNT(*) c FROM users WHERE role='admin' AND status='active'")).c <= 1) return res.status(400).json({ error: 'You are the only admin. Make someone else an admin first.' });
  await db.run('DELETE FROM users WHERE id=?', [req.user.id]);
  await A.destroySession(req, res); res.json({ ok: true });
}));

/* ---------- resumes ---------- */
const MAX_DATA = 500 * 1024;
const sanitizeData = d => (d && typeof d === 'object' && !Array.isArray(d)) ? d : null;
app.get('/api/resumes', A.requireAuth, ah(async (req, res) => res.json(await db.all('SELECT id,title,updated_at FROM resumes WHERE user_id=? ORDER BY updated_at DESC', [req.user.id]))));
app.post('/api/resumes', A.requireAuth, ah(async (req, res) => {
  const max = parseInt((await db.getSettings()).max_resumes, 10) || 15;
  if ((await db.get('SELECT COUNT(*) c FROM resumes WHERE user_id=?', [req.user.id])).c >= max) return res.status(400).json({ error: 'You can keep up to ' + max + ' resumes. Delete one to add another.' });
  const b = req.body || {}, data = sanitizeData(b.data) || {}, str = JSON.stringify(data);
  if (str.length > MAX_DATA) return res.status(413).json({ error: 'Too large.' });
  const id = crypto.randomUUID(), now = Date.now(), title = clean(b.title).slice(0, 80) || 'Untitled resume';
  await db.run('INSERT INTO resumes(id,user_id,title,data,created_at,updated_at) VALUES(?,?,?,?,?,?)', [id, req.user.id, title, str, now, now]);
  res.json({ id, title, updated_at: now });
}));
app.get('/api/resumes/:id', A.requireAuth, ah(async (req, res) => {
  const r = await db.get('SELECT id,title,data,updated_at FROM resumes WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
  if (!r) return res.status(404).json({ error: 'Not found' });
  let data = {}; try { data = JSON.parse(r.data); } catch (e) {}
  res.json({ id: r.id, title: r.title, data, updated_at: r.updated_at });
}));
app.put('/api/resumes/:id', A.requireAuth, ah(async (req, res) => {
  const b = req.body || {}, cur = await db.get('SELECT id FROM resumes WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
  if (!cur) return res.status(404).json({ error: 'Not found' });
  const sets = [], args = [];
  if (b.title !== undefined) { sets.push('title=?'); args.push(clean(b.title).slice(0, 80) || 'Untitled resume'); }
  if (b.data !== undefined) { const d = sanitizeData(b.data); if (!d) return res.status(400).json({ error: 'Bad data' }); const s = JSON.stringify(d); if (s.length > MAX_DATA) return res.status(413).json({ error: 'Too large.' }); sets.push('data=?'); args.push(s); }
  const now = Date.now(); sets.push('updated_at=?'); args.push(now);
  await db.run('UPDATE resumes SET ' + sets.join(',') + ' WHERE id=? AND user_id=?', [...args, req.params.id, req.user.id]);
  res.json({ ok: true, updated_at: now });
}));
app.delete('/api/resumes/:id', A.requireAuth, ah(async (req, res) => { await db.run('DELETE FROM resumes WHERE id=? AND user_id=?', [req.params.id, req.user.id]); res.json({ ok: true }); }));

app.use('/api/admin', require('./lib/admin'));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

/* ---------- pages ---------- */
function page(name) { return fs.readFileSync(path.join(PUB, name), 'utf8').replace(/\{\{APP_NAME\}\}/g, APP_NAME).replace(/\{\{SUPPORT_EMAIL\}\}/g, SUPPORT_EMAIL || 'the site administrator'); }
const send = (res, name) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.send(page(name)); };
app.get('/', (req, res) => req.user ? send(res, 'app.html') : res.redirect('/login'));
app.get('/login', (req, res) => req.user ? res.redirect('/') : send(res, 'login.html'));
app.get('/admin', (req, res) => (req.user && req.user.role === 'admin') ? send(res, 'admin.html') : res.redirect(req.user ? '/' : '/login'));
app.get('/privacy', (req, res) => send(res, 'privacy.html'));
app.get('/terms', (req, res) => send(res, 'terms.html'));
app.use((req, res) => res.status(404).type('text').send('Not found'));
app.use((err, req, res, next) => { console.error(err); if (res.headersSent) return res.end(); res.status(err.status || 500).json({ code: 'upstream_error', error: err.type === 'entity.too.large' ? 'Too large' : 'Server error' }); });

/* ---------- startup: create tables, then create the first admin if needed ---------- */
async function boot() {
  await db.ready();
  const email = A.normEmail(process.env.ADMIN_EMAIL), pw = process.env.ADMIN_PASSWORD;
  const hasAdmin = await db.get("SELECT 1 x FROM users WHERE role='admin'");
  if (email && pw && !hasAdmin) {
    if (!A.validEmail(email) || pw.length < 8) { console.error('ADMIN_EMAIL / ADMIN_PASSWORD invalid (password needs 8+ characters). No admin created.'); }
    else {
      const now = Date.now();
      try {
        await db.run("INSERT INTO users(email,name,pass_hash,role,created_at,consent_at) VALUES(?,?,?, 'admin', ?, ?)", [email, 'Admin', await A.hashPassword(pw), now, now]);
        await db.audit(null, 'admin.bootstrap', email); console.log('Created first admin: ' + email + ' (remove ADMIN_PASSWORD from your .env now)');
      } catch (e) { if (e.code !== 'ER_DUP_ENTRY') throw e; }
    }
  } else if (!hasAdmin) console.log('No admin yet. Set ADMIN_EMAIL and ADMIN_PASSWORD, or run: npm run create-admin -- you@example.com "password"');
  if (require.main === module) app.listen(PORT, () => console.log(APP_NAME + ' running on http://localhost:' + PORT + ' (day resets in ' + db.TZ + ')'));
}
boot().catch(e => { console.error('Startup failed:', e.message); process.exit(1); });
module.exports = app;
