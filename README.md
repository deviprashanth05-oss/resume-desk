# Resume Desk Pro: login, saved resumes, admin dashboard (MySQL)

Ungal sondha server-la host pannalam. Users sign up panni login pannalam, avanga resumes **MySQL database**-la save aagum, neenga (admin) `/admin` dashboard-la users, usage, limits ellam manage pannalam.

## Enna enna irukku

| Feature | Details |
|---|---|
| Login / sign up | Email + password. Password hash-a store aagum (scrypt), yaarum padikka mudiyaadhu. Session cookie HttpOnly. |
| Saved resumes | Ovvoru user-ku 15 resumes varaikkum (admin maathalaam). Auto-save. Device maathinaalum same resumes varum. |
| AI (Claude) | Server-la irundhu Claude-ai call pannum. API key browser-ku pogaadhu. Login pannavanga mattum use pannalam. |
| Limits | Oru user-ku oru naal-ku evlo AI edits (default 30), motha site-ku daily cap. Admin maathalaam. |
| Admin dashboard | `/admin`. Users list, search, disable / enable, make admin, reset password, per-user limit, delete user, usage chart, token and cost estimate, audit log. Admins-ku mattum. |
| User privacy | Users own data export (JSON) pannalam, account delete pannalam. Admin dashboard-la resume content theriyaadhu (counts and usage mattum). |
| Security | Rate limiting, login lockout, CSRF protection, security headers, admin actions audit log. |

## Requirements

- Oru Linux server (VPS: DigitalOcean, Hetzner, AWS Lightsail, etc.) with 1.5 GB RAM or more (MySQL-um app-um sethu run aagum).
- MySQL 8 database. `docker compose` use pannina, idhu automatic-a container-a varum — vera onnum install pannavendam. Vera vazhi host pannina (Option B), ungal own MySQL server or a managed database (AWS RDS, PlanetScale, DigitalOcean Managed MySQL) venum.
- Oru domain name (example: `resume.yourdomain.com`). DNS **A record** andha server IP-ku point pannunga.
- Anthropic API key (console.anthropic.com). Console-la **monthly spend limit** set pannunga.

> **Veetla / office-la irukkura computer-la host panna mudiyuma?** Mudiyum, aana public IP, router port forwarding (80, 443), 24x7 power and internet venum. Adhu easy-illa. Easy-a irukka **Cloudflare Tunnel** use pannalaam (free), illa small VPS vaanguradhu better.

## Option A: Docker (recommended, HTTPS-um automatic)

Server-la (Ubuntu example):

```bash
# 1. Docker install
curl -fsSL https://get.docker.com | sh

# 2. Indha folder-a server-ku copy pannunga (scp / git), appuram:
cd resume-desk-pro
cp .env.example .env
nano .env        # ANTHROPIC_API_KEY, DOMAIN, ADMIN_EMAIL, ADMIN_PASSWORD, SUPPORT_EMAIL fill pannunga

# 3. Start
docker compose up -d --build
```

1-2 nimisham-la `https://ungal-domain` open pannunga. Caddy automatic-a free HTTPS certificate edukkum (DNS correct-a irundha mattum). First start-la `mysql` container-a app wait pannum (healthcheck), so first boot konjam extra seconds edukkum — normal dhaan.

**Mukkiyam:** First start aana piragu `.env`-la irundhu `ADMIN_PASSWORD` line-a delete pannunga, appuram `docker compose up -d` again.

Admin-a login pannunga. Menu-la (top right avatar) **Admin dashboard** link varum.

Firewall:

```bash
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw enable
```

### Update pannradhu

```bash
docker compose up -d --build
```
Data `appdata` volume-la irukkum, update-la azhiyaadhu.

## Option B: Docker illaama (Node + nginx)

1. Node 20 or above install pannunga.
2. MySQL 8 (or MariaDB 10.6+) install pannunga, database and user create pannunga:
   ```sql
   CREATE DATABASE resumedesk CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   CREATE USER 'resumedesk'@'localhost' IDENTIFIED BY 'a-strong-password';
   GRANT ALL PRIVILEGES ON resumedesk.* TO 'resumedesk'@'localhost';
   ```
3. `npm ci --omit=dev`
4. Environment variables set panni run: `ANTHROPIC_API_KEY=... DB_HOST=127.0.0.1 DB_USER=resumedesk DB_PASSWORD=... DB_NAME=resumedesk ADMIN_EMAIL=... ADMIN_PASSWORD=... npm start` (tables automatic-a create aagum, first run-lae)
5. `pm2` illa `systemd` vachu 24x7 run pannunga.
5. nginx-la reverse proxy + HTTPS (certbot):

```nginx
server {
  server_name resume.yourdomain.com;
  client_max_body_size 10m;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;          # AI reply stream aaga idhu venum
    proxy_read_timeout 120s;
  }
}
```

## Admin create / password maathanum-naa

```bash
# Docker:
docker compose exec app npm run create-admin -- you@example.com "NewStrongPassword"
# Docker illaama:
npm run create-admin -- you@example.com "NewStrongPassword"
```
Existing user-a admin-a aakkum, password-um reset aagum.

## Backups (romba mukkiyam)

`npm run backup` `mysqldump` use panni oru `.sql` file create pannum (`backups/` folder-la, last 14 vachukkum):

```bash
docker compose exec app npm run backup
docker compose cp app:/app/backups ./backups      # server-ku veliya copy
```
Restore panna: `docker compose exec -T mysql mysql -u root -p$MYSQL_ROOT_PASSWORD resumedesk < backups/resumedesk-....sql`

Cron-la daily podalaam, appuram andha `backups` folder-a vera idathuku (S3, Google Drive, vera server) copy pannunga. Server disk poyidhuchunaa backup dhaan kaapathum. (MySQL data itself `dbdata` Docker volume-la irukku — `.sql` backup dhaan portable-a vera server-ku edukka easy.)

## Daily AI limit epdi work aagum

`APP_TZ` (default `Asia/Kolkata`) time zone-la nadu raatri limit reset aagum. Admin dashboard → **Settings**-la default limit, whole-site cap, max resumes maathalaam. Oru specific user-ku special limit venumna **Users** → andha user click → **Daily AI limit**.

## Cost estimate

Settings-la Anthropic pricing page-la irukkura input / output price per 1M tokens type pannunga. Overview-la "Estimated AI cost" kaattum. Idhu estimate dhaan, actual bill Anthropic Console-la paarunga.

## Launch-ku munnaadi checklist

- [ ] HTTPS work aagudha (padlock icon)
- [ ] `.env`-la `ADMIN_PASSWORD` delete pannitteengala, `.env` file GitHub-la podala-nu confirm
- [ ] Anthropic Console-la monthly spend limit
- [ ] Daily backup + oru thadava restore panni test
- [ ] `public/privacy.html` and `public/terms.html` padichu ungal service-ku sariya maathunga. **Idhu template dhaan, vakeel-a review pannunga.** India-la irundhu users data store pannuradhala Digital Personal Data Protection (DPDP) rules-um paarunga.
- [ ] 3-4 real resumes (PDF, Word, photo) upload panni test pannunga
- [ ] Server-a regular-a update pannunga (`apt upgrade`), Docker images-um

## Theriyanum (limitations)

- **Single MySQL server.** Perusaa growth-na (many thousand users) MySQL replica or managed DB (RDS) use pannunga — code maatha vendam, connection details mattum maathina podhum.
- **Email verification, "Forgot password" email illa.** Password marandhaa user admin-a kekkanum, admin **Reset password** click pannina temporary password kedaikkum (user next login-la new password set pannanum). Later SMTP add pannalaam.
- **Single server + SQLite.** Aayiram users varaikkum nallaa work aagum. Perusaa growth-na Postgres-ku maathanum.
- **Admin resume content paaka mudiyaadhu** (purposely). Support-ku venumna adhu privacy policy-la sollitu add pannunga.
- Sign up spam-ku basic rate limit mattum irukku. Public-a bots varaa Cloudflare Turnstile / CAPTCHA add pannunga.
- Payment, paid plans illa. Later venumna Razorpay / Stripe add pannalaam.

## Folder guide

```
server.js            main server (routes)
lib/db.js            database tables, settings
lib/auth.js          passwords, sessions, rate limiter
lib/ai.js            Claude proxy, per-user quota, usage logging
lib/admin.js         admin API
scripts/             create-admin, backup
public/              login.html, app.html, admin.html, privacy.html, terms.html
Dockerfile, docker-compose.yml, Caddyfile, .env.example
```
Page-a maathanumna `public/*.html` files-a directly edit pannalaam (restart vendam, refresh pothum).
