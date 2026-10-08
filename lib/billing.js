const db = require('./db');

// Credit-based access model (replaces the old "unlimited for any paid plan" model).
// Every account gets exactly 2 free AI credits, once, for life. Paid plans are also
// credit pools (not unlimited): Weekly = 30 credits / 7 days, Monthly = 70 credits / 30 days.
// Razorpay (a future step) will insert rows into `subscriptions` after a verified
// payment; nothing here fabricates a successful payment or grants credits on its own.
const PLANS = {
  WEEKLY: { plan: 'WEEKLY', label: 'Weekly', price: 349, currency: '₹', days: 7, credits: 30, recommended: false,
    features: ['30 AI credits', 'AI resume editing & rewriting', 'ATS Compatibility Score', 'Job Description matching', 'AI resume optimization', 'Resume version history'] },
  MONTHLY: { plan: 'MONTHLY', label: 'Monthly', price: 649, currency: '₹', days: 30, credits: 70, recommended: true,
    features: ['70 AI credits', 'AI resume editing & rewriting', 'ATS Compatibility Score', 'Job Description matching', 'AI resume optimization', 'Resume version history'] },
};

// Every new account's lifetime Free Trial allowance. Admin-configurable (settings.free_trial_edits),
// but the spec is explicit: 2, once, forever — this is only ever read when a user's very first
// usage row is created (see ensureUsageRow), so changing the setting later never resets anyone.
async function freeTrialLimit() {
  const s = await db.getSettings();
  const n = parseInt(s.free_trial_edits, 10);
  return Number.isFinite(n) && n >= 0 ? n : 2;
}

async function ensureUsageRow(userId) {
  let row = await db.get('SELECT * FROM user_usage WHERE user_id=?', [userId]);
  if (!row) {
    const now = Date.now(), limit = await freeTrialLimit();
    try {
      await db.run('INSERT INTO user_usage(user_id,free_trial_edits,free_trial_started_at,free_trial_completed_at,updated_at) VALUES(?,?,?,?,?)',
        [userId, limit, now, null, now]);
    } catch (e) { if (e.code !== 'ER_DUP_ENTRY') throw e; } // concurrent first-request race
    row = await db.get('SELECT * FROM user_usage WHERE user_id=?', [userId]);
  }
  return row;
}

// Subscription status in the database is the source of truth — not a date comparison
// invented at read time. Any ACTIVE row whose billing period has passed is flipped to
// EXPIRED here, lazily, the moment anything checks it. No cron needed: every call to
// getBillingStatus passes through this first.
async function expireIfDue(userId) {
  await db.run("UPDATE subscriptions SET status='EXPIRED' WHERE user_id=? AND status='ACTIVE' AND end_date<=?", [userId, Date.now()]);
}
async function activeSubscription(userId) {
  await expireIfDue(userId);
  return db.get("SELECT * FROM subscriptions WHERE user_id=? AND status='ACTIVE' AND end_date>? ORDER BY end_date DESC LIMIT 1", [userId, Date.now()]);
}

// Single source of truth for "what is this user allowed to do right now, and with how
// many credits". Always re-derived from the database (subscription row + usage row) —
// never from anything the client sends, so neither the Free Trial nor a paid credit
// pool can be bypassed via the API. Falling back to FREE here never creates or resets
// a Free Trial: ensureUsageRow only ever INSERTs once per user, the first time they're
// seen, so a Free → Weekly → expired → Free user keeps whatever trial balance they had.
async function getBillingStatus(userId) {
  const sub = await activeSubscription(userId);
  if (sub) {
    const allocated = sub.credits_allocated || 0;
    const used = sub.credits_used || 0;
    const remaining = Math.max(0, allocated - used);
    return {
      plan: sub.plan, status: 'ACTIVE', isPaid: true,
      creditsAllocated: allocated, creditsUsed: used, creditsRemaining: remaining,
      trialComplete: false, maxResumes: null, endDate: sub.end_date,
    };
  }
  const usage = await ensureUsageRow(userId);
  const allocated = await freeTrialLimit();
  const remaining = Math.max(0, usage.free_trial_edits);
  return {
    plan: 'FREE', status: 'ACTIVE', isPaid: false,
    creditsAllocated: allocated, creditsUsed: Math.max(0, allocated - remaining), creditsRemaining: remaining,
    trialComplete: remaining <= 0, maxResumes: 1, endDate: null,
  };
}

// ---- Central feature matrix ----
// One function every endpoint calls — ai.js, the resume-creation route, and the
// client-side ATS/Job-Match gate check — instead of each re-implementing its own
// idea of what Free vs. Weekly vs. Monthly can do.
const FEATURES = {
  AI_RESUME_EDIT: 'AI_RESUME_EDIT', COLOR_CHANGE: 'COLOR_CHANGE', FORMAT_CHANGE: 'FORMAT_CHANGE',
  CONTENT_EDIT: 'CONTENT_EDIT', ATS_SCORE: 'ATS_SCORE', JOB_MATCH: 'JOB_MATCH',
  JOB_OPTIMIZATION: 'JOB_OPTIMIZATION', RESUME_HISTORY: 'RESUME_HISTORY', MULTIPLE_RESUMES: 'MULTIPLE_RESUMES',
};
// Viewing your own data is never blocked, even with zero credits or an expired
// subscription — the account and its history stay visible, just read-only.
const ALWAYS_ALLOWED = new Set([FEATURES.RESUME_HISTORY]);
// Needs at least 1 credit available (free or paid), but doesn't itself consume one —
// ATS scoring is deterministic/local, just gated by whether the trial/plan is still active.
const CREDIT_GATED_FREE = new Set([FEATURES.ATS_SCORE]);
// Costs exactly 1 credit on a successful AI modification. Available on Free (while
// credits remain) and on any paid plan (while its credit pool isn't empty).
const CREDIT_CONSUMING = new Set([FEATURES.AI_RESUME_EDIT, FEATURES.COLOR_CHANGE, FEATURES.FORMAT_CHANGE, FEATURES.CONTENT_EDIT]);
// Paid-plan-only AND costs a credit: resume optimization against a job description.
const PAID_CREDIT_CONSUMING = new Set([FEATURES.JOB_OPTIMIZATION]);
// Paid-plan-only, free of charge once unlocked (no credit cost): Job Match itself is a
// deterministic, non-AI score; having more than one resume is just an account cap.
const PAID_ONLY = new Set([FEATURES.JOB_MATCH, FEATURES.MULTIPLE_RESUMES]);
// Every feature that costs a credit when it succeeds — ai.js checks this set to decide
// whether to call consumeCredit() after a successful AI call.
const CONSUMES_CREDIT = new Set([...CREDIT_CONSUMING, ...PAID_CREDIT_CONSUMING]);

// billingStatus comes from getBillingStatus() — never pass a client-supplied plan/flag in.
// A billingStatus with `unlimited: true` (the admin shortcut) always passes.
function canUseFeature(billingStatus, feature) {
  if (billingStatus.unlimited) return { allowed: true };
  if (ALWAYS_ALLOWED.has(feature)) return { allowed: true };
  const hasCredits = (billingStatus.creditsRemaining || 0) > 0;
  if (CREDIT_GATED_FREE.has(feature) || CREDIT_CONSUMING.has(feature)) {
    return hasCredits ? { allowed: true } : { allowed: false, reason: billingStatus.isPaid ? 'credits_exhausted' : 'FREE_TRIAL_EXHAUSTED' };
  }
  if (PAID_CREDIT_CONSUMING.has(feature)) {
    if (!billingStatus.isPaid) return { allowed: false, reason: 'locked_feature' };
    return hasCredits ? { allowed: true } : { allowed: false, reason: 'credits_exhausted' };
  }
  if (PAID_ONLY.has(feature)) return billingStatus.isPaid ? { allowed: true } : { allowed: false, reason: 'locked_feature' };
  return { allowed: false, reason: 'locked_feature' };
}

// Atomic + race-safe credit spend, works for either a Free Trial balance (user_usage)
// or an active paid subscription's credit pool (subscriptions) — callers don't need to
// know which one applies; this looks up the current active subscription itself.
async function consumeCredit(userId) {
  const sub = await activeSubscription(userId);
  if (sub) {
    const res = await db.run('UPDATE subscriptions SET credits_used=credits_used+1 WHERE id=? AND credits_used<credits_allocated', [sub.id]);
    return res.affectedRows > 0;
  }
  const res = await db.run('UPDATE user_usage SET free_trial_edits=free_trial_edits-1, updated_at=? WHERE user_id=? AND free_trial_edits>0', [Date.now(), userId]);
  if (res.affectedRows > 0) {
    const row = await db.get('SELECT free_trial_edits FROM user_usage WHERE user_id=?', [userId]);
    if (row && row.free_trial_edits <= 0) await db.run('UPDATE user_usage SET free_trial_completed_at=? WHERE user_id=? AND free_trial_completed_at IS NULL', [Date.now(), userId]);
  }
  return res.affectedRows > 0;
}
// Rolls back a credit when the AI call itself fails upstream (so a failed edit never
// costs the user part of their trial or paid credit pool). Mirrors consumeCredit's
// own lookup of which pool was charged.
async function refundCredit(userId) {
  const sub = await activeSubscription(userId);
  if (sub) { await db.run('UPDATE subscriptions SET credits_used=GREATEST(0,credits_used-1) WHERE id=?', [sub.id]); return; }
  await db.run('UPDATE user_usage SET free_trial_edits=free_trial_edits+1, free_trial_completed_at=NULL, updated_at=? WHERE user_id=?', [Date.now(), userId]);
}

// ---- Intent classification ----
// Deterministic keyword rules, not an AI call — classification must be cheap and must
// happen before we decide whether an AI call (and a credit) is even allowed.
const COLOR_RE = /\b(colou?r|accent)\b/i;
const FORMAT_RE = /\b(template|format|layout)\b/i;
const JOBMATCH_RE = /\b(job description|job match|match(ing)? (this|my resume|it) (against|to|with)|compare .*(job|jd)\b|\bjd\b)/i;
const ADVANCED_RE = /\b(career strategy|career plan|which jobs?|job market|salary negotiation|interview prep|cover letter|linkedin strategy|job search strategy)\b/i;
const EDIT_VERB_RE = /\b(change|update|rewrite|improve|edit|fix|add|remove|delete|shorten|expand|rephrase|polish|optimi[sz]e|make|rewrite|tighten|strengthen|reword|convert)\b/i;
const CHAT_ONLY_RE = /^\s*(hi|hello|hey|thanks|thank you|ok|okay)\b/i;
const QUESTION_RE = /\b(what can you|what does|how does this work|what is|who are you|can you help|show me what)\b/i;
// Pure advice/explanation (no resume change), e.g. "how can I improve my summary" or
// "why is my resume score low" — never consumes a credit, even though it matches an
// edit-shaped word, because nothing is actually being modified.
const ADVICE_ONLY_RE = /^\s*(why|how can i|how do i|what should i|any (tips|advice)|can you (explain|suggest))\b.*\?\s*$/i;
// "undo"/"revert"/"put it back" use the existing Resume History mechanism, not a new
// AI call, so this must be classified before anything else charges a credit for it.
const UNDO_RE = /\b(undo|revert|put it back|restore (the|my) (last|previous)|go back)\b/i;

function classifyIntent(text) {
  const t = String(text || '').trim();
  if (!t) return 'GENERAL_CHAT';
  if (UNDO_RE.test(t)) return 'UNDO';
  if (JOBMATCH_RE.test(t)) return 'JOB_MATCH';
  if (ADVANCED_RE.test(t)) return 'ADVANCED_FEATURE';
  if (ADVICE_ONLY_RE.test(t)) return 'GENERAL_CHAT';
  if (COLOR_RE.test(t) && (EDIT_VERB_RE.test(t) || t.split(/\s+/).length <= 8)) return 'COLOR_CHANGE';
  if (FORMAT_RE.test(t) && (EDIT_VERB_RE.test(t) || t.split(/\s+/).length <= 8)) return 'FORMAT_CHANGE';
  if (CHAT_ONLY_RE.test(t) || (QUESTION_RE.test(t) && !EDIT_VERB_RE.test(t))) return 'GENERAL_CHAT';
  if (/\b(rewrite|overhaul|restructure|reframe|rework)\b/i.test(t)) return 'CONTENT_REWRITE';
  if (EDIT_VERB_RE.test(t)) return 'CONTENT_EDIT';
  // Short, verb-less messages with no resume content read as idle chat; anything
  // longer is more likely to be a pasted instruction, so default to allowing it
  // as a content edit rather than wrongly blocking a genuine request.
  return t.split(/\s+/).length <= 4 ? 'GENERAL_CHAT' : 'CONTENT_EDIT';
}

const CREDIT_INTENTS = new Set(['COLOR_CHANGE', 'FORMAT_CHANGE', 'CONTENT_EDIT', 'CONTENT_REWRITE']);
const LOCKED_FOR_FREE = new Set(['JOB_MATCH', 'ADVANCED_FEATURE']);

const GENERAL_CHAT_REPLY = 'Your Free Trial currently supports resume editing for color, format, and content changes. Upgrade to continue with more AI credits and advanced career features.';
const LOCKED_REPLY = 'That feature is part of a paid ITC Resume plan. Upgrade to unlock it.';
const EXHAUSTED_REPLY = 'Your free AI credits have been used. Upgrade to continue editing and analyzing your resume.';

// Admin dashboard: one subscription row per user (most recent), plus usage/resume
// counts, for the Users table. Never includes secret payment data — subscription_id
// here is either our own "manual:<uuid>" or a future Razorpay id, both safe to show
// to the site's own admin.
async function subscriptionSummary(userId) {
  await expireIfDue(userId);
  return db.get('SELECT plan,status,start_date,end_date,subscription_id,subscription_source,credits_allocated,credits_used FROM subscriptions WHERE user_id=? ORDER BY id DESC LIMIT 1', [userId]);
}

module.exports = {
  PLANS, FEATURES, ALWAYS_ALLOWED, CREDIT_GATED_FREE, CREDIT_CONSUMING, PAID_CREDIT_CONSUMING, PAID_ONLY, CONSUMES_CREDIT,
  canUseFeature, freeTrialLimit, ensureUsageRow, activeSubscription, subscriptionSummary, getBillingStatus,
  consumeCredit, refundCredit, classifyIntent, CREDIT_INTENTS, LOCKED_FOR_FREE,
  GENERAL_CHAT_REPLY, LOCKED_REPLY, EXHAUSTED_REPLY,
};
