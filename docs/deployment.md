# Deployment Guide — PetabyteAi

> วิธี deploy ตัว app ไปยัง server เครื่องอื่น (production / staging / tester box)
> _Updated: 2026-05-15 · Phase 20.2_

---

## 🎯 ตัดสินใจก่อน 3 ข้อ

ก่อนทำอะไรต้องเคลียร์ 3 คำถามนี้ก่อน:

### 1. App กับ DB อยู่เครื่องเดียวกันหรือคนละเครื่อง?

| รูปแบบ | เหมาะกับ |
|--------|---------|
| **A: เครื่องเดียว** (app + Postgres ใน server เดียว) | Demo, tester, ทีมเล็ก |
| **B: แยก 2 เครื่อง** (app เครื่องหนึ่ง, DB เครื่องหนึ่ง) | Production, ใช้ DB ที่มีอยู่แล้ว |

> ตอนนี้พี่มี DB ที่ `<DB_HOST>` แล้ว → ถ้า deploy app ไปที่อื่นและ connect กลับมา = แบบ B

### 2. ผู้ใช้เข้าจากไหน?

| รูปแบบ | ต้องทำอะไร |
|--------|------------|
| **LAN only** (ภายในออฟฟิศ) | firewall เปิดแค่ port 3001 ภายใน subnet |
| **VPN** | เปิด port เฉพาะ VPN range |
| **Public internet** | ⚠ ต้องมี HTTPS (Caddy/Nginx + Let's Encrypt) + domain name |

> **Demo / tester ครั้งแรกแนะนำ LAN** ก่อน — เร็วและไม่ต้อง config TLS

### 3. Server OS เป็นอะไร?

| OS | ความนิยม |
|----|---------|
| **Ubuntu 22.04 LTS** | ⭐ มาตรฐานสำหรับ production |
| **Debian 12** | similar |
| **Windows Server** | ใช้ได้ — start-server.bat รองรับอยู่แล้ว |

> Linux ทำงานเสถียรกว่า + ใช้ resource น้อยกว่า — แต่ถ้าทีมไม่คุ้น Windows ก็ deploy ได้

---

## 📋 Prerequisites บน server

ทุก path ต้องการของ 3 อย่าง:

| ของ | Version | คำสั่งติดตั้ง (Ubuntu) |
|-----|---------|----------------------|
| **Node.js** | ≥ v18 (project ใช้ v24) | `curl -fsSL https://deb.nodesource.com/setup_22.x \| sudo -E bash - && sudo apt install nodejs` |
| **Git** | any | `sudo apt install git` |
| **PostgreSQL** | ≥ 14 (เฉพาะถ้า app+DB เครื่องเดียว) | `sudo apt install postgresql postgresql-contrib` |

ตรวจสอบ:
```bash
node --version    # → v22.x or later
npm --version
git --version
```

---

## 🚀 Step-by-step Deployment

### 🅰️ ขั้นที่ 1 — ขึ้น Code ไป server

#### Option 1: ใช้ Git (แนะนำ)

ถ้ายังไม่มี repo:
```bash
# บนเครื่อง dev
cd "C:/Users/User/Desktop/First jobber work/work/ai-agent-dashboard"
git init
git add -A
git commit -m "Initial deployment snapshot"
git remote add origin <your-git-url>
git push -u origin main
```

บน server:
```bash
cd /opt
sudo git clone <your-git-url> petabyte-ai
sudo chown -R $USER:$USER petabyte-ai
cd petabyte-ai
```

#### Option 2: SCP / ZIP (ไม่ใช้ git)
```bash
# Windows (PowerShell)
Compress-Archive -Path . -DestinationPath petabyte.zip -Force
scp petabyte.zip user@server:/opt/

# บน server
unzip /opt/petabyte.zip -d /opt/petabyte-ai
cd /opt/petabyte-ai
```

> ⚠ ไฟล์ที่ **ไม่ต้องขึ้น** server:
> - `node_modules/` (จะ install ใหม่บน server)
> - `server/.env` (จะสร้างใหม่บน server พร้อม secrets จริง)
> - `_archive/` (optional)
> - `.git/` ถ้าใช้ option 2

---

### 🅱️ ขั้นที่ 2 — Install dependencies

```bash
cd /opt/petabyte-ai/server
npm install --omit=dev    # ติดตั้ง production deps อย่างเดียว
```

ใช้เวลา ~30 วินาที — 1 นาที

---

### 🅲️ ขั้นที่ 3 — ตั้งค่า `.env`

สร้าง `server/.env` บน server (อย่า copy จาก dev โดยตรง — ใช้ key ต่างกัน):

```bash
# Database
DB_HOST=<DB_HOST>              # ← IP ของ DB server
DB_PORT=5432
DB_NAME=OpenAI_DB
DB_USER=petabyte_app                # ← ✅ สร้าง user แยกสำหรับ app
DB_PASS=<strong-random-32-chars>

# OpenAI
OPENAI_API_KEY=sk-proj-...          # ← key สำหรับ app
OPENAI_MODEL=gpt-4o
OPENAI_ADMIN_KEY=sk-admin-...       # ← admin key (ปิด sync = optional)
OPENAI_ASSISTANT_ID=asst_...
OPENAI_VECTOR_STORE_ID=vs_...

# Security
ENCRYPTION_KEY=<64-hex-chars>       # ← AES-256 key (gen ใหม่ห้ามใช้ key เดียวกับ dev)
SESSION_SECRET=<random-32-chars>

# App config
PORT=3001
NODE_ENV=production
ALLOWED_ORIGINS=http://192.168.x.x:3001,https://app.yourdomain.com

# Optional toggles
OPENAI_USAGE_SYNC_ENABLED=false     # ตอนนี้ปิดไว้
```

### Generate secrets:
```bash
# ENCRYPTION_KEY (64 hex)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# SESSION_SECRET
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"

# DB_PASS
openssl rand -base64 32
```

---

### 🅳️ ขั้นที่ 4 — ตั้งค่า PostgreSQL

#### 🟢 ถ้า app + DB เครื่องเดียว (Option A)

```bash
sudo -u postgres psql
```
```sql
CREATE DATABASE "OpenAI_DB";
CREATE USER petabyte_app WITH PASSWORD 'paste-DB_PASS-here';
GRANT ALL PRIVILEGES ON DATABASE "OpenAI_DB" TO petabyte_app;
\c OpenAI_DB
GRANT ALL ON SCHEMA public TO petabyte_app;
\q
```

#### 🔵 ถ้าใช้ DB server ที่มีอยู่ (Option B — เคสของพี่)

บน **เครื่อง DB** (`<DB_HOST>`):

1. **อนุญาตให้ app server connect** — แก้ `pg_hba.conf`:
   ```
   host  OpenAI_DB  petabyte_app  192.168.x.x/32  scram-sha-256
   #                              ↑ IP ของ app server
   ```
2. **เปิด listen นอก localhost** — แก้ `postgresql.conf`:
   ```
   listen_addresses = '*'    # หรือ specific IP
   ```
3. **เปิด firewall port 5432** เฉพาะ subnet ของ app server
4. **Restart**: `sudo systemctl restart postgresql`

5. สร้าง user app (เหมือนใน Option A) — แต่ schema เดิมมีอยู่แล้ว ไม่ต้อง CREATE DATABASE

---

### 🅴️ ขั้นที่ 5 — รัน migration (ครั้งแรกบน server ใหม่)

```bash
cd /opt/petabyte-ai/server
npm run migrate
```

ผลลัพธ์ที่ควรเห็น:
```
[migrate] apply phase0-000-initial-schema.sql ...
[migrate]   ✓ phase0-000-initial-schema.sql (123 ms)
[migrate] apply phase5-001-decimal-money.sql ...
... (repeats for all 23 files)
[migrate] 23 applied, 0 up-to-date (23 total)
```

⚠ ถ้า DB มี data อยู่แล้ว (จาก dev environment): ทุก migration ใช้ `IF NOT EXISTS` → จะ skip ตัวที่ apply แล้ว, run แค่ตัวใหม่ ✅

---

### 🅵️ ขั้นที่ 6 — Smoke test

```bash
cd /opt/petabyte-ai/server
node server.js
```

ควรเห็น:
```
✅ PostgreSQL connected: OpenAI_DB @ <DB_HOST>:5432
[migrate] 0 applied, 23 up-to-date (23 total)
✅ System ready
```

ทดสอบจาก browser:
```
http://<server-ip>:3001/login.html
```

ปิด server ด้วย `Ctrl+C` แล้วไปขั้นต่อไป

---

### 🅶️ ขั้นที่ 7 — ทำเป็น service ถาวร (Linux)

ใช้ **systemd** ให้ server reboot ก็ยัง start เอง:

`/etc/systemd/system/petabyte.service`:
```ini
[Unit]
Description=PetabyteAi Backend
After=network.target

[Service]
Type=simple
User=petabyte                       # ← สร้าง user แยก ไม่ใช้ root
WorkingDirectory=/opt/petabyte-ai/server
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5
StandardOutput=append:/var/log/petabyte/app.log
StandardError=append:/var/log/petabyte/error.log
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo mkdir -p /var/log/petabyte
sudo chown petabyte:petabyte /var/log/petabyte
sudo systemctl daemon-reload
sudo systemctl enable petabyte
sudo systemctl start petabyte
sudo systemctl status petabyte      # ตรวจสถานะ
```

> **Windows version**: ใช้ `nssm` หรือ `node-windows` package ทำ Windows Service แทน

---

### 🅷️ ขั้นที่ 8 (optional) — HTTPS reverse proxy

ถ้าจะเปิด public + ใช้ domain ใส่ **Caddy** (ง่ายสุด, auto Let's Encrypt):

```caddyfile
app.yourdomain.com {
    reverse_proxy localhost:3001
}
```

`sudo apt install caddy && sudo systemctl reload caddy` → HTTPS ทำงานทันที

> **อย่าลืม**: ตอนใช้ HTTPS → แก้ `.env` `ALLOWED_ORIGINS` ใส่ `https://app.yourdomain.com` ด้วย

---

## ✅ Post-deploy Checklist

| ตรวจสอบ | คำสั่ง / วิธี |
|--------|--------------|
| Server start ได้ | `systemctl status petabyte` → active (running) |
| DB connect ได้ | log มี `✅ PostgreSQL connected` |
| Migrations ครบ | log มี `23 up-to-date (23 total)` |
| Login admin ได้ | เปิด /login.html → admin/admin123 |
| Chat ส่งได้ | user/user123 → ส่งข้อความใดๆ → ได้ response |
| Top-up project ได้ | admin → Credits → Top up → ดู balance อัปเดต |
| Logs ถูกเก็บ | `tail -f /var/log/petabyte/app.log` |
| Auto-restart ทำงาน | `sudo kill -9 $(pidof node)` → ดู systemd restart ใน ~5s |

---

## 🔄 Update Process (deploy ครั้งต่อๆ ไป)

```bash
cd /opt/petabyte-ai
git pull origin main                # หรือ scp ไฟล์ใหม่ทับ
cd server && npm install --omit=dev # ถ้า package.json เปลี่ยน
sudo systemctl restart petabyte     # restart → migrate-schema.js auto-apply
sudo systemctl status petabyte      # verify ok
```

> Migration ใหม่ใน `server/migrations/*.sql` จะถูก apply อัตโนมัติตอน server boot — ไม่ต้องสั่ง migrate manually

---

## 🛡️ Hardening (สำหรับ production จริง)

| รายการ | ความสำคัญ | วิธี |
|--------|----------|------|
| **เปลี่ยน admin password เริ่มต้น** | 🔴 ต้องทำทันที | login ครั้งแรก → "Change Password" |
| **Firewall เปิดเฉพาะ port ที่ใช้** | 🔴 ต้องทำ | `sudo ufw allow 3001/tcp from 192.168.0.0/16` |
| **HTTPS** ถ้าเปิด public | 🔴 ต้องทำ | Caddy / Nginx + Let's Encrypt |
| **DB backup รายวัน** | 🟠 ควรทำ | cron `pg_dump` → S3/local + retention 30 วัน |
| **Log rotation** | 🟡 nice | `logrotate` config สำหรับ `/var/log/petabyte/` |
| **Monitoring uptime** | 🟡 nice | UptimeRobot ฟรี + ping `/api/health` |
| **Rate limiting global** | 🟡 nice | มีแล้วระดับ app (chat rate limiter) — เสริม nginx ด้านนอก |

### ตัวอย่าง backup script (cron daily)
```bash
#!/bin/bash
# /usr/local/bin/petabyte-backup.sh
TS=$(date +%Y%m%d-%H%M)
DEST=/var/backups/petabyte
mkdir -p "$DEST"
PGPASSWORD='<DB_PASS>' pg_dump \
    -h <DB_HOST> -U petabyte_app \
    -F c -f "$DEST/OpenAI_DB_$TS.dump" OpenAI_DB
# Keep last 30 days
find "$DEST" -name "*.dump" -mtime +30 -delete
```

```bash
sudo crontab -e
# 02:00 ทุกวัน
0 2 * * * /usr/local/bin/petabyte-backup.sh
```

---

## 🚨 Troubleshooting

| อาการ | สาเหตุ | แก้ |
|------|--------|-----|
| `Cannot find module 'pg'` | ลืม `npm install` | `cd server && npm install --omit=dev` |
| `ECONNREFUSED 5432` | Postgres ไม่ listen หรือ firewall | เช็ค `pg_hba.conf` + `postgresql.conf` + `ufw` |
| `password authentication failed` | ผิด user/pass ใน .env | ตรวจ .env กับ `\du` ใน psql |
| `port 3001 already in use` | service เก่ายังรัน | `sudo systemctl restart petabyte` หรือ `lsof -i :3001` |
| Browser 401 หลัง deploy | CSRF/session origin ผิด | ตรวจ `ALLOWED_ORIGINS` ใน .env รวม URL ที่ client ใช้ |
| `migration MODIFIED since applied` | มีคนแก้ไฟล์ migration เก่า | ห้ามแก้ — สร้างไฟล์ migration ใหม่แทน |

---

## 📦 ไฟล์ที่ผู้ดูแลควรเก็บไว้ตลอด

| ไฟล์ | เหตุผล |
|------|--------|
| `server/.env` | Secrets — สำรองในที่ปลอดภัย (vault/encrypted backup) |
| `docs/database-overview.md` | คู่มือ DB |
| `docs/schema-current.sql` | snapshot schema ปัจจุบัน |
| `server/migrations/*.sql` | ประวัติ schema (ห้ามลบ) |
| `_meta.schema_migrations` ใน DB | tracker — ตรงนี้คือ "ที่ DB เคยรัน migration อะไรไปแล้ว" |

---

## 🗺️ สรุปขั้นตอน 1 หน้า

```
1.  Decide:  same-box vs split / LAN vs public / Linux vs Windows
2.  Server:  install node + git (+ postgres if same-box)
3.  Code:    git clone (or scp+unzip) ไป /opt/petabyte-ai
4.  Deps:    cd server && npm install --omit=dev
5.  Env:     create server/.env with prod secrets + DB conn
6.  DB:      create user/db, allow remote conn if split
7.  Migrate: npm run migrate
8.  Test:    node server.js → http://server:3001/login.html
9.  Service: systemd unit → enable + start
10. HTTPS:   Caddy reverse proxy (if public)
11. Verify:  ทำ checklist ข้างบน 8 ข้อ
12. Hardening: firewall, backups, monitoring
```

ใช้เวลารวมประมาณ **30-60 นาที** สำหรับการ deploy ครั้งแรก
ครั้งต่อๆ ไปแค่ `git pull && systemctl restart` ใช้เวลา ~30 วินาที

## Phase 50 (ยังไม่ push): deploy ต้องมี build step

ตั้งแต่ Phase 50 หน้าเว็บเป็น ES module + Vite. คำสั่ง deploy บนเครื่อง server
เปลี่ยนจากเดิม **เพิ่มสองบรรทัดก่อน restart**:

```powershell
cd C:\petabyte\onlyopenai-master
git fetch
git reset --hard origin/master
npm ci --include=dev  # devDependencies ที่ root (vite/eslint) — ครั้งแรกหรือเมื่อ package.json เปลี่ยน
                      # ต้องมี --include=dev เพราะ NODE_ENV=production ทำให้ npm ข้าม devDependencies
npm run build         # สร้าง dist/ — express เสิร์ฟ dist ก่อน แล้วตกลงมาที่ source tree
nssm restart PetabyteAi
```

ข้อกันพลาด: ถ้าลืม build — แอป **ยังทำงาน** เพราะหน้า source เป็น native ESM
และ express fallback ไปที่ source tree ให้เอง แค่ไม่ได้ไฟล์ minify/hash เท่านั้น
`dist/` ถูก gitignore จึงรอด `git reset --hard` มาได้ — server เทียบ commit ใน
`dist/build-meta.json` กับ `HEAD` ตอน boot ถ้าไม่ตรง (build ค้างจากรอบก่อน) จะข้าม dist
ไปใช้ source tree และขึ้น log `[static] dist/ skipped (...)` จึงไม่มีทางได้หน้าเก่าคู่กับ API ใหม่

ทดสอบ build ในเครื่อง: `npm run build` แล้ว start server ตามปกติ — server เสิร์ฟ dist ก่อนอยู่แล้ว
(ไม่ใช้ `vite preview`: มันไม่ inject `__API_BASE__` และไม่มี js/vendor ทำให้ login/chat ไม่ทำงาน)
