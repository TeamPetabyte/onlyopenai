# Deployment Guide — PetabyteAi บน Windows (ตัวถาวร)

> วิธี deploy ให้รันถาวรบนเครื่อง Windows + เปิดให้เพื่อนเข้าจากอินเทอร์เน็ตผ่าน Cloudflare Tunnel
> _เครื่องที่รัน app = เครื่อง Windows ของบริษัท · ผู้ใช้เข้าผ่าน HTTPS จากที่ไหนก็ได้_

---

## 🗺️ ภาพรวมสถาปัตยกรรม

```
   เพื่อน (เบราว์เซอร์, ที่ไหนก็ได้)              เครื่อง Windows บริษัท
   ┌───────────────────────┐                ┌──────────────────────────────┐
   │  https://app.xxx.com   │ ──อินเทอร์เน็ต──▶│  cloudflared (service)        │
   │  ไม่ต้องต่อ VPN          │   (HTTPS)       │     └▶ node server.js :3001    │
   └───────────────────────┘                │           └▶ PostgreSQL DB     │
                                            │              192.168.69.125    │
                                            └──────────────────────────────┘
                                              ▲ เฉพาะเครื่องนี้ที่ต้องถึง DB
                                              (LAN เดียวกัน = ไม่ต้อง VPN,
                                               อยู่นอกเครือข่าย = ต่อ VPN)
```

**สำคัญ:** VPN ต้องการแค่ที่ **เครื่อง Windows ที่รัน app** (เพื่อให้ถึง DB) — **เพื่อนที่เข้าลิงก์ไม่ต้องต่อ VPN เลย** เพราะเขาคุยกับ Cloudflare (อินเทอร์เน็ตสาธารณะ) เท่านั้น

---

## 📋 สิ่งที่ต้องเตรียม

| ของ | รายละเอียด |
|-----|-----------|
| เครื่อง Windows | เปิดทิ้งไว้ได้ 24/7, เข้าถึง DB `192.168.69.125` ได้ (LAN หรือ VPN) |
| Node.js LTS | ดาวน์โหลด: https://nodejs.org (เลือก LTS, ตัว .msi) |
| โค้ดโปรเจค | git clone หรือ copy โฟลเดอร์ `onlyopenai` ไปวางบนเครื่อง เช่น `C:\petabyte\onlyopenai` |
| บัญชี Cloudflare | ฟรี — https://dash.cloudflare.com/sign-up |
| โดเมน (แนะนำ) | เพื่อให้ได้ URL คงที่สวย ๆ เช่น `app.yourcompany.com` (ผูกกับ Cloudflare) |

> **ยังไม่มีโดเมน?** ใช้ quick tunnel ไปก่อนได้ (URL สุ่ม เปลี่ยนทุก restart) — ดูภาคผนวก A ท้ายเอกสาร

---

## 🚀 ขั้นตอน (รันใน PowerShell บนเครื่อง Windows)

### 1) ติดตั้ง Node.js + dependencies
ติดตั้ง Node.js LTS จาก nodejs.org ก่อน แล้วเปิด **PowerShell**:
```powershell
node -v        # ควรได้ v18 ขึ้นไป
cd C:\petabyte\onlyopenai\server
npm install --omit=dev
```

### 2) ตั้งค่า `.env` แบบ production
```powershell
copy .env.production.example .env
notepad .env
```
แก้ค่าให้ครบ (ดูคำอธิบายในไฟล์) — ที่ต้องใส่แน่ ๆ:
- `DB_PASS`, `OPENAI_API_KEY`, `OPENAI_ASSISTANT_ID`, `OPENAI_VECTOR_STORE_ID`, `ENCRYPTION_KEY` → **ใช้ค่าเดิมจาก .env ที่เทสได้แล้ว**
- `ALLOWED_ORIGINS` → ใส่ URL สาธารณะที่เพื่อนจะใช้ เช่น `https://app.yourcompany.com` (ตั้งทีหลังในขั้นที่ 5 ก็ได้ แล้วค่อยกลับมาแก้)

> 💡 วิธีง่ายสุด: copy ไฟล์ `server\.env` ตัวที่ใช้เทสได้แล้วมาทับ แล้วแก้แค่ `NODE_ENV=production` กับ `ALLOWED_ORIGINS`

### 3) รัน migrations + ทดสอบ
```powershell
npm run migrate        # ครั้งแรกบนเครื่องใหม่ (ถ้าใช้ DB เดิมจะ skip ของที่มีอยู่)
node server.js         # ทดสอบ — ควรเห็น "PostgreSQL connected" + "System ready"
```
กด `Ctrl+C` เพื่อหยุด แล้วไปทำเป็น service

### 4) ทำ app เป็น Windows Service ด้วย NSSM (auto-start + รีบูตก็ขึ้นเอง)
ดาวน์โหลด NSSM: https://nssm.cc/download → แตกไฟล์ เอา `nssm.exe` (โฟลเดอร์ win64) วางไว้เช่น `C:\petabyte\nssm.exe`

ใช้สคริปต์ที่เตรียมไว้ (รัน PowerShell แบบ **Run as Administrator**):
```powershell
cd C:\petabyte\onlyopenai\windows
.\install-services.ps1
```
หรือทำเองทีละคำสั่ง (ดูในไฟล์ `windows\install-services.ps1`)

ตรวจสอบ:
```powershell
nssm status PetabyteAi          # → SERVICE_RUNNING
curl http://localhost:3001/api/health
```

### 5) เปิด public ด้วย Cloudflare Tunnel (URL คงที่ + HTTPS)
ดาวน์โหลด `cloudflared.exe`: https://github.com/cloudflare/cloudflared/releases (ตัว `cloudflared-windows-amd64.exe`) วางไว้ `C:\petabyte\cloudflared.exe`

**แบบมีโดเมน (แนะนำ — URL คงที่):**
```powershell
cd C:\petabyte
.\cloudflared.exe tunnel login                      # เปิดเบราว์เซอร์ login + เลือกโดเมน
.\cloudflared.exe tunnel create petabyte            # สร้าง tunnel ชื่อ petabyte
.\cloudflared.exe tunnel route dns petabyte app.yourcompany.com
```
สร้างไฟล์ config `C:\Users\<you>\.cloudflared\config.yml`:
```yaml
tunnel: petabyte
credentials-file: C:\Users\<you>\.cloudflared\<tunnel-id>.json
ingress:
  - hostname: app.yourcompany.com
    service: http://localhost:3001
  - service: http_status:404
```
ติดตั้งเป็น Windows service (รันถาวร):
```powershell
.\cloudflared.exe service install
```
จากนั้นกลับไปแก้ `.env` → `ALLOWED_ORIGINS=https://app.yourcompany.com` แล้ว `nssm restart PetabyteAi`

✅ เสร็จ — เพื่อนเข้า **https://app.yourcompany.com/login.html** ได้จากทุกที่ ไม่ต้องต่อ VPN

---

## ✅ Checklist หลัง deploy

| ตรวจ | วิธี |
|------|------|
| App service รัน | `nssm status PetabyteAi` → RUNNING |
| Tunnel service รัน | `Get-Service cloudflared` → Running |
| DB ต่อได้ | log เครื่องมี "PostgreSQL connected" |
| เข้าจากเน็ตได้ | เปิด URL จากมือถือ (ปิด wifi บริษัท/ใช้ 4G) → เห็นหน้า login |
| Login ได้ ไม่เด้ง | login เข้า dashboard ได้ (ถ้าเด้ง = `ALLOWED_ORIGINS` ไม่ตรง URL) |
| 🔴 เปลี่ยนรหัส admin | `node reset-admin.js --password "<รหัสใหม่แข็งแรง>"` ก่อนใช้จริง |

---

## 🔄 อัปเดตเวอร์ชันใหม่ภายหลัง
```powershell
cd C:\petabyte\onlyopenai
git pull                         # หรือ copy ไฟล์ใหม่ทับ
cd server; npm install --omit=dev
nssm restart PetabyteAi          # migrate รันอัตโนมัติตอน boot
```

---

## 🧯 ปัญหาที่เจอบ่อย

| อาการ | สาเหตุ / แก้ |
|------|------|
| login แล้วเด้ง "session หมดอายุ" | `ALLOWED_ORIGINS` ไม่ตรง URL ที่เข้า → แก้ .env ให้ตรงเป๊ะ + `nssm restart PetabyteAi` |
| เปิด URL ไม่ขึ้นเลย | tunnel service ไม่รัน / config.yml ผิด → `Get-Service cloudflared`, ดู log |
| `ECONNREFUSED 5432` | เครื่องถึง DB ไม่ได้ → เช็ค VPN/LAN ไปยัง 192.168.69.125 |
| cookie ไม่ติด (เด้งทั้งที่ origin ตรง) | ต้องเข้าผ่าน **https** (tunnel) เท่านั้น เพราะ production ใช้ secure cookie |
| แก้ .env แล้วไม่มีผล | ไฟล์เป็น CRLF — แก้ด้วย Notepad/VS Code ปกติได้ แต่ห้ามมีอักขระแปลกกลางบรรทัด แล้ว restart service |

---

## 📎 ภาคผนวก A — ยังไม่มีโดเมน (quick tunnel ชั่วคราว)
URL จะสุ่มและเปลี่ยนทุกครั้งที่ restart:
```powershell
.\cloudflared.exe tunnel --url http://localhost:3001
```
คัดลอก URL `https://xxxx.trycloudflare.com` ที่ขึ้นมา → เอาไปใส่ `ALLOWED_ORIGINS` ใน .env → `nssm restart PetabyteAi`
> ข้อเสีย: ปิด/เปิดใหม่ = URL เปลี่ยน ต้องอัปเดต .env ทุกครั้ง — เหมาะกับทดลองสั้น ๆ เท่านั้น ไม่เหมาะถาวร
