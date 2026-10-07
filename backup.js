// Usage: npm run backup   -> writes backups/resumedesk-YYYY-MM-DD-HHMM.sql via mysqldump
// Needs the `mysqldump` client installed (already present on the Docker image and most Linux distros: `apt install mysql-client` or `mariadb-client`).
const path = require('path'), fs = require('fs'), { spawnSync } = require('child_process');
const dir = process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups');
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/(\d{8})(\d{4})/, '$1-$2');
const file = path.join(dir, 'resumedesk-' + stamp + '.sql');
const args = ['-h', process.env.DB_HOST || '127.0.0.1', '-P', process.env.DB_PORT || '3306', '-u', process.env.DB_USER || 'root', '--single-transaction', '--routines', '--triggers', process.env.DB_NAME || 'resumedesk'];
const env = { ...process.env }; if (process.env.DB_PASSWORD) env.MYSQL_PWD = process.env.DB_PASSWORD;
const out = fs.openSync(file, 'w');
const dumpBin = spawnSync('which', ['mysqldump']).status === 0 ? 'mysqldump' : 'mariadb-dump';
const r = spawnSync(dumpBin, args, { stdio: ['ignore', out, 'pipe'], env });
fs.closeSync(out);
if (r.status !== 0) { fs.unlinkSync(file); console.error((r.stderr || '').toString() || 'Backup failed. Is mysqldump/mariadb-dump installed?'); process.exit(1); }
console.log('Backup written: ' + file);
const keep = parseInt(process.env.BACKUP_KEEP || '14', 10);
const all = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
all.slice(0, Math.max(0, all.length - keep)).forEach(f => fs.unlinkSync(path.join(dir, f)));
