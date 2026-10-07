// Usage: npm run create-admin -- you@example.com "StrongPassword"
// Creates an admin, or promotes/resets the password of an existing user.
const db = require('../lib/db'); const A = require('../lib/auth');
(async () => {
  const email = A.normEmail(process.argv[2]), pw = process.argv[3];
  if (!A.validEmail(email) || !pw || pw.length < 8) { console.error('Usage: npm run create-admin -- you@example.com "password-8+chars"'); process.exit(1); }
  await db.ready();
  const hash = await A.hashPassword(pw), now = Date.now();
  const exists = await db.get('SELECT 1 x FROM users WHERE email=?', [email]);
  if (exists) await db.run("UPDATE users SET pass_hash=?, role='admin', status='active', must_change=0 WHERE email=?", [hash, email]);
  else await db.run("INSERT INTO users(email,name,pass_hash,role,created_at,consent_at) VALUES(?,?,?, 'admin', ?, ?)", [email, 'Admin', hash, now, now]);
  await db.audit(null, 'admin.cli', email); console.log('Admin ready: ' + email);
  await db.pool.end();
})().catch(e => { console.error(e); process.exit(1); });
