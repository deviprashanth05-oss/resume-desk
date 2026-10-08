const crypto = require('crypto');
const express = require('express');
const db = require('./db');
const billing = require('./billing');
const { hashPassword, requireAdmin } = require('./auth');
const r = express.Router();
r.use(requireAdmin);
const DAY = 864e5;
const daysBack = n => { const a = []; for (let i = n - 1; i >= 0; i--) a.push(db.dayKey(Date.now() - i * DAY)); return a; };
const ah = fn => (req, res, next) => fn(req, res, next).catch(next);

r.get('/stats', ah(async (req, res) => {
  const now = Date.now(), today = db.dayKey(), d7 = db.dayKey(now - 6 * DAY), d30 = db.dayKey(now - 29 * DAY), s = await db.getSettings();
  const one = async (sql, ...a) => (await db.get(sql, a));
  const users = (await one('SELECT COUNT(*) c FROM users')).c;
  const stats = {
    users,
    admins: (await one("SELECT COUNT(*) c FROM users WHERE role='admin'")).c,
    disabled: (await one("SELECT COUNT(*) c FROM users WHERE status!='active'")).c,
    new7: (await one('SELECT COUNT(*) c FROM users WHERE created_at>=?', now - 7 * DAY)).c,
    active7: (await one('SELECT COUNT(*) c FROM users WHERE COALESCE(last_seen,last_login,0)>=?', now - 7 * DAY)).c,
    resumes: (await one('SELECT COUNT(*) c FROM resumes')).c,
    aiToday: (await one('SELECT COUNT(*) c FROM ai_usage WHERE day=?', today)).c,
    ai7: (await one('SELECT COUNT(*) c FROM ai_usage WHERE day>=?', d7)).c,
    ai30: (await one('SELECT COUNT(*) c FROM ai_usage WHERE day>=?', d30)).c,
    tokIn30: (await one('SELECT COALESCE(SUM(input_tokens),0) c FROM ai_usage WHERE day>=?', d30)).c,
    tokOut30: (await one('SELECT COALESCE(SUM(output_tokens),0) c FROM ai_usage WHERE day>=?', d30)).c,
    fail30: (await one('SELECT COUNT(*) c FROM ai_usage WHERE day>=? AND ok=0', d30)).c
  };
  const pin = parseFloat(s.price_in), pout = parseFloat(s.price_out);
  stats.cost30 = (isFinite(pin) && isFinite(pout) && s.price_in !== '' && s.price_out !== '') ? (stats.tokIn30 / 1e6 * pin + stats.tokOut30 / 1e6 * pout) : null;
  stats.currency = s.currency;
  const usageRows = await db.all('SELECT day, COUNT(*) calls, COALESCE(SUM(input_tokens),0) tin, COALESCE(SUM(output_tokens),0) tout FROM ai_usage WHERE day>=? GROUP BY day', [d30]);
  const usage = Object.fromEntries(usageRows.map(x => [x.day, x]));
  const series = daysBack(30).map(d => ({ day: d, calls: (usage[d] || {}).calls || 0, tokens: Number((usage[d] || {}).tin || 0) + Number((usage[d] || {}).tout || 0) }));
  const top = await db.all('SELECT u.id, u.email, u.name, COUNT(*) calls FROM ai_usage a JOIN users u ON u.id=a.user_id WHERE a.day>=? GROUP BY u.id, u.email, u.name ORDER BY calls DESC LIMIT 8', [d30]);
  const kinds = await db.all('SELECT kind, COUNT(*) calls FROM ai_usage WHERE day>=? GROUP BY kind', [d30]);
  res.json({ stats, series, top, kinds });
}));

r.get('/users', ah(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 80), page = Math.max(1, parseInt(req.query.page, 10) || 1), per = 20;
  const sortMap = { created: 'u.created_at DESC', seen: 'COALESCE(u.last_seen,u.last_login,0) DESC', ai: 'ai30 DESC', resumes: 'resumes DESC', email: 'u.email ASC' };
  const order = sortMap[req.query.sort] || sortMap.created, where = q ? 'WHERE u.email LIKE ? OR u.name LIKE ?' : '', args = q ? ['%' + q + '%', '%' + q + '%'] : [];
  // Bulk, global version of billing.expireIfDue — flips any subscription whose
  // billing period has passed before this listing reads plan/status (section 8).
  await db.run("UPDATE subscriptions SET status='EXPIRED' WHERE status='ACTIVE' AND end_date<=?", [Date.now()]);
  const total = (await db.get('SELECT COUNT(*) c FROM users u ' + where, args)).c;
  const d30 = db.dayKey(Date.now() - 29 * DAY), today = db.dayKey();
  const rows = await db.all(`SELECT u.id,u.email,u.name,u.role,u.status,u.daily_limit,u.created_at,u.last_login,u.last_seen,u.consent_at,
    (SELECT COUNT(*) FROM resumes WHERE user_id=u.id) resumes,
    (SELECT COUNT(*) FROM ai_usage WHERE user_id=u.id AND day>=?) ai30,
    (SELECT COUNT(*) FROM ai_usage WHERE user_id=u.id AND day=?) aiToday,
    (SELECT COALESCE(SUM(input_tokens+output_tokens),0) FROM ai_usage WHERE user_id=u.id AND day>=?) tokens30,
    (SELECT free_trial_edits FROM user_usage WHERE user_id=u.id) trialEdits,
    (SELECT plan FROM subscriptions WHERE user_id=u.id ORDER BY id DESC LIMIT 1) subPlan,
    (SELECT status FROM subscriptions WHERE user_id=u.id ORDER BY id DESC LIMIT 1) subStatus,
    (SELECT start_date FROM subscriptions WHERE user_id=u.id ORDER BY id DESC LIMIT 1) subStart,
    (SELECT end_date FROM subscriptions WHERE user_id=u.id ORDER BY id DESC LIMIT 1) subEnd,
    (SELECT subscription_source FROM subscriptions WHERE user_id=u.id ORDER BY id DESC LIMIT 1) subSource,
    (SELECT subscription_id FROM subscriptions WHERE user_id=u.id ORDER BY id DESC LIMIT 1) subId
    FROM users u ${where} ORDER BY ${order} LIMIT ? OFFSET ?`, [d30, today, d30, ...args, per, (page - 1) * per]);
  res.json({ users: rows, total, page, per, defaultLimit: parseInt((await db.getSettings()).default_daily_limit, 10) });
}));

async function target(req, res) {
  const u = await db.get('SELECT id,email,role,status FROM users WHERE id=?', [parseInt(req.params.id, 10)]);
  if (!u) { res.status(404).json({ code: 'not_found', error: 'User not found' }); return null; }
  return u;
}
const adminCount = async () => (await db.get("SELECT COUNT(*) c FROM users WHERE role='admin' AND status='active'")).c;

r.patch('/users/:id', ah(async (req, res) => {
  const u = await target(req, res); if (!u) return;
  const b = req.body || {}, changes = [];
  if (b.status !== undefined) {
    if (!['active', 'disabled'].includes(b.status)) return res.status(400).json({ error: 'Bad status' });
    if (u.id === req.user.id && b.status !== 'active') return res.status(400).json({ error: 'You cannot disable your own account.' });
    if (u.role === 'admin' && b.status !== 'active' && (await adminCount()) <= 1) return res.status(400).json({ error: 'You cannot disable the last admin.' });
    await db.run('UPDATE users SET status=? WHERE id=?', [b.status, u.id]);
    if (b.status !== 'active') await db.run('DELETE FROM sessions WHERE user_id=?', [u.id]);
    changes.push('status=' + b.status);
  }
  if (b.role !== undefined) {
    if (!['user', 'admin'].includes(b.role)) return res.status(400).json({ error: 'Bad role' });
    if (u.id === req.user.id && b.role !== 'admin') return res.status(400).json({ error: 'You cannot remove your own admin role.' });
    if (u.role === 'admin' && b.role !== 'admin' && (await adminCount()) <= 1) return res.status(400).json({ error: 'You cannot remove the last admin.' });
    await db.run('UPDATE users SET role=? WHERE id=?', [b.role, u.id]); changes.push('role=' + b.role);
  }
  if (b.daily_limit !== undefined) {
    let v = b.daily_limit === null || b.daily_limit === '' ? null : parseInt(b.daily_limit, 10);
    if (v !== null && (!isFinite(v) || v < 0 || v > 100000)) return res.status(400).json({ error: 'Limit must be 0 to 100000, or blank for the default.' });
    await db.run('UPDATE users SET daily_limit=? WHERE id=?', [v, u.id]); changes.push('daily_limit=' + (v === null ? 'default' : v));
  }
  if (changes.length) await db.audit(req.user, 'user.update', u.email, changes.join(', '));
  res.json({ ok: true });
}));

r.post('/users/:id/reset-password', ah(async (req, res) => {
  const u = await target(req, res); if (!u) return;
  const temp = crypto.randomBytes(9).toString('base64url');
  await db.run('UPDATE users SET pass_hash=?, must_change=1 WHERE id=?', [await hashPassword(temp), u.id]);
  await db.run('DELETE FROM sessions WHERE user_id=?', [u.id]);
  await db.audit(req.user, 'user.reset_password', u.email);
  res.json({ ok: true, temporaryPassword: temp });
}));

// Manual subscription grant/cancel — the interim way to monetize before Razorpay
// (Step 3) is wired up: verify a payment yourself (UPI, bank transfer, etc.) and
// grant access here. This never fabricates a Razorpay payment; it is a separate,
// explicit admin action, same as any other admin override in this file.
// Accepts explicit plan/start/end/status/source (section 10) so an admin can back-
// date a grant, pre-expire one for testing, or record who/what created it — not
// just "N days from now".
r.post('/users/:id/subscription', ah(async (req, res) => {
  const u = await target(req, res); if (!u) return;
  const b = req.body || {};
  if (b.plan === 'NONE') {
    await db.run("UPDATE subscriptions SET status='CANCELLED' WHERE user_id=? AND status='ACTIVE'", [u.id]);
    await db.audit(req.user, 'subscription.cancel', u.email);
    return res.json({ ok: true });
  }
  if (!billing.PLANS[b.plan]) return res.status(400).json({ error: 'Plan must be WEEKLY or MONTHLY.' });
  const status = ['ACTIVE', 'EXPIRED', 'CANCELLED'].includes(b.status) ? b.status : 'ACTIVE';
  const source = ['MANUAL', 'RAZORPAY', 'ADMIN'].includes(b.source) ? b.source : 'ADMIN';
  const now = Date.now();
  let start = b.start_date ? Date.parse(b.start_date) : now;
  let end = b.end_date ? Date.parse(b.end_date) : (start + (parseInt(b.days, 10) || billing.PLANS[b.plan].days) * 864e5);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return res.status(400).json({ error: 'Start/end dates are invalid, or end is not after start.' });
  await db.run("UPDATE subscriptions SET status='CANCELLED' WHERE user_id=? AND status='ACTIVE'", [u.id]);
  await db.run('INSERT INTO subscriptions(user_id,plan,status,start_date,end_date,subscription_id,subscription_source,created_at) VALUES(?,?,?,?,?,?,?,?)',
    [u.id, b.plan, status, start, end, 'manual:' + crypto.randomUUID(), source, now]);
  await db.audit(req.user, 'subscription.grant', u.email, b.plan + ' ' + status + ' until ' + new Date(end).toISOString().slice(0, 10));
  res.json({ ok: true, plan: b.plan, status, start_date: start, end_date: end, source });
}));

r.delete('/users/:id', ah(async (req, res) => {
  const u = await target(req, res); if (!u) return;
  if (u.id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account here.' });
  if (u.role === 'admin' && (await adminCount()) <= 1) return res.status(400).json({ error: 'You cannot delete the last admin.' });
  await db.run('DELETE FROM users WHERE id=?', [u.id]);
  await db.audit(req.user, 'user.delete', u.email);
  res.json({ ok: true });
}));

r.get('/settings', ah(async (req, res) => res.json(await db.getSettings())));
r.put('/settings', ah(async (req, res) => {
  const b = req.body || {}, out = [];
  const int = async (k, min, max) => { if (b[k] === undefined) return; const v = parseInt(b[k], 10); if (!isFinite(v) || v < min || v > max) throw new Error(k + ' must be between ' + min + ' and ' + max); await db.setSetting(k, v); out.push(k); };
  try {
    await int('default_daily_limit', 0, 100000); await int('global_daily_cap', 0, 10000000); await int('max_resumes', 1, 200); await int('free_trial_edits', 0, 1000);
    if (b.signups_open !== undefined) { await db.setSetting('signups_open', b.signups_open ? '1' : '0'); out.push('signups_open'); }
    for (const k of ['price_in', 'price_out']) if (b[k] !== undefined) { const t = String(b[k]).trim(); if (t !== '' && !isFinite(parseFloat(t))) throw new Error(k + ' must be a number'); await db.setSetting(k, t); out.push(k); }
    if (b.currency !== undefined) { await db.setSetting('currency', String(b.currency).slice(0, 4)); out.push('currency'); }
    if (b.announcement !== undefined) { await db.setSetting('announcement', String(b.announcement).slice(0, 200)); out.push('announcement'); }
  } catch (e) { return res.status(400).json({ error: e.message }); }
  if (out.length) await db.audit(req.user, 'settings.update', out.join(', '));
  res.json(await db.getSettings());
}));
r.get('/audit', ah(async (req, res) => res.json(await db.all('SELECT ts, admin_email, action, target, detail FROM audit ORDER BY id DESC LIMIT 100'))));
module.exports = r;
