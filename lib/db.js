const mysql = require('mysql2/promise');

const TZ = process.env.APP_TZ || 'Asia/Kolkata';
// Aiven (and most managed MySQL hosts) require TLS. Paste the CA certificate's
// full PEM text into DB_SSL_CA (Vercel env vars support multi-line values).
// If you don't have the CA handy, set DB_SSL=require instead (less strict, still encrypted).
let ssl;
if (process.env.DB_SSL_CA) ssl = { ca: process.env.DB_SSL_CA, rejectUnauthorized: true };
else if (process.env.DB_SSL === 'require') ssl = { rejectUnauthorized: false };
const cfg = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'resumedesk',
  waitForConnections: true,
  // Serverless functions run many short-lived instances, so keep the pool small per instance.
  connectionLimit: parseInt(process.env.DB_POOL_SIZE || '3', 10),
  maxIdle: 3,
  idleTimeout: 60000,
  charset: 'utf8mb4_unicode_ci',
  dateStrings: false,
  decimalNumbers: true,
  ...(ssl ? { ssl } : {}),
};
const pool = mysql.createPool(cfg);

const SCHEMA_SQL = [
`CREATE TABLE IF NOT EXISTS users(
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(254) NOT NULL,
  name VARCHAR(80) NOT NULL DEFAULT '',
  pass_hash VARCHAR(255) NOT NULL,
  role VARCHAR(10) NOT NULL DEFAULT 'user',
  status VARCHAR(10) NOT NULL DEFAULT 'active',
  daily_limit INT NULL,
  must_change TINYINT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  last_login BIGINT NULL,
  last_seen BIGINT NULL,
  consent_at BIGINT NULL,
  UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
`CREATE TABLE IF NOT EXISTS sessions(
  id_hash CHAR(64) PRIMARY KEY,
  user_id INT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  last_seen BIGINT NOT NULL,
  ip VARCHAR(64), ua VARCHAR(200),
  KEY sessions_user (user_id),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
`CREATE TABLE IF NOT EXISTS resumes(
  id CHAR(36) PRIMARY KEY,
  user_id INT NOT NULL,
  title VARCHAR(80) NOT NULL DEFAULT 'Untitled resume',
  data LONGTEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  KEY resumes_user (user_id, updated_at),
  CONSTRAINT fk_resumes_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
`CREATE TABLE IF NOT EXISTS ai_usage(
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NULL,
  ts BIGINT NOT NULL,
  day CHAR(10) NOT NULL,
  kind VARCHAR(20) NOT NULL DEFAULT 'chat',
  input_tokens INT NOT NULL DEFAULT 0,
  output_tokens INT NOT NULL DEFAULT 0,
  ok TINYINT NOT NULL DEFAULT 0,
  ms INT NOT NULL DEFAULT 0,
  KEY usage_day (day),
  KEY usage_user_day (user_id, day),
  CONSTRAINT fk_usage_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
`CREATE TABLE IF NOT EXISTS settings(
  \`key\` VARCHAR(64) PRIMARY KEY,
  value TEXT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
// Free Trial usage tracking. One row per user; created on first use (see lib/billing.js).
`CREATE TABLE IF NOT EXISTS user_usage(
  user_id INT PRIMARY KEY,
  free_trial_edits INT NOT NULL DEFAULT 0,
  free_trial_started_at BIGINT NULL,
  free_trial_completed_at BIGINT NULL,
  updated_at BIGINT NOT NULL,
  CONSTRAINT fk_usage2_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
// Weekly/Monthly subscriptions. Razorpay (Step 3) will insert/update rows here;
// for now rows are only ever created by an admin (see lib/billing.js / admin tools).
`CREATE TABLE IF NOT EXISTS subscriptions(
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  plan VARCHAR(10) NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'ACTIVE',
  start_date BIGINT NOT NULL,
  end_date BIGINT NOT NULL,
  subscription_id VARCHAR(100) NULL,
  subscription_source VARCHAR(20) NOT NULL DEFAULT 'MANUAL',
  credits_allocated INT NOT NULL DEFAULT 0,
  credits_used INT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  KEY subs_user (user_id, status, end_date),
  CONSTRAINT fk_subs_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
`CREATE TABLE IF NOT EXISTS audit(
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  ts BIGINT NOT NULL,
  admin_id INT NULL,
  admin_email VARCHAR(254),
  action VARCHAR(60) NOT NULL,
  target VARCHAR(300),
  detail VARCHAR(300)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
];

// Adds a column to an already-existing table, but only if it's not already there.
// Some managed MySQL builds (e.g. Aiven) reject "ADD COLUMN IF NOT EXISTS" as a
// syntax error, so this checks information_schema first instead of relying on that.
async function addColumnIfMissing(conn, table, column, definition) {
  const [rows] = await conn.query(
    'SELECT COUNT(*) AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?',
    [table, column]
  );
  if (rows[0].c === 0) await conn.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
// Same idea as addColumnIfMissing, for an index/unique key. Needed for the
// resumes.client_request_id idempotency key (see ready(), below) — added the same
// backward-compatible way, never assumed to already exist.
async function addIndexIfMissing(conn, table, indexName, definitionSql) {
  const [rows] = await conn.query(
    'SELECT COUNT(*) AS c FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?',
    [table, indexName]
  );
  if (rows[0].c === 0) await conn.query(`ALTER TABLE ${table} ADD ${definitionSql}`);
}

// A free-tier database (or any host) can take a moment to wake up from an idle
// power-off, so a single failed connection attempt during that window shouldn't be
// treated as a permanent failure. A couple of short retries absorb that without
// meaningfully slowing down the common case where the connection just works.
async function getConnectionWithRetry(retries = 2, delayMs = 500) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try { return await pool.getConnection(); }
    catch (e) { lastErr = e; if (i < retries) await new Promise(r => setTimeout(r, delayMs * (i + 1))); }
  }
  throw lastErr;
}

let readyPromise = null;
// Runs once per process: creates tables if missing. Safe to call many times (IF NOT EXISTS).
// If it fails (e.g. the database was briefly unreachable), the cached promise is cleared
// so the very next call retries from scratch instead of every future request on this
// warm instance being stuck replaying the same failure forever.
function ready() {
  if (!readyPromise) {
    readyPromise = (async () => {
      const conn = await getConnectionWithRetry();
      try {
        for (const sql of SCHEMA_SQL) await conn.query(sql);
        await addColumnIfMissing(conn, 'subscriptions', 'subscription_source', "VARCHAR(20) NOT NULL DEFAULT 'MANUAL'");
        await addColumnIfMissing(conn, 'subscriptions', 'credits_allocated', 'INT NOT NULL DEFAULT 0');
        await addColumnIfMissing(conn, 'subscriptions', 'credits_used', 'INT NOT NULL DEFAULT 0');
        // ---- Resume-creation-limit billing model (replaces per-message credits for
        // ordinary editing; see lib/billing.js). All additive, nothing destructive —
        // the credits_* columns above are left in place for backward compatibility
        // and are still written to (but no longer enforced against) by lib/ai.js.
        // Free users: lifetime "has this account ever created a real resume" counter.
        await addColumnIfMissing(conn, 'user_usage', 'resumes_created', 'INT NOT NULL DEFAULT 0');
        // Paid subscribers: each subscriptions row is one billing period, with its own
        // allowance (set from the plan at purchase/grant time) and its own atomic counter.
        await addColumnIfMissing(conn, 'subscriptions', 'resumes_allocated', 'INT NOT NULL DEFAULT 0');
        await addColumnIfMissing(conn, 'subscriptions', 'resumes_created', 'INT NOT NULL DEFAULT 0');
        // A resume only ever consumes a slot once, the first time it holds real saved
        // content (never on creation of an empty placeholder) — this flag remembers
        // that it already has, so later edits never re-consume one.
        await addColumnIfMissing(conn, 'resumes', 'counted', 'TINYINT NOT NULL DEFAULT 0');
        // Client-generated idempotency key for resume-creation requests, so a retried
        // or double-submitted request can't create a duplicate resume or consume a
        // second slot. NULL for pre-existing rows and for ordinary placeholder creates
        // that don't send one — MySQL's UNIQUE allows any number of NULLs, so that's safe.
        await addColumnIfMissing(conn, 'resumes', 'client_request_id', 'VARCHAR(64) NULL');
        await addIndexIfMissing(conn, 'resumes', 'uq_resumes_user_reqid', 'UNIQUE KEY uq_resumes_user_reqid (user_id, client_request_id)');
        // One-time safety backfill: pre-existing ACTIVE subscriptions bought under the
        // old one-time-credit-pack model have resumes_allocated=0 by default, which
        // would instantly lock legacy paid subscribers out of creating any new resume
        // under the new model. Back-fill their allowance from the NEW plan's resume
        // allowance (never from credits), once, only for rows that have never had an
        // allowance set — this never reduces anyone's entitlement and is never re-run
        // against a row it has already touched (resumes_allocated>0 or resumes_created>0
        // skips it). Legacy POWER subscribers are treated as Career-Pro-equivalent (see
        // lib/billing.js PLAN_TIER) for continuity, without renaming their plan column.
        const LEGACY_BACKFILL_ALLOWANCE = { STARTER: 5, PRO: 10, POWER: 20, CAREER_PRO: 20 };
        for (const [plan, allowance] of Object.entries(LEGACY_BACKFILL_ALLOWANCE)) {
          await conn.query(
            "UPDATE subscriptions SET resumes_allocated=? WHERE plan=? AND status='ACTIVE' AND resumes_allocated=0 AND resumes_created=0",
            [allowance, plan]
          );
        }
      } finally { conn.release(); }
    })();
    readyPromise.catch(() => { readyPromise = null; });
  }
  return readyPromise;
}

// Thin query helpers so the rest of the app reads like simple SQL calls.
async function all(sql, params) { await ready(); const [rows] = await pool.query(sql, params); return rows; }
async function get(sql, params) { const rows = await all(sql, params); return rows[0]; }
async function run(sql, params) { await ready(); const [res] = await pool.query(sql, params); return { insertId: res.insertId, affectedRows: res.affectedRows }; }

const DEFAULTS = { signups_open: '1', default_daily_limit: '30', global_daily_cap: '2000', max_resumes: '15', price_in: '', price_out: '', currency: '$', announcement: '', free_trial_edits: '3' };
async function getSettings() {
  const out = Object.assign({}, DEFAULTS);
  for (const r of await all('SELECT `key`, value FROM settings')) if (r.key in DEFAULTS) out[r.key] = r.value;
  return out;
}
async function setSetting(k, v) {
  await run('INSERT INTO settings(`key`,value) VALUES(?,?) ON DUPLICATE KEY UPDATE value=VALUES(value)', [k, String(v)]);
}
const dayKey = (ts) => new Date(ts == null ? Date.now() : ts).toLocaleDateString('en-CA', { timeZone: TZ });
async function audit(admin, action, target, detail) {
  await run('INSERT INTO audit(ts,admin_id,admin_email,action,target,detail) VALUES(?,?,?,?,?,?)',
    [Date.now(), admin ? admin.id : null, admin ? admin.email : 'system', action, target == null ? null : String(target), detail == null ? null : String(detail).slice(0, 300)]);
}
async function healthCheck() { await pool.query('SELECT 1'); }

module.exports = { pool, all, get, run, ready, getSettings, setSetting, dayKey, audit, healthCheck, TZ };
