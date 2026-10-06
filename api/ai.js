// POST /api/ai  { messages: [{role, content}], image?: {media_type, data} }
// Streams back the model's raw text. The API key never reaches the browser.
const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5';
const BASE = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
const HOURLY = parseInt(process.env.LIMIT_PER_HOUR || '20', 10);   // AI calls per visitor per hour
const DAILY = parseInt(process.env.LIMIT_PER_DAY || '1500', 10);   // AI calls for the whole site per day
const MAX_CHARS = 60000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '';           // e.g. https://resumedesk.example.com
const UP_URL = process.env.UPSTASH_REDIS_REST_URL, UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const SYSTEM = 'You power a resume-builder web app. Follow the instructions in the user message exactly. Reply with only the JSON the instructions ask for: no preface, no markdown fences.';
const mem = new Map();

async function hit(key, limit, windowSec) {
  if (UP_URL && UP_TOKEN) {
    try {
      const r = await fetch(UP_URL + '/pipeline', { method: 'POST', headers: { Authorization: 'Bearer ' + UP_TOKEN }, body: JSON.stringify([['SET', key, 0, 'EX', windowSec, 'NX'], ['INCR', key]]) });
      const j = await r.json(); return Number(j[1].result) <= limit;
    } catch (e) { /* fall back to memory below */ }
  }
  const now = Date.now(); let e = mem.get(key);
  if (!e || e.exp < now) { e = { n: 0, exp: now + windowSec * 1000 }; mem.set(key, e); }
  e.n++; if (mem.size > 5000) for (const [k, v] of mem) if (v.exp < now) mem.delete(k);
  return e.n <= limit;
}
const clientIp = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'x').split(',')[0].trim();
function fail(res, status, code, error) { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ code, error })); }

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return fail(res, 405, 'invalid_request', 'POST only');
  if (!KEY) return fail(res, 500, 'upstream_error', 'Server is missing ANTHROPIC_API_KEY');
  if (ALLOWED_ORIGIN && req.headers.origin && req.headers.origin !== ALLOWED_ORIGIN) return fail(res, 403, 'invalid_request', 'Origin not allowed');

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  if (!body || !Array.isArray(body.messages) || !body.messages.length || body.messages.length > 30) return fail(res, 400, 'invalid_request', 'Bad messages');
  let chars = 0; const msgs = [];
  for (const m of body.messages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string' || !m.content) return fail(res, 400, 'invalid_request', 'Bad message');
    chars += m.content.length;
    const last = msgs[msgs.length - 1];
    if (last && last.role === m.role) last.content += '\n\n' + m.content; else msgs.push({ role: m.role, content: m.content });
  }
  if (chars > MAX_CHARS || msgs[0].role !== 'user' || msgs[msgs.length - 1].role !== 'user') return fail(res, 400, 'prompt_too_large', 'Too long or bad order');
  if (body.image) {
    const im = body.image;
    if (!im || !['image/jpeg', 'image/png', 'image/webp'].includes(im.media_type) || typeof im.data !== 'string' || im.data.length > 6.5e6) return fail(res, 400, 'image_rejected', 'Bad image');
    const l = msgs[msgs.length - 1];
    l.content = [{ type: 'image', source: { type: 'base64', media_type: im.media_type, data: im.data } }, { type: 'text', text: l.content }];
  }

  const ip = clientIp(req), day = new Date().toISOString().slice(0, 10);
  if (!(await hit('rd:ip:' + ip, HOURLY, 3600))) return fail(res, 429, 'rate_limited', 'Hourly limit reached');
  if (!(await hit('rd:day:' + day, DAILY, 86400))) return fail(res, 429, 'busy', 'Daily capacity reached');

  const ctl = new AbortController(); res.on('close', () => ctl.abort());
  let up;
  try {
    up = await fetch(BASE + '/v1/messages', { method: 'POST', signal: ctl.signal, headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model: MODEL, max_tokens: 6000, stream: true, system: SYSTEM, messages: msgs }) });
  } catch (e) { return fail(res, 502, 'upstream_error', 'Could not reach the AI service'); }
  if (!up.ok) {
    const t = await up.text().catch(() => ''); console.error('Anthropic error', up.status, t.slice(0, 300));
    return fail(res, up.status === 429 ? 429 : 502, up.status === 429 ? 'busy' : 'upstream_error', 'AI service error');
  }
  res.statusCode = 200; res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Accel-Buffering', 'no');
  const reader = up.body.getReader(), dec = new TextDecoder(); let buf = '';
  try {
    for (;;) {
      const r = await reader.read(); if (r.done) break;
      buf += dec.decode(r.value, { stream: true });
      let i; while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        let ev; try { ev = JSON.parse(line.slice(5)); } catch (e) { continue; }
        if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') res.write(ev.delta.text);
        else if (ev.type === 'error') { res.write('\u0000ERR:upstream_error'); }
      }
    }
  } catch (e) { if (!ctl.signal.aborted) res.write('\u0000ERR:upstream_error'); }
  res.end();
};
