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
  created_at BIGINT NOT NULL,
  KEY subs_user (user_id, status, end_date),
  CONSTRAINT fk_subs_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
// Covers a `subscriptions` table that already exists from an earlier deploy, before
// this column existed. IF NOT EXISTS makes it safe to run on every boot.
`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS subscription_source VARCHAR(20) NOT NULL DEFAULT 'MANUAL'`,
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

let readyPromise = null;
// Runs once per process: creates tables if missing. Safe to call many times (IF NOT EXISTS).
function ready() {
  if (!readyPromise) {
    readyPromise = (async () => {
      const conn = await pool.getConnection();
      try { for (const sql of SCHEMA_SQL) await conn.query(sql); }
      finally { conn.release(); }
    })();
  }
  return readyPromise;
}

// Thin query helpers so the rest of the app reads like simple SQL calls.
async function all(sql, params) { await ready(); const [rows] = await pool.query(sql, params); return rows; }
async function get(sql, params) { const rows = await all(sql, params); return rows[0]; }
async function run(sql, params) { await ready(); const [res] = await pool.query(sql, params); return { insertId: res.insertId, affectedRows: res.affectedRows }; }

const DEFAULTS = { signups_open: '1', default_daily_limit: '30', global_daily_cap: '2000', max_resumes: '15', price_in: '', price_out: '', currency: '$', announcement: '', free_trial_edits: '5' };
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
