const db = require('./db');
const { limited } = require('./auth');
const KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const BASE = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';
const MAX_CHARS = 60000;
const SYSTEM = 'You power a resume-builder web app. Follow the instructions in the user message exactly. Reply with only the JSON the instructions ask for: no preface, no markdown fences.';

async function quotaFor(user) {
  const s = await db.getSettings();
  const limit = user.role === 'admin' ? 100000 : (user.daily_limit != null ? user.daily_limit : parseInt(s.default_daily_limit, 10) || 0);
  const row = await db.get('SELECT COUNT(*) c FROM ai_usage WHERE user_id=? AND day=?', [user.id, db.dayKey()]);
  const used = row.c;
  return { limit, used, remaining: Math.max(0, limit - used) };
}
const fail = (res, status, code, error) => { if (!res.headersSent) res.status(status).json({ code, error }); else res.end(); };

async function handler(req, res) {
  if (!KEY) return fail(res, 500, 'upstream_error', 'The server has no GEMINI_API_KEY set.');
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
  // Build Gemini "contents": role "assistant" -> "model", content -> parts[]
  const contents = msgs.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  if (body.image) {
    const im = body.image;
    if (!im || !['image/jpeg', 'image/png', 'image/webp'].includes(im.media_type) || typeof im.data !== 'string' || im.data.length > 6.5e6) return fail(res, 400, 'image_rejected', 'Bad image');
    contents[contents.length - 1].parts.unshift({ inline_data: { mime_type: im.media_type, data: im.data } });
  }
  const kind = ['chat', 'import', 'match'].includes(body.kind) ? body.kind : 'chat';
  if (limited('ai:' + req.user.id, 12, 60000)) return fail(res, 429, 'rate_limited', 'Too many requests. Wait a minute.');

  let q, s, cap;
  try {
    q = await quotaFor(req.user);
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
      BASE + '/v1beta/models/' + MODEL + ':streamGenerateContent?alt=sse',
      {
        method: 'POST',
        signal: ctl.signal,
        headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: SYSTEM }] }, contents, generationConfig: { maxOutputTokens: 6000 } })
      }
    );
  } catch (e) { await db.run('DELETE FROM ai_usage WHERE id=?', [rowId]); return fail(res, 502, 'upstream_error', 'Could not reach the AI service'); }
  if (!up.ok) {
    const t = await up.text().catch(() => ''); console.error('Gemini error', up.status, t.slice(0, 300));
    await db.run('DELETE FROM ai_usage WHERE id=?', [rowId]);
    return fail(res, up.status === 429 ? 429 : 502, up.status === 429 ? 'busy' : 'upstream_error', 'AI service error');
  }
  res.status(200); res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('X-Quota-Limit', String(q.limit)); res.setHeader('X-Quota-Remaining', String(Math.max(0, q.remaining - 1)));
  const reader = up.body.getReader(), dec = new TextDecoder(); let buf = '', inTok = 0, outTok = 0, wrote = false;
  try {
    for (;;) {
      const r = await reader.read(); if (r.done) break;
      buf += dec.decode(r.value, { stream: true });
      let i; while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        let ev; try { ev = JSON.parse(line.slice(5)); } catch (e) { continue; }
        try {
          if (ev.usageMetadata) { inTok = ev.usageMetadata.promptTokenCount || inTok; outTok = ev.usageMetadata.candidatesTokenCount || outTok; }
          const cand = ev.candidates && ev.candidates[0];
          if (cand && cand.content && Array.isArray(cand.content.parts)) for (const p of cand.content.parts) if (typeof p.text === 'string') { res.write(p.text); wrote = true; }
          if (ev.error) res.write('\u0000ERR:upstream_error');
        } catch (e) { /* ignore malformed chunk */ }
      }
    }
  } catch (e) { if (!ctl.signal.aborted) res.write('\u0000ERR:upstream_error'); }
  try { await db.run('UPDATE ai_usage SET input_tokens=?, output_tokens=?, ok=?, ms=? WHERE id=?', [inTok, outTok, wrote ? 1 : 0, Date.now() - started, rowId]); } catch (e) { console.error(e); }
  res.end();
}
module.exports = { handler, quotaFor };
