const db = require('./db');
const { limited } = require('./auth');
const billing = require('./billing');
// Uses Groq's free, OpenAI-compatible API (groq.com) — chosen because Google's
// newer Gemini API keys (the "AQ." prefix) are currently broken for third-party
// apps on Google's side, with no official fix yet. Groq's keys and API are stable.
const KEY = process.env.GROQ_API_KEY;
const MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const VISION_MODEL = process.env.GROQ_VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';
// Groq also hosts Whisper for audio transcription on the same OpenAI-compatible API/key —
// no separate account or secret needed. whisper-large-v3 (not the smaller -turbo variant)
// is the more accurate choice for Tamil and Tamil-English code-switched speech, which is
// what this app's voice input needs to handle; accuracy matters more than latency here
// since this runs once per recording, not per keystroke.
const TRANSCRIBE_MODEL = process.env.GROQ_TRANSCRIBE_MODEL || 'whisper-large-v3';
const BASE = process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1';
const MAX_CHARS = 60000;
const MAX_AUDIO_BYTES = 20 * 1024 * 1024; // ~20MB decoded — generous for several minutes of compressed mic audio
const SYSTEM = 'You power a resume-builder web app. Follow the instructions in the user message exactly. Reply with only the JSON the instructions ask for: no preface, no markdown fences.';

const ADMIN_BILLING = { plan: 'ADMIN', status: 'ACTIVE', unlimited: true, isPaid: true, planTier: 99, resumesAllocated: null, resumesUsed: 0, resumesRemaining: null, periodEnd: null };

// Legacy per-user/per-day AI call counter — now the ONLY rate limit on ordinary AI
// editing (resume creation itself is limited separately, by plan, in server.js).
// Admins and active paid plans bypass this numeric cap (as before this change);
// their real limit is the 12-requests/minute throttle below plus the global daily
// cap, same as previously. This is the "reasonable technical rate limit" the new
// pricing spec asks for in place of per-message credits.
async function quotaFor(user) {
  const s = await db.getSettings();
  const limit = user.role === 'admin' ? 100000 : (user.daily_limit != null ? user.daily_limit : parseInt(s.default_daily_limit, 10) || 0);
  const row = await db.get('SELECT COUNT(*) c FROM ai_usage WHERE user_id=? AND day=?', [user.id, db.dayKey()]);
  const used = row.c;
  return { limit, used, remaining: Math.max(0, limit - used) };
}
// `extra` (optional): additional JSON fields merged into the error body — used to tell
// the client WHICH gated feature was blocked (e.g. {feature:'ATS_IMPROVE'}) so the
// upgrade prompt it shows can name the actual benefit instead of a generic message.
const fail = (res, status, code, error, extra) => { if (!res.headersSent) res.status(status).json(Object.assign({ code, error }, extra)); else res.end(); };
// Writes a complete, non-streamed JSON reply as if it had streamed from the AI (same
// headers/shape the client expects from serverJson). Used for replies this server
// decides on its own — no Groq call needed.
function sendCanned(res, billingStatus, replyText) {
  setBillingHeaders(res, billingStatus);
  res.status(200); res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ reply: replyText, changes: [] }));
}
function setBillingHeaders(res, b) {
  res.setHeader('X-Billing-Plan', b.plan);
  res.setHeader('X-Is-Paid', b.isPaid ? '1' : '0');
  res.setHeader('X-Plan-Tier', b.planTier == null ? '' : String(b.planTier));
  res.setHeader('X-Resumes-Remaining', b.resumesRemaining == null ? '' : String(b.resumesRemaining));
  res.setHeader('X-Resumes-Allocated', b.resumesAllocated == null ? '' : String(b.resumesAllocated));
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
  const kind = ['chat', 'import', 'match', 'improve', 'improve_ats'].includes(body.kind) ? body.kind : 'chat';
  if (limited('ai:' + req.user.id, 12, 60000)) return fail(res, 429, 'rate_limited', 'Too many requests. Wait a minute.');

  /* ---------------- Plan/feature enforcement ----------------
     This is the ONLY place that decides whether an AI call happens, and it is
     always re-derived from the database (req.user.role + the user_usage /
     subscriptions tables) — the client's `kind` and message text are read only
     to classify the request, never trusted for the allow/deny decision itself.
     Ordinary resume editing (AI_EDIT) is allowed for every plan, including Free —
     there is no per-message charge any more. Only two things are plan-gated here:
     "Improve ATS Score" (Pro & Career Pro) and Job Description Match/tailoring
     (Career Pro only). Resume CREATION limits are enforced separately, in
     server.js's resume save routes — this endpoint is never where a resume is
     persisted, so it has nothing to do with the resume-creation counters. */
  let billingStatus, intent = null;
  try {
    billingStatus = req.user.role === 'admin' ? ADMIN_BILLING : await billing.getBillingStatus(req.user.id);
  } catch (e) { console.error(e); return fail(res, 500, 'upstream_error', 'Database error'); }

  if (kind === 'improve') {
    // The Job-Match panel's "Improve My Resume" — AI rewrite tailored to a specific
    // job description. Career Pro only, per the new pricing matrix.
    const check = billing.canUseFeature(billingStatus, billing.FEATURES.JOB_TAILOR);
    if (!check.allowed) { setBillingHeaders(res, billingStatus); return fail(res, 402, check.reason, billing.LOCKED_REPLY, { feature: 'JOB_TAILOR' }); }
  } else if (kind === 'improve_ats') {
    // The ATS Compatibility page's "Improve ATS Score" — Pro & Career Pro only.
    // (No job description involved; this is a resume-only parsing/structure fix.)
    const check = billing.canUseFeature(billingStatus, billing.FEATURES.ATS_IMPROVE);
    if (!check.allowed) { setBillingHeaders(res, billingStatus); return fail(res, 402, check.reason, billing.LOCKED_REPLY, { feature: 'ATS_IMPROVE' }); }
  } else if (kind === 'chat') {
    const lastUser = msgs[msgs.length - 1].content.split('USER_MESSAGE:\n').pop();
    intent = billing.classifyIntent(lastUser);
    if (intent === 'UNDO') {
      // The real Undo/Resume-History mechanism lives entirely client-side (it has
      // no server state to roll back) and is intercepted before this endpoint is
      // ever called in the normal UI. If a literal "undo" message reaches here
      // anyway, just point back at it — it isn't a resume edit and never was billed.
      return sendCanned(res, billingStatus, 'Use the Undo button above your last change, or Resume History, to revert to an earlier version.');
    }
    if (intent === 'JOB_MATCH' || intent === 'ADVANCED_FEATURE') {
      const featureName = intent === 'JOB_MATCH' ? 'JOB_MATCH' : 'JOB_TAILOR';
      const check = billing.canUseFeature(billingStatus, billing.FEATURES[featureName]);
      if (!check.allowed) { setBillingHeaders(res, billingStatus); return fail(res, 402, check.reason, billing.LOCKED_REPLY, { feature: featureName }); }
    }
    // Everything else (GENERAL_CHAT, COLOR_CHANGE, FORMAT_CHANGE, CONTENT_EDIT,
    // CONTENT_REWRITE) is ordinary AI-assisted editing — FEATURES.AI_EDIT is
    // ALWAYS_ALLOWED for every plan, including Free, so there is nothing to check
    // or charge here. The per-day/global caps below are the only remaining limit.
  }
  // kind === 'import' (reading an uploaded/pasted resume) is never gated here —
  // it is how a user gets their resume content in, not an "edit".

  let q, s, cap;
  try {
    // An active paid subscription (or admin) bypasses the legacy per-day abuse
    // counter, same as before this change — it never had a numeric daily cap of
    // its own, and still doesn't; the 12/minute throttle above and the site-wide
    // daily cap below still apply to everyone.
    q = (billingStatus.unlimited || billingStatus.isPaid) ? { limit: 100000, used: 0, remaining: 100000 } : await quotaFor(req.user);
    if (q.remaining <= 0) return fail(res, 429, 'quota_exceeded', 'Daily AI limit reached.');
    s = await db.getSettings(); cap = parseInt(s.global_daily_cap, 10) || 0;
    if (cap) { const row = await db.get('SELECT COUNT(*) c FROM ai_usage WHERE day=?', [db.dayKey()]); if (row.c >= cap) return fail(res, 429, 'busy', 'Site capacity reached for today.'); }
  } catch (e) { console.error(e); return fail(res, 500, 'upstream_error', 'Database error'); }

  const started = Date.now();
  let rowId;
  try { const ins = await db.run('INSERT INTO ai_usage(user_id,ts,day,kind) VALUES(?,?,?,?)', [req.user.id, started, db.dayKey(started), kind]); rowId = ins.insertId; }
  catch (e) { console.error(e); return fail(res, 500, 'upstream_error', 'Database error'); }
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
  } catch (e) { await db.run('DELETE FROM ai_usage WHERE id=?', [rowId]); return fail(res, 502, 'upstream_error', 'Could not reach the AI service'); }
  if (!up.ok) {
    const t = await up.text().catch(() => ''); console.error('Groq error', up.status, t.slice(0, 300));
    await db.run('DELETE FROM ai_usage WHERE id=?', [rowId]);
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
  try { await db.run('UPDATE ai_usage SET input_tokens=?, output_tokens=?, ok=?, ms=? WHERE id=?', [inTok, outTok, wrote ? 1 : 0, Date.now() - started, rowId]); } catch (e) { console.error(e); }
  res.end();
}
/* ---------------- Voice transcription (Groq Whisper) ----------------
   The browser's own SpeechRecognition (used by the mic button's quick/instant path)
   cannot do Tamil or Tamil-English code-switching at all — it's a single fixed
   language per session with no language-mixing support in any browser's implementation.
   This endpoint is the real fix for that: the client records actual audio (MediaRecorder)
   instead of relying on the browser's live transcription, uploads it here as one clip, and
   Whisper — a genuine multilingual speech model — transcribes it. No `language` parameter is
   pinned below: letting Whisper auto-detect per-segment handles mixed Tamil/English speech far
   better than forcing the whole clip into one language's phoneme set, at some cost to latency
   (this is a single request/response per recording, not live word-by-word text).
   Not gated by plan/feature — same footing as ordinary AI_EDIT chat, just rate-limited. */
async function transcribeHandler(req, res) {
  if (!KEY) return fail(res, 500, 'upstream_error', 'The server has no GROQ_API_KEY set.');
  const body = req.body;
  if (!body || typeof body.audio !== 'string' || !body.audio) return fail(res, 400, 'invalid_request', 'No audio provided');
  if (limited('voice:' + req.user.id, 20, 60000)) return fail(res, 429, 'rate_limited', 'Too many voice requests. Wait a minute and try again.');

  let buf;
  try { buf = Buffer.from(body.audio, 'base64'); } catch (e) { return fail(res, 400, 'invalid_request', 'Bad audio encoding'); }
  if (!buf.length) return fail(res, 400, 'invalid_request', 'Empty recording');
  if (buf.length > MAX_AUDIO_BYTES) return fail(res, 413, 'invalid_request', 'That recording is too long. Try a shorter clip.');

  const mime = typeof body.mime === 'string' && /^audio\//.test(body.mime) ? body.mime : 'audio/webm';
  const ext = mime.includes('ogg') ? 'ogg' : mime.includes('mp4') || mime.includes('m4a') ? 'm4a' : mime.includes('wav') ? 'wav' : 'webm';

  const form = new FormData();
  form.append('file', new Blob([buf], { type: mime }), 'voice.' + ext);
  form.append('model', TRANSCRIBE_MODEL);
  form.append('response_format', 'json');
  // A short context hint nudges Whisper toward resume-domain vocabulary (college names,
  // "ATS", "SQL", etc.) without constraining the language. Optional, client-supplied,
  // length-capped so it can't be abused to smuggle in an oversized prompt.
  if (typeof body.prompt === 'string' && body.prompt) form.append('prompt', body.prompt.slice(0, 200));

  let up;
  try {
    up = await fetch(BASE + '/audio/transcriptions', { method: 'POST', headers: { authorization: 'Bearer ' + KEY }, body: form });
  } catch (e) { return fail(res, 502, 'upstream_error', 'Could not reach the transcription service'); }
  if (!up.ok) {
    const t = await up.text().catch(() => ''); console.error('Groq transcription error', up.status, t.slice(0, 300));
    return fail(res, up.status === 429 ? 429 : 502, up.status === 429 ? 'busy' : 'upstream_error', 'Could not transcribe that recording. Please try again.');
  }
  let data;
  try { data = await up.json(); } catch (e) { return fail(res, 502, 'upstream_error', 'Bad response from the transcription service'); }
  const text = String((data && data.text) || '').trim();
  res.json({ text });
}

module.exports = { handler, transcribeHandler, quotaFor, ADMIN_BILLING };
