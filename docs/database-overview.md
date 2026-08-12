# PetabyteAi — Database Overview

> เอกสารสรุปโครงสร้าง database สำหรับบรรยายในการประชุมทีม
> _Updated: 2026-05-15 · Phase 20.2_

---

## 🎯 สรุปย่อ (Executive Summary)

| ประเด็น | ค่า |
|--------|-----|
| **ฐานข้อมูล** | PostgreSQL 16, host `192.168.69.125`, db `OpenAI_DB` |
| **จำนวนตาราง** | 15 ตาราง (รวม system table 1 ตัว) |
| **ขนาดข้อมูลรวม** | ~1.2 MB (ทั้งระบบยังเล็ก, รองรับเติบโตได้อีกหลายเท่า) |
| **จำนวน Migration** | 23 ไฟล์ (ทุก schema change เก็บประวัติครบ) |
| **ความปลอดภัย** | AES-256-GCM encrypt API keys, bcrypt hash passwords, CSRF + HttpOnly-cookie auth |
| **Backup** | _(ยังไม่มี automated — แนะนำใส่ก่อน production)_ |

---

## 📊 โครงสร้างข้อมูล 4 กลุ่ม

### กลุ่มที่ 1 — **Identity & Access** (ผู้ใช้ + สิทธิ์)

```
tbl_user_role  (2 rows)         lookup: admin / general user
   └─ role_id ←─────┐
                    │
tbl_acc_status (3 rows)         lookup: active / suspended / pending
   └─ acc_status_id ←┐
                     │
tbl_user (37 rows) ──┴── role_id, acc_status_id, project_id
   │
   └─ tbl_session (2 rows)  ←  one row per login (bearer token + CSRF)
```

**บทบาท:**
- `tbl_user` — ข้อมูลผู้ใช้: username, password (hashed), name, project ที่สังกัด
- `tbl_user_role` — ระบุว่าใครเป็น admin/user
- `tbl_acc_status` — สถานะบัญชี (active/suspended/...)
- `tbl_session` — ทุกครั้งที่ login จะสร้าง row ใหม่เก็บ token + CSRF token (เพื่อความปลอดภัย session-based + stateless API)

### กลุ่มที่ 2 — **Project & Billing** (โปรเจกต์และการเงิน)

```
tbl_project (13 rows)
   ├─ project_id (PK)
   ├─ rates (input/output/cached)
   ├─ api_key (encrypted AES-256-GCM)
   └─ OpenAI link (openai_project_id)
        │
        ├─ tbl_balance (5 rows)
        │    ├─ project_credits         ← ยอดคงเหลือใช้ได้ตอนนี้
        │    └─ project_credits_amount  ← ยอดสะสมเคยเติม (Phase 20 — ใหม่)
        │
        ├─ tbl_credits (35 rows)        ← เครดิตของแต่ละ user
        │
        └─ tbl_topup_project (4 rows)   ← ประวัติเติมเงินทุกครั้ง
```

**ทำไมต้องแยก 3 ตาราง:**
- `tbl_balance` = "เงินรวมของ project" — ระดับ project (ใครเป็น owner ของเงิน)
- `tbl_credits` = "เงินที่ admin จัดสรรให้ user" — แต่ละคนใช้คนละแยก
- `tbl_topup_project` = "audit trail" — รู้ว่าเติมเมื่อไหร่ จำนวนเท่าไหร่ ใครเติม

**Phase 20 ที่เพิ่ม:** `project_credits_amount` (ยอดสะสมที่ลูกค้าเคยเติมรวม) — ใช้สำหรับ:
1. แสดงในหน้า dashboard เพื่อให้เห็นมูลค่าตลอดอายุการใช้งาน
2. รองรับ **Tier system** ในอนาคต (Bronze/Silver/Gold ตามยอดสะสม → discount/rate ต่างกัน)

### กลุ่มที่ 3 — **Chat & AI Usage** (แชทและการใช้งาน AI)

```
tbl_chat_session (41 rows)        ← thread/conversation ของ user
   ├─ session_id (PK)
   ├─ user_id, title
   ├─ message_count, total_cost
   └─ is_favorite ⭐               ← Phase 19.7 (ปักหมุด)
        │
        └─ tbl_chat_message (66 rows)  ← ทุก turn (user say + AI say)
             ├─ role: user/assistant
             ├─ content, tokens, cost
             └─ skill_id ที่ใช้

tbl_response (33 rows)             ← per-turn accounting (สำหรับ billing)
   ├─ project_id, user_id, model
   ├─ tokens (input/output/cached/reasoning)
   └─ response_id
```

**ทำไมต้องเก็บ 2 ที่:**
- `tbl_chat_message` = "บทสนทนา" — แสดงใน chat UI, group by session
- `tbl_response` = "ใบเสร็จ" — สำหรับ analytics, group by user/project, ใช้คำนวณ cost ใน Activity Log

→ Design decision: แยกเพื่อ optimize query pattern ที่ต่างกัน

### กลุ่มที่ 4 — **Audit & System** (ตรวจสอบและระบบ)

```
tbl_audit_log (291 rows)           ← ใครเข้า/ออกระบบเมื่อไหร่
   ├─ event_type: login_ok / logout / login_fail / lockout
   ├─ log_in_time, log_out_time
   └─ ip, detail (jsonb)

tbl_action_admin (147 rows)        ← admin ทำอะไร (สำหรับ governance)
   ├─ action_type: create_user, topup_project, edit_balance, ...
   ├─ target_type / target_id
   └─ change_json (before/after diff)

tbl_daily_token (1 row)            ← Usage จาก OpenAI API (สำหรับ reconcile)
tbl_sync_state (1 row)             ← Status ของ sync job
```

**ทำไมต้องมี audit:**
- **กฎหมาย/ความรับผิดชอบ**: ถ้าวันหน้ามีปัญหาเรื่องเงิน/credentials ดูได้ว่าใครทำอะไร
- **Forensics**: ตามรอย incident
- **Compliance**: ตามมาตรฐาน security (SOC 2, ISO 27001 style)

---

## 🔄 Flow ตัวอย่าง: เมื่อ user ส่งคำถามใหม่ 1 ครั้ง

```
1. User browser → POST /api/chat { prompt, sessionId }
                  ↓
2. Server: verify session token  → READ tbl_session
                  ↓
3. Server: charge user credits   → UPDATE tbl_credits (deduct cost)
                  ↓
4. Server: call OpenAI API       → (external)
                  ↓
5. Server: persist outputs in 1 TRANSACTION:
   ├─ INSERT tbl_chat_message (user turn)
   ├─ INSERT tbl_chat_message (assistant turn)
   ├─ INSERT tbl_response (billing record)
   └─ UPDATE tbl_chat_session (bump message_count + total_cost)
                  ↓
6. Server: stream response       → ส่งกลับ browser
```

**Atomicity:** ขั้นที่ 5 ทำใน transaction เดียว — ถ้า fail ขั้นใดขั้นหนึ่ง rollback ทั้งหมด → ไม่มี ghost message ค้างใน DB

---

## 🔐 ความปลอดภัย

| Layer | วิธีการ | Implemented Phase |
|-------|--------|---------|
| Password storage | bcrypt + salt rounds 10 | Phase 1 |
| API key storage | AES-256-GCM encrypt with prefix `enc:v1:` | Phase 17.1 |
| Session token | 128-char random, stored in DB + httpOnly cookie | Phase 7 |
| CSRF | Double-submit pattern (header + DB compare) | Phase 9 |
| Account lockout | 5 failed → lock 15 mins (configurable) | Phase 8 |
| Force password change | First-login policy | Phase 8 |
| Soft delete | `is_deleted` flag — ไม่ลบจริง รักษา audit trail | Phase 6 / 7 |
| XSS prevention | `escapeHtml()` ทุก dynamic data ที่แสดงใน admin | Phase 19.3 |

---

## 📈 Migration System (วิธีจัดการการเปลี่ยนแปลง schema)

### หลักการ

> **"Migrations เป็น append-only history — ห้ามแก้ไฟล์เดิม, มีแต่เพิ่มไฟล์ใหม่เท่านั้น"**

แต่ละไฟล์ใน `server/migrations/` เป็น SQL ที่ idempotent (รันซ้ำกี่ครั้งก็ไม่พัง) — `migrate-schema.js` บน server boot จะอ่านทุกไฟล์ใน folder, ตรวจว่าไฟล์ไหนยัง apply ไม่ครบ (SHA-256 hash compare) แล้ว run ตามลำดับ.

### ประวัติการเปลี่ยนแปลง (23 phases)

| Phase | Topic | ตัวอย่าง |
|-------|-------|---------|
| 0 | Baseline schema | สร้าง tbl_* ทุกตัวครั้งแรก |
| 5 | Money precision | FLOAT → DECIMAL(12,2) (เพราะ FLOAT 0.10 ไม่ exact) |
| 6 | Indexes + meta | สร้าง index hot-path queries |
| 7 | Sessions | tbl_session + soft-delete flag |
| 8 | Lockout | failed_attempts + locked_until |
| 9 | CSRF | tbl_session.csrf_token |
| 11-14 | Audit/usability | Daily cap, action diff, audit log |
| 15 | OpenAI link | ผูก project กับ OpenAI Projects API |
| 16 | Top-up history | แยก audit ของการเติมเงินออกมา |
| 17 | Encrypt + Sync | encrypt API keys + รองรับ usage sync |
| 19.7 | Favorite chat | is_favorite flag |
| 19.9 | FK integrity | เพิ่ม FK ที่ขาด |
| **20** | **Lifetime top-up** | **project_credits_amount column (ใหม่ล่าสุด)** |

### Deploy ไป server ใหม่

1. ตั้ง Postgres ว่าง 1 DB
2. `npm start` — migrate-schema.js วิ่งครั้งแรก, สร้างทุก table จาก 23 migrations เรียงตามลำดับ
3. ไม่ต้องมี manual SQL script เลย

---

## 📦 ตารางทั้งหมด (เรียงตามขนาด)

| ตาราง | Rows | Size | บทบาท |
|------|-----:|-----:|------|
| `tbl_action_admin` | 147 | 152 KB | Admin actions audit |
| `tbl_response` | 33 | 144 KB | Per-turn billing records |
| `tbl_user` | 37 | 136 KB | User accounts |
| `tbl_audit_log` | 291 | 128 KB | Login/logout history |
| `tbl_chat_message` | 66 | 120 KB | Chat messages |
| `tbl_project` | 13 | 96 KB | Projects + API keys (encrypted) |
| `tbl_credits` | 35 | 72 KB | Per-user credit balance |
| `tbl_session` | 2 | 72 KB | Active login tokens |
| `tbl_topup_project` | 4 | 64 KB | Top-up events |
| `tbl_chat_session` | 41 | 56 KB | Conversation threads |
| `tbl_daily_token` | 1 | 40 KB | OpenAI usage aggregates |
| `tbl_sync_state` | 1 | 32 KB | Sync job status |
| `tbl_balance` | 5 | 24 KB | Project pool + lifetime |
| `tbl_acc_status` | 3 | 24 KB | Account status lookup |
| `tbl_user_role` | 2 | 24 KB | Roles lookup |

**Total: ~1.2 MB**

---

## 🎯 จุดเด่น Design

1. **Soft delete ทุกที่** → ลบอะไรไม่จริงๆ ทำ `is_deleted=true` แทน → audit trail สมบูรณ์
2. **Normalize เกือบเต็มที่ (3NF)** → ไม่มีข้อมูลซ้ำยกเว้นที่ตั้งใจ (tbl_chat_message vs tbl_response — แยกเพื่อ access pattern)
3. **FK constraint ครบ 17 ตัว** → DB ปฏิเสธ orphan record ที่ระดับ engine ไม่ใช่แค่ app
4. **Lookup tables เล็กๆ** (`tbl_user_role`, `tbl_acc_status`) → เปลี่ยน label ไม่ต้อง migrate ทั้ง DB
5. **DECIMAL ไม่ใช่ FLOAT** สำหรับเงิน → 0.10 + 0.20 = 0.30 exact (สำคัญมากกับ financial data)

---

## 🚧 จุดที่ยัง dormant (พร้อมใช้แต่ปิดอยู่)

| Feature | สถานะ | เปิดได้ยังไง |
|---------|------|------------|
| Auto-sync OpenAI usage | ปิดด้วย env var | ตั้ง `OPENAI_USAGE_SYNC_ENABLED=true` |
| Sync Status admin tab | hidden ใน sidebar | ลบ `style="display:none"` |
| Skill Prompts tab | hidden ใน sidebar | ลบ `style="display:none"` |
| Skill content จริง (ABAP) | placeholders ใน JSON file | ABAP team paste content เข้า `skill-prompts.json` |

---

## 🔮 แผนต่อยอดในอนาคต

| Feature | ขนาดงาน | ต้องการอะไร |
|---------|--------|------------|
| Customer Tier system | M | ตั้งเกณฑ์ Bronze/Silver/Gold + rate override |
| 2FA สำหรับ admin | M | ตัดสินใจ TOTP vs SMS, library choice |
| Email notifications | M | SMTP config + design templates |
| Daily backup automation | S | cron + retention policy |
| Read replica | L | ตอนยอด users พุ่ง > 1000 active |

---

## 📚 References

- Migration files: `server/migrations/*.sql` (23 ไฟล์)
- Schema dump (canonical): `docs/schema-current.sql` (auto-gen จาก live DB)
- Migration timeline: `server/migrations/README.md`
- Schema decision rationale: `docs/schema-decision.md`
