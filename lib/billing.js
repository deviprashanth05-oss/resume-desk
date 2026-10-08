const db = require('./db');

// Step 1 of the paywall: Free Trial + subscription *status*, enforced on the backend.
// Step 3 (Razorpay) will insert rows into `subscriptions` after a verified payment;
// nothing here fabricates a successful payment or unlocks Pro on its own.
const PLANS = {
  WEEKLY: { plan: 'WEEKLY', label: 'Weekly', price: 349, currency: '₹', days: 7, recommended: false,
    features: ['Unlimited AI chat', 'Unlimited color changes', 'Unlimited format/template changes', 'Unlimited content changes', 'ATS Compatibility Score', 'Job Description matching', 'AI resume optimization', 'Resume version history'] },
  MONTHLY: { plan: 'MONTHLY', label: 'Monthly', price: 549, currency: '₹', days: 30, recommended: true,
    features: ['Unlimited AI chat', 'Unlimited color changes', 'Unlimited format/template changes', 'Unlimited content changes', 'ATS Compatibility Score', 'Job Description matching', 'AI resume optimization', 'Resume version history'] },
};

async function freeTrialLimit() {
  const s = await db.getSettings();
  const n = parseInt(s.free_trial_edits, 10);
  return Number.isFinite(n) && n >= 0 ? n : 5;
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

// Subscription status in the database is the source of truth (Step 2, section 8) —
// not a date comparison invented at read time. Any ACTIVE row whose billing period
// has passed is flipped to EXPIRED here, lazily, the moment anything checks it. No
// cron needed: every call to getBillingStatus passes through this first.
async function expireIfDue(userId) {
  await db.run("UPDATE subscriptions SET status='EXPIRED' WHERE user_id=? AND status='ACTIVE' AND end_date<=?", [userId, Date.now()]);
}
async function activeSubscription(userId) {
  await expireIfDue(userId);
  return db.get("SELECT * FROM subscriptions WHERE user_id=? AND status='ACTIVE' AND end_date>? ORDER BY end_date DESC LIMIT 1", [userId, Date.now()]);
}

// Single source of truth for "what is this user allowed to do right now". Always
// re-derived from the database (subscription row + usage row) — never from
// anything the client sends, so the Free Trial can't be bypassed via the API.
// Falling back to FREE here never creates or resets a Free Trial (section 9):
// ensureUsageRow only ever INSERTs once per user, the first time they're seen, so
// a Free → Weekly → expired → Free user keeps whatever trial balance they had.
async function getBillingStatus(userId) {
  const sub = await activeSubscription(userId);
  if (sub) return { plan: sub.plan, status: 'ACTIVE', unlimited: true, trialEditsRemaining: null, trialComplete: false, maxResumes: null, endDate: sub.end_date };
  const usage = await ensureUsageRow(userId);
  const remaining = Math.max(0, usage.free_trial_edits);
  return { plan: 'FREE', status: 'ACTIVE', unlimited: false, trialEditsRemaining: remaining, trialComplete: remaining <= 0, maxResumes: 1, endDate: null };
}

// ---- Central feature matrix (Step 2, section 7) ----
// One function every endpoint calls — ai.js, the resume-creation route, and (if a
// Job Match API is ever added) that too — instead of each re-implementing its own
// idea of what Free vs. Weekly vs. Monthly can do.
const FEATURES = {
  AI_RESUME_EDIT: 'AI_RESUME_EDIT', COLOR_CHANGE: 'COLOR_CHANGE', FORMAT_CHANGE: 'FORMAT_CHANGE',
  CONTENT_EDIT: 'CONTENT_EDIT', ATS_SCORE: 'ATS_SCORE', JOB_MATCH: 'JOB_MATCH',
  JOB_OPTIMIZATION: 'JOB_OPTIMIZATION', RESUME_HISTORY: 'RESUME_HISTORY', MULTIPLE_RESUMES: 'MULTIPLE_RESUMES',
};
// Viewing your own data is never blocked, even with zero trial credits or an
// expired subscription (section 5: "remains able to view their resume history...").
const ALWAYS_ALLOWED = new Set([FEATURES.ATS_SCORE, FEATURES.RESUME_HISTORY]);
// Paid-plan-only, regardless of trial credits (section 6, section 7).
const PAID_ONLY = new Set([FEATURES.JOB_MATCH, FEATURES.JOB_OPTIMIZATION, FEATURES.MULTIPLE_RESUMES]);
// Allowed on Free only while trial credits remain; unlimited once on a paid plan.
const TRIAL_GATED = new Set([FEATURES.AI_RESUME_EDIT, FEATURES.COLOR_CHANGE, FEATURES.FORMAT_CHANGE, FEATURES.CONTENT_EDIT]);
// billingStatus comes from getBillingStatus() — never pass a client-supplied plan/flag in.
function canUseFeature(billingStatus, feature) {
  if (ALWAYS_ALLOWED.has(feature)) return { allowed: true };
  if (billingStatus.unlimited) return { allowed: true };
  if (PAID_ONLY.has(feature)) return { allowed: false, reason: 'locked_feature' };
  if (TRIAL_GATED.has(feature)) return billingStatus.trialEditsRemaining > 0 ? { allowed: true } : { allowed: false, reason: 'trial_complete' };
  return { allowed: false, reason: 'locked_feature' };
}

// Atomic + race-safe: only succeeds (affectedRows>0) if a credit was actually available.
async function consumeTrialEdit(userId) {
  const res = await db.run('UPDATE user_usage SET free_trial_edits=free_trial_edits-1, updated_at=? WHERE user_id=? AND free_trial_edits>0', [Date.now(), userId]);
  if (res.affectedRows > 0) {
    const row = await db.get('SELECT free_trial_edits FROM user_usage WHERE user_id=?', [userId]);
    if (row && row.free_trial_edits <= 0) await db.run('UPDATE user_usage SET free_trial_completed_at=? WHERE user_id=? AND free_trial_completed_at IS NULL', [Date.now(), userId]);
  }
  return res.affectedRows > 0;
}
// Used to roll back a credit when the AI call itself fails upstream (so a failed
// edit never costs the user part of their trial).
async function refundTrialEdit(userId) {
  await db.run('UPDATE user_usage SET free_trial_edits=free_trial_edits+1, free_trial_completed_at=NULL, updated_at=? WHERE user_id=?', [Date.now(), userId]);
}

// ---- Intent classification (Section 8 of the spec) ----
// Deterministic keyword rules, not an AI call — classification must be cheap and
// must happen before we decide whether an AI call (and a credit) is even allowed.
const COLOR_RE = /\b(colou?r|accent)\b/i;
const FORMAT_RE = /\b(template|format|layout)\b/i;
const JOBMATCH_RE = /\b(job description|job match|match(ing)? (this|my resume|it) (against|to|with)|compare .*(job|jd)\b|\bjd\b)/i;
const ADVANCED_RE = /\b(career strategy|career plan|which jobs?|job market|salary negotiation|interview prep|cover letter|linkedin strategy|job search strategy)\b/i;
const EDIT_VERB_RE = /\b(change|update|rewrite|improve|edit|fix|add|remove|delete|shorten|expand|rephrase|polish|optimi[sz]e|make|rewrite|tighten|strengthen|reword|convert)\b/i;
const CHAT_ONLY_RE = /^\s*(hi|hello|hey|thanks|thank you|ok|okay)\b/i;
const QUESTION_RE = /\b(what can you|what does|how does this work|what is|who are you|can you help|show me what)\b/i;

function classifyIntent(text) {
  const t = String(text || '').trim();
  if (!t) return 'GENERAL_CHAT';
  if (JOBMATCH_RE.test(t)) return 'JOB_MATCH';
  if (ADVANCED_RE.test(t)) return 'ADVANCED_FEATURE';
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

const GENERAL_CHAT_REPLY = 'Your Free Trial currently supports resume editing for color, format, and content changes. Upgrade to Pro for unlimited AI chat and advanced career features.';
const LOCKED_REPLY = 'That feature is part of Resume Desk Pro. Upgrade to unlock it.';

// Admin dashboard: one subscription row per user (most recent), plus usage/resume
// counts, for the Users table (section 11). Never includes secret payment data —
// subscription_id here is either our own "manual:<uuid>" or a future Razorpay id,
// both safe to show to the site's own admin.
async function subscriptionSummary(userId) {
  await expireIfDue(userId);
  return db.get('SELECT plan,status,start_date,end_date,subscription_id,subscription_source FROM subscriptions WHERE user_id=? ORDER BY id DESC LIMIT 1', [userId]);
}

module.exports = {
  PLANS, FEATURES, ALWAYS_ALLOWED, PAID_ONLY, TRIAL_GATED, canUseFeature,
  freeTrialLimit, ensureUsageRow, activeSubscription, subscriptionSummary, getBillingStatus,
  consumeTrialEdit, refundTrialEdit, classifyIntent, CREDIT_INTENTS, LOCKED_FOR_FREE,
  GENERAL_CHAT_REPLY, LOCKED_REPLY,
};
