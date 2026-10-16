const db = require('./db');

// ---- Plan-based resume-creation-limit billing model ----------------------------
// Replaces the old per-message AI-credit system. Ordinary AI-assisted resume
// editing (chat, color/format/content changes) is now free for every plan,
// subject only to the existing per-day quota in lib/ai.js (quotaFor) as a
// reasonable technical abuse-prevention limit — it is never presented to the
// user as "credits". What each plan actually buys is: (1) a number of NEW
// resumes you may create per billing period (lifetime 1 for Free), and (2)
// access to two specific paid features (Improve ATS Score, Job Description
// Match / tailoring). See canUseFeature() below for the single source of truth.
//
// Razorpay here is Standard Checkout (one-time order + client-side signature
// verification) — there is no Razorpay Subscriptions integration and no
// webhook endpoint in this codebase. "Renewal" is therefore implemented as the
// user manually repeating the same Checkout flow before/after their period
// ends, which inserts a fresh `subscriptions` row (= a fresh billing period
// with its own resume allowance). True automatic recurring auto-charge is NOT
// implemented — seeing new Razorpay Subscription plan/price IDs and a webhook
// secret would require configuration this change does not invent. This is a
// real, disclosed limitation, not an oversight (see the final report).
const PERIOD_DAYS = 30; // one purchase = one 30-day billing period, as of this change

const FEATURE_LIST = [
  'Resume creation allowance', 'Edit & download your resumes', 'Templates, colour & formatting',
  'AI-assisted resume editing', 'View ATS Compatibility score', 'Improve ATS Score',
  'Job Description Match', 'AI Job-Description-based tailoring',
];
const PLANS = {
  STARTER: { plan: 'STARTER', label: 'Starter', price: 99, currency: '₹', days: PERIOD_DAYS, resumeAllowance: 5, tier: 1, allowanceLabel: '5 new resumes / month',
    features: FEATURE_LIST, excluded: ['Improve ATS Score', 'Job Description Match', 'AI Job-Description-based tailoring'] },
  PRO: { plan: 'PRO', label: 'Pro', price: 199, currency: '₹', days: PERIOD_DAYS, resumeAllowance: 10, tier: 2, allowanceLabel: '10 new resumes / month', recommended: true,
    features: FEATURE_LIST, excluded: ['Job Description Match', 'AI Job-Description-based tailoring'] },
  CAREER_PRO: { plan: 'CAREER_PRO', label: 'Career Pro', price: 399, currency: '₹', days: PERIOD_DAYS, resumeAllowance: 20, tier: 3, allowanceLabel: '20 new resumes / month',
    features: FEATURE_LIST, excluded: [] },
  // Legacy plan code from before this change (one-time 50-credit pack). No longer
  // sold (not in the pricing page or the checkout plan list below) but existing
  // rows still carry this plan code, so it must keep resolving to a tier/allowance
  // for anyone who already bought it — treated as Career-Pro-equivalent, not
  // renamed in the database. See the migration backfill in lib/db.js.
  POWER: { plan: 'POWER', label: 'Power (legacy)', price: 499, currency: '₹', days: PERIOD_DAYS, resumeAllowance: 20, tier: 3, allowanceLabel: '20 new resumes / month',
    features: FEATURE_LIST, excluded: [], legacy: true },
};
// Only these are offered on the pricing page / checkout going forward.
const SELLABLE_PLANS = ['STARTER', 'PRO', 'CAREER_PRO'];
const PLAN_TIER = { FREE: 0, STARTER: 1, PRO: 2, CAREER_PRO: 3, POWER: 3 };
function planTierOf(plan) { return PLAN_TIER[plan] != null ? PLAN_TIER[plan] : 0; }

async function ensureUsageRow(userId) {
  let row = await db.get('SELECT * FROM user_usage WHERE user_id=?', [userId]);
  if (!row) {
    const now = Date.now();
    try {
      await db.run('INSERT INTO user_usage(user_id,free_trial_edits,free_trial_started_at,free_trial_completed_at,updated_at,resumes_created) VALUES(?,?,?,?,?,0)',
        [userId, 0, now, null, now]);
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

// Single source of truth for "what is this user allowed to do right now". Always
// re-derived from the database (subscription row + usage row) — never from
// anything the client sends. A FREE user's resumes_created lives on their
// (lazily-created) user_usage row and is a LIFETIME counter, never reset.
async function getBillingStatus(userId) {
  const sub = await activeSubscription(userId);
  if (sub) {
    const allocated = sub.resumes_allocated || 0;
    const used = sub.resumes_created || 0;
    return {
      plan: sub.plan, status: 'ACTIVE', isPaid: true, planTier: planTierOf(sub.plan),
      resumesAllocated: allocated, resumesUsed: used, resumesRemaining: Math.max(0, allocated - used),
      periodStart: sub.start_date, periodEnd: sub.end_date, endDate: sub.end_date,
    };
  }
  const usage = await ensureUsageRow(userId);
  const used = usage.resumes_created || 0;
  return {
    plan: 'FREE', status: 'ACTIVE', isPaid: false, planTier: 0,
    resumesAllocated: 1, resumesUsed: used, resumesRemaining: Math.max(0, 1 - used),
    periodStart: null, periodEnd: null, endDate: null,
  };
}

// ---- Central feature matrix ----
// One function every endpoint calls — ai.js, the resume-creation/save routes, and
// the client-side ATS-improve/Job-Match gate checks — instead of each endpoint
// re-implementing its own idea of what Free/Starter/Pro/Career Pro can do.
const FEATURES = {
  RESUME_CREATE: 'RESUME_CREATE',   // creating/saving a genuinely new (non-empty) resume
  RESUME_HISTORY: 'RESUME_HISTORY', // viewing your own resumes/account — never blocked
  AI_EDIT: 'AI_EDIT',               // ordinary AI-assisted chat/color/format/content edits
  ATS_SCORE: 'ATS_SCORE',           // viewing the ATS Compatibility score/diagnostics
  ATS_IMPROVE: 'ATS_IMPROVE',       // the "Improve ATS Score" AI rewrite — Pro & Career Pro only
  JOB_MATCH: 'JOB_MATCH',           // Job Description Match scoring — Career Pro only
  JOB_TAILOR: 'JOB_TAILOR',         // AI resume rewrite against a JD — Career Pro only
};
// Viewing your own data, ordinary AI editing, and the ATS score are never gated by
// plan or by any counter — every plan (including a Free user who has used their
// one lifetime resume) keeps these for their existing resume(s).
const ALWAYS_ALLOWED = new Set([FEATURES.RESUME_HISTORY, FEATURES.AI_EDIT, FEATURES.ATS_SCORE]);
// Needs plan tier >= this to use the feature at all. Not present here = not tier-gated.
const TIER_REQUIRED = { [FEATURES.ATS_IMPROVE]: 2, [FEATURES.JOB_MATCH]: 3, [FEATURES.JOB_TAILOR]: 3 };

// billingStatus comes from getBillingStatus() — never pass a client-supplied plan/flag in.
// A billingStatus with `unlimited: true` (the admin shortcut) always passes.
function canUseFeature(billingStatus, feature) {
  if (billingStatus.unlimited) return { allowed: true };
  if (ALWAYS_ALLOWED.has(feature)) return { allowed: true };
  if (feature === FEATURES.RESUME_CREATE) {
    return (billingStatus.resumesRemaining || 0) > 0
      ? { allowed: true }
      : { allowed: false, reason: billingStatus.isPaid ? 'resume_limit_reached' : 'FREE_LIMIT_REACHED' };
  }
  const need = TIER_REQUIRED[feature];
  if (need != null) {
    return (billingStatus.planTier || 0) >= need ? { allowed: true } : { allowed: false, reason: 'locked_feature' };
  }
  return { allowed: false, reason: 'locked_feature' };
}

// ---- Atomic, race-safe resume-slot reservation ----
// Mirrors the UPDATE-...-WHERE-guard pattern this codebase already used for its old
// credit system: the UPDATE's WHERE clause only matches (and only then increments)
// while a slot is actually available, so two concurrent requests can never both
// succeed past the real limit — there is no separate "check, then write" race.
// Called BEFORE the resume content is actually written; releaseResumeSlot() rolls
// the reservation back if the write that follows fails for any reason, so a failed
// save never costs the user a slot.
async function reserveResumeSlot(userId) {
  const sub = await activeSubscription(userId);
  if (sub) {
    const allocated = sub.resumes_allocated || 0;
    const res = await db.run('UPDATE subscriptions SET resumes_created=resumes_created+1 WHERE id=? AND resumes_created<?', [sub.id, allocated]);
    return res.affectedRows > 0 ? { ok: true, scope: 'subscription', id: sub.id } : { ok: false };
  }
  const res = await db.run('UPDATE user_usage SET resumes_created=resumes_created+1, updated_at=? WHERE user_id=? AND resumes_created<1', [Date.now(), userId]);
  return res.affectedRows > 0 ? { ok: true, scope: 'lifetime', userId } : { ok: false };
}
async function releaseResumeSlot(userId, reservation) {
  if (!reservation || !reservation.ok) return;
  if (reservation.scope === 'subscription') await db.run('UPDATE subscriptions SET resumes_created=GREATEST(0,resumes_created-1) WHERE id=?', [reservation.id]);
  else await db.run('UPDATE user_usage SET resumes_created=GREATEST(0,resumes_created-1), updated_at=? WHERE user_id=?', [Date.now(), userId]);
}

// Best-effort mirror of the client's isEmpty(resume) check (public/app.html), used
// server-side to decide whether a save is the kind that consumes a resume slot —
// "a resume counts only once it holds real saved content", never on creating an
// empty placeholder. Deliberately lenient/defensive against missing/odd-shaped
// fields: worst case this is off by one edge case in WHEN a slot is taken, never a
// way to dodge the limit, since the real gate is the atomic counter above, checked
// on every save regardless of what this function decides.
function resumeContentNonEmpty(r) {
  if (!r || typeof r !== 'object') return false;
  const hasText = v => typeof v === 'string' && v.trim().length > 0;
  const hasItems = v => Array.isArray(v) && v.length > 0;
  if (hasText(r.name) || hasText(r.summary) || hasText(r.headline)) return true;
  if (hasItems(r.skills) || hasItems(r.experience) || hasItems(r.projects) || hasItems(r.education) || hasItems(r.certifications) || hasItems(r.achievements) || hasItems(r.extra)) return true;
  if (r.contact && typeof r.contact === 'object' && (hasText(r.contact.email) || hasText(r.contact.phone))) return true;
  return false;
}

// ---- Intent classification (unchanged from the Free-Trial-era fixes) ----
// Still used to route a chat message to the right feature check (JOB_MATCH /
// JOB_TAILOR need a plan check; everything else is just AI_EDIT, always allowed).
// Deterministic keyword rules, not an AI call.
const COLOR_RE = /\b(colou?r|accent)\b/i;
const FORMAT_RE = /\b(template|format|layout)\b/i;
// A bare "jd" is too ambiguous to classify on its own — it collides with real resume
// content such as a company name ("JD Edwards", "JD Sports") or initials. Only treat it
// as a Job Description Match request when it appears together with "match" (either order,
// within a short span), on top of the existing explicit phrasings.
const JOBMATCH_RE = /\b(job description|job match|match(ing)? (this|my resume|it) (against|to|with)|compare .*(job|jd)\b|\bmatch\b[^.?!\n]{0,40}\bjd\b|\bjd\b[^.?!\n]{0,40}\bmatch\b)/i;
const ADVANCED_RE = /\b(career strategy|career plan|which jobs?|job market|salary negotiation|interview prep|cover letter|linkedin strategy|job search strategy)\b/i;
// ADVANCED_RE's phrases ("career plan", "which job", "job market") double as perfectly
// ordinary autobiographical content (e.g. a career-objective answer: "My career plan is to
// become a senior data scientist"). Only classify as ADVANCED_FEATURE when the message
// also reads as a request for advice/help, or is short enough to plausibly be one.
const ADVANCED_REQUEST_RE = /\b(help|advice|tips|can you|could you|give me|suggest|guidance|please)\b/i;
const EDIT_VERB_RE = /\b(change|update|rewrite|improve|edit|fix|add|remove|delete|shorten|expand|rephrase|polish|optimi[sz]e|make|rewrite|tighten|strengthen|reword|convert)\b/i;
const CHAT_ONLY_RE = /^\s*(hi|hello|hey|thanks|thank you|ok|okay)\b/i;
const QUESTION_RE = /\b(what can you|what does|how does this work|what is|who are you|can you help|show me what)\b/i;
// Pure advice/explanation (no resume change), e.g. "how can I improve my summary" or
// "why is my resume score low" — not a resume edit, but still ordinary AI_EDIT access.
const ADVICE_ONLY_RE = /^\s*(why|how can i|how do i|what should i|any (tips|advice)|can you (explain|suggest))\b.*\?\s*$/i;
// "undo"/"revert"/"put it back" use the existing Resume History mechanism, not a new
// AI call. Gated to short messages only: a real undo command is short ("undo",
// "revert my last change"), while these same words also show up incidentally in
// genuine resume content ("built an undo feature", "had to revert a bad deployment",
// "decided to go back and finish my degree") — those must still reach the AI as real
// content, not be swallowed by the Undo shortcut.
const UNDO_RE = /\b(undo|revert|put it back|restore (the|my) (last|previous)|go back)\b/i;

function classifyIntent(text) {
  const t = String(text || '').trim();
  if (!t) return 'GENERAL_CHAT';
  if (UNDO_RE.test(t) && t.split(/\s+/).length <= 8) return 'UNDO';
  if (JOBMATCH_RE.test(t)) return 'JOB_MATCH';
  if (ADVANCED_RE.test(t) && (ADVANCED_REQUEST_RE.test(t) || t.split(/\s+/).length <= 8)) return 'ADVANCED_FEATURE';
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

const LOCKED_REPLY = 'That feature is part of a higher ITC Resume plan. Upgrade to unlock it.';
const RESUME_LIMIT_REPLY_PAID = "You've used all of your resume creations for this billing period. Upgrade for a higher plan, or wait for your next renewal — editing and downloading your existing resumes still works.";
const RESUME_LIMIT_REPLY_FREE = 'Your Free plan includes one resume. Upgrade to create another — you can keep editing and downloading your current one.';

// Admin dashboard: one subscription row per user (most recent), plus usage/resume
// counts, for the Users table. Never includes secret payment data — subscription_id
// here is either our own "manual:<uuid>" or a Razorpay payment id, both safe to show
// to the site's own admin.
async function subscriptionSummary(userId) {
  await expireIfDue(userId);
  return db.get('SELECT plan,status,start_date,end_date,subscription_id,subscription_source,resumes_allocated,resumes_created FROM subscriptions WHERE user_id=? ORDER BY id DESC LIMIT 1', [userId]);
}

module.exports = {
  PLANS, SELLABLE_PLANS, FEATURES, ALWAYS_ALLOWED, TIER_REQUIRED, PLAN_TIER, planTierOf,
  canUseFeature, ensureUsageRow, activeSubscription, subscriptionSummary, getBillingStatus,
  reserveResumeSlot, releaseResumeSlot, resumeContentNonEmpty,
  classifyIntent, LOCKED_REPLY, RESUME_LIMIT_REPLY_PAID, RESUME_LIMIT_REPLY_FREE,
};
