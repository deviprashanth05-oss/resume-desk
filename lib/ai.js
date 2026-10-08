const db = require('./db');
const { limited } = require('./auth');
const billing = require('./billing');
// Uses Groq's free, OpenAI-compatible API (groq.com) — chosen because Google's
// newer Gemini API keys (the "AQ." prefix) are currently broken for third-party
// apps on Google's side, with no official fix yet. Groq's keys and API are stable.
const KEY = process.env.GROQ_API_KEY;
const MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const VISION_MODEL = process.env.GROQ_VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';
const BASE = process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1';
const MAX_CHARS = 60000;
const SYSTEM = 'You power a resume-builder web app. Follow the instructions in the user message exactly. Reply with only the JSON the instructions ask for: no preface, no markdown fences.';

const ADMIN_BILLING = { plan: 'ADMIN', status: 'ACTIVE', unlimited: true, isPaid: true, creditsAllocated: null, creditsUsed: 0, creditsRemaining: null, trialComplete: false };

// Legacy per-user/per-day AI call counter. No longer the credit model (see
// lib/billing.js for that) — kept only as a coarse anti-abuse ceiling, so it uses
// a generous limit and never blocks an admin or an active paid plan (whose real
// cap is its own credit pool, enforced separately below).
async function quotaFor(user) {
  const s = await db.getSettings();
  const limit = user.role === 'admin' ? 100000 : (user.daily_limit != null ? user.daily_limit : parseInt(s.default_daily_limit, 10) || 0);
  const row = await db.get('SELECT COUNT(*) c FROM ai_usage WHERE user_id=? AND day=?', [user.id, db.dayKey()]);
  const used = row.c;
  return { limit, used, remaining: Math.max(0, limit - used) };
}
const fail = (res, status, code, error) => { if (!res.headersSent) res.status(status).json({ code, error }); else res.end(); };
// Writes a complete, non-streamed JSON reply as if it had streamed from the AI (same
// headers/shape the client expects from serverJson). Used for replies this server
// decides on its own — no Groq call, no cost, no credit consumed.
function sendCanned(res, billingStatus, replyText) {
  setBillingHeaders(res, billingStatus);
  res.status(200); res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ reply: replyText, changes: [] }));
}
function setBillingHeaders(res, b) {
  res.setHeader('X-Billing-Plan', b.plan);
  res.setHeader('X-Is-Paid', b.isPaid ? '1' : '0');
  res.setHeader('X-Credits-Remaining', b.creditsRemaining == null ? '' : String(b.creditsRemaining));
  res.setHeader('X-Credits-Allocated', b.creditsAllocated == null ? '' : String(b.creditsAllocated));
}

async function handler(req, res) {
  if (!KEY) return fail(res, 500, 'upstream_error', 'The server has no GROQ_API_KEY set.');
  const body = req.body;
  if (!body || !Array.isArray(body.messages) || !body.messages.length || body.messages.length > 30) return fail(res, 400, 'invalid_request', 'Bad messages');
  let chars = 0; const msgs = [];
  for (const m of body.messages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string' || !m.content) return fail(res, 400, 'invalid_request', 'Bad message');
    chars += m.content.length;
    const last = msgs[msgs.length - 1];
    if (last && last.role === m.role) last.content += '\n\n' + m.content; else msgs.push({ role: m.role, content: m.content });
  }
  if (chars > MAX_CHARS || msgs[0].role !== 'user' || msgs[msgs.length - 1].role !== 'user') return fail(res, 400, 'prompt_too_large', 'Too long or bad order');

  // Build OpenAI-style messages: [{role:'system',...}, {role:'user'|'assistant', content}]
  let model = MODEL;
  const oaMsgs = [{ role: 'system', content: SYSTEM }, ...msgs.map(m => ({ role: m.role, content: m.content }))];
  if (body.image) {
    const im = body.image;
    if (!im || !['image/jpeg', 'image/png', 'image/webp'].includes(im.media_type) || typeof im.data !== 'string' || im.data.length > 6.5e6) return fail(res, 400, 'image_rejected', 'Bad image');
    const last = oaMsgs[oaMsgs.length - 1];
    last.content = [
      { type: 'image_url', image_url: { url: 'data:' + im.media_type + ';base64,' + im.data } },
      { type: 'text', text: last.content }
    ];
    model = VISION_MODEL;
  }
  const kind = ['chat', 'import', 'match', 'improve'].includes(body.kind) ? body.kind : 'chat';
  if (limited('ai:' + req.user.id, 12, 60000)) return fail(res, 429, 'rate_limited', 'Too many requests. Wait a minute.');

  /* ---------------- Free Trial / paid credit-pool enforcement ----------------
     This is the ONLY place that decides whether an AI call happens, and it is
     always re-derived from the database (req.user.role + the user_usage /
     subscriptions tables) — the client's `kind` and message text are read only
     to classify the request, never trusted for the allow/deny decision itself. */
  let billingStatus, intent = null, usedCredit = false;
  try {
    billingStatus = req.user.role === 'admin' ? ADMIN_BILLING : await billing.getBillingStatus(req.user.id);
  } catch (e) { console.error(e); return fail(res, 500, 'upstream_error', 'Database error'); }

  // Every intent maps to exactly one entry in the central feature matrix
  // (lib/billing.js canUseFeature) — this is the only place that decides
  // allow/deny, so the rule is never duplicated or re-invented per endpoint.
  const FEATURE_FOR_INTENT = {
    COLOR_CHANGE: billing.FEATURES.COLOR_CHANGE, FORMAT_CHANGE: billing.FEATURES.FORMAT_CHANGE,
    CONTENT_EDIT: billing.FEATURES.CONTENT_EDIT, CONTENT_REWRITE: billing.FEATURES.CONTENT_EDIT,
    JOB_MATCH: billing.FEATURES.JOB_MATCH, ADVANCED_FEATURE: billing.FEATURES.JOB_OPTIMIZATION,
  };
  const errMsg = reason => reason === 'locked_feature' ? billing.LOCKED_REPLY : (reason === 'credits_exhausted' ? "You've used all of your AI credits for this plan." : billing.EXHAUSTED_REPLY);

  if (kind === 'improve') {
    // "AI resume optimization" against a job description (the Improve button) is a
    // paid-plan feature that also spends 1 credit, same matrix as everything else.
    const check = billing.canUseFeature(billingStatus, billing.FEATURES.JOB_OPTIMIZATION);
    if (!check.allowed) { setBillingHeaders(res, billingStatus); return fail(res, 402, check.reason, errMsg(check.reason)); }
    if (!billingStatus.unlimited) {
      try { usedCredit = await billing.consumeCredit(req.user.id); }
      catch (e) { console.error(e); return fail(res, 500, 'upstream_error', 'Database error'); }
      if (!usedCredit) { setBillingHeaders(res, billingStatus); return fail(res, 402, 'credits_exhausted', errMsg('credits_exhausted')); }
      billingStatus = req.user.role === 'admin' ? ADMIN_BILLING : await billing.getBillingStatus(req.user.id);
    }
  } else if (kind === 'chat') {
    const lastUser = msgs[msgs.length - 1].content.split('USER_MESSAGE:\n').pop();
    intent = billing.classifyIntent(lastUser);
    if (intent === 'UNDO') {
      // The real Undo/Resume-History mechanism lives entirely client-side (it has
      // no server state to roll back) and is intercepted before this endpoint is
      // ever called in the normal UI. If a literal "undo" message reaches here
      // anyway, never charge for it and never block it — it isn't a resume edit.
      return sendCanned(res, billingStatus, 'Use the Undo button above your last change, or Resume History, to revert to an earlier version. This does not use an AI credit.');
    }
    if (intent === 'GENERAL_CHAT') {
      // Not a locked *feature* — Free Trial is scoped to resume editing, not general
      // chat. Paid plans and admins get real AI chat here; everyone else gets a
      // canned reply so idle chat never spends a Groq call on their behalf.
      if (!billingStatus.unlimited && !billingStatus.isPaid) return sendCanned(res, billingStatus, billing.GENERAL_CHAT_REPLY);
    } else {
      const feature = FEATURE_FOR_INTENT[intent] || billing.FEATURES.CONTENT_EDIT;
      const check = billing.canUseFeature(billingStatus, feature);
      if (!check.allowed) { setBillingHeaders(res, billingStatus); return fail(res, 402, check.reason, errMsg(check.reason)); }
      if (billing.CONSUMES_CREDIT.has(feature) && !billingStatus.unlimited) {
        try { usedCredit = await billing.consumeCredit(req.user.id); }
        catch (e) { console.error(e); return fail(res, 500, 'upstream_error', 'Database error'); }
        if (!usedCredit) { setBillingHeaders(res, billingStatus); return fail(res, 402, billingStatus.isPaid ? 'credits_exhausted' : 'FREE_TRIAL_EXHAUSTED', errMsg(billingStatus.isPaid ? 'credits_exhausted' : 'FREE_TRIAL_EXHAUSTED')); }
        billingStatus = req.user.role === 'admin' ? ADMIN_BILLING : await billing.getBillingStatus(req.user.id); // refreshed count for the response headers
      }
    }
  }
  // kind === 'import' (reading an uploaded/pasted resume) is never gated here —
  // it is how a Free user gets their one resume in, not an "edit".

  let q, s, cap;
  try {
    // An active paid subscription (or admin) bypasses the legacy per-day abuse
    // counter — its own credit pool (30 or 70 credits) is the real cap now.
    q = (billingStatus.unlimited || billingStatus.isPaid) ? { limit: 100000, used: 0, remaining: 100000 } : await quotaFor(req.user);
    if (q.remaining <= 0) { if (usedCredit) await billing.refundCredit(req.user.id); return fail(res, 429, 'quota_exceeded', 'Daily AI limit reached.'); }
    s = await db.getSettings(); cap = parseInt(s.global_daily_cap, 10) || 0;
    if (cap) { const row = await db.get('SELECT COUNT(*) c FROM ai_usage WHERE day=?', [db.dayKey()]); if (row.c >= cap) { if (usedCredit) await billing.refundCredit(req.user.id); return fail(res, 429, 'busy', 'Site capacity reached for today.'); } }
  } catch (e) { console.error(e); if (usedCredit) await billing.refundCredit(req.user.id); return fail(res, 500, 'upstream_error', 'Database error'); }

  const started = Date.now();
  let rowId;
  try { const ins = await db.run('INSERT INTO ai_usage(user_id,ts,day,kind) VALUES(?,?,?,?)', [req.user.id, started, db.dayKey(started), kind]); rowId = ins.insertId; }
  catch (e) { console.error(e); if (usedCredit) await billing.refundCredit(req.user.id); return fail(res, 500, 'upstream_error', 'Database error'); }
  const ctl = new AbortController(); res.on('close', () => ctl.abort());
  let up;
  try {
    up = await fetch(
      BASE + '/chat/completions',
      {
        method: 'POST',
        signal: ctl.signal,
        headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + KEY },
        body: JSON.stringify({ model, messages: oaMsgs, stream: true, max_tokens: 6000 })
      }
    );
  } catch (e) { await db.run('DELETE FROM ai_usage WHERE id=?', [rowId]); if (usedCredit) await billing.refundCredit(req.user.id); return fail(res, 502, 'upstream_error', 'Could not reach the AI service'); }
  if (!up.ok) {
    const t = await up.text().catch(() => ''); console.error('Groq error', up.status, t.slice(0, 300));
    await db.run('DELETE FROM ai_usage WHERE id=?', [rowId]);
    if (usedCredit) await billing.refundCredit(req.user.id);
    return fail(res, up.status === 429 ? 429 : 502, up.status === 429 ? 'busy' : 'upstream_error', 'AI service error');
  }
  res.status(200); res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('X-Quota-Limit', String(q.limit)); res.setHeader('X-Quota-Remaining', String(Math.max(0, q.remaining - 1)));
  setBillingHeaders(res, billingStatus);
  const reader = up.body.getReader(), dec = new TextDecoder(); let buf = '', inTok = 0, outTok = 0, wrote = false;
  try {
    for (;;) {
      const r = await reader.read(); if (r.done) break;
      buf += dec.decode(r.value, { stream: true });
      let i; while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        let ev; try { ev = JSON.parse(payload); } catch (e) { continue; }
        try {
          if (ev.usage) { inTok = ev.usage.prompt_tokens || inTok; outTok = ev.usage.completion_tokens || outTok; }
          const choice = ev.choices && ev.choices[0];
          const delta = choice && choice.delta && choice.delta.content;
          if (typeof delta === 'string' && delta) { res.write(delta); wrote = true; }
        } catch (e) { /* ignore malformed chunk */ }
      }
    }
  } catch (e) { if (!ctl.signal.aborted) res.write('\u0000ERR:upstream_error'); }
  if (usedCredit && !wrote) { try { await billing.refundCredit(req.user.id); } catch (e) { console.error(e); } }
  try { await db.run('UPDATE ai_usage SET input_tokens=?, output_tokens=?, ok=?, ms=? WHERE id=?', [inTok, outTok, wrote ? 1 : 0, Date.now() - started, rowId]); } catch (e) { console.error(e); }
  res.end();
}
module.exports = { handler, quotaFor };
