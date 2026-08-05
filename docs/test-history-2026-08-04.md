# ประวัติการทดสอบระบบ RAG + Chat — 4 ส.ค. 2026 (v1.8.0 → v1.9.0)

การทดสอบทั้งหมดยิงตรงเข้า OpenAI API (ไม่ผ่านหน้าแอป จึงไม่อยู่ในประวัติ Prompt Lab)
สคริปต์ต้นฉบับอยู่ใน scratchpad ของ session — เนื้อหาสำคัญสรุปไว้ที่นี่

## 1. ทดสอบ Vector Store Search (v1.8.0)

**คำถาม:** table buffering types ใน ABAP Dictionary
**ผล:** ✅ ผลลัพธ์ 4 อันดับแรกมาจาก `BC430_EN_Col18 - ABAP Dictionary.pdf` ทั้งหมด
(score สูงสุด 0.855) — เนื้อหา Generic/Single-Record/Full Buffering ครบ

## 2. ทดสอบ E2E: โมเดลเรียก tool เอง (v1.8.0)

**โจทย์:** ถามเรื่อง table buffering ผ่าน system prompt + tools แบบเดียวกับ chat จริง
**ผล:** ✅ โมเดลเรียก `search_knowledge("table buffering types ABAP Dictionary")` เอง
→ ได้ 6 chunks จาก BC430 → คำตอบถูกต้อง (3 แบบ + Full เหมาะกับตารางเล็กอ่านบ่อย)
พร้อมอ้างชื่อไฟล์ `[BC430_EN_Col18 - ABAP Dictionary.pdf]`

## 3. วินิจฉัยบั๊ก "I don't see any ABAP code" (v1.8.3)

เคสจริงจาก senior: วางโค้ด 3,001 ตัวอักษรใน Lab (skill: SELECT in LOOP,
gpt-5.6-terra/high) แต่ AI ตอบว่าไม่เห็นโค้ด

| การทดลอง | รูปแบบ | ผล |
|---|---|---|
| A | โค้ดฝังใน instructions, ไม่มี tool | ✅ วิเคราะห์ได้ (ยังไม่ trigger บั๊ก) |
| B | โค้ดใน user message, ไม่มี tool | ✅ วิเคราะห์ได้ |
| C | โค้ดฝังใน instructions + มี tool → โมเดลเรียก search_knowledge | ❌ **"I don't see any ABAP code"** — reproduce บั๊กสำเร็จ |
| D | เหมือน C แต่ส่ง instructions ซ้ำทุกเทิร์น | ✅ วิเคราะห์ได้ถูกต้อง |

**Root cause:** Responses API ไม่ยก `instructions` ข้ามเทิร์นเมื่อใช้
`previous_response_id` — หลังเรียก tool ครั้งแรก system prompt (รวมโค้ดที่ฝังผ่าน
`{code}`) หายทั้งก้อน → **แก้:** ส่ง instructions ทุก call (v1.8.3)

## 4. ทดสอบเอกสารมาตรฐาน TA243 (v1.8.7)

**ไฟล์:** `SAP ABAP standards COPY keystone.doc` (TA243 v2.0, 2.2MB)
**ผล:** ✅ index ผ่าน (success=1, failed=0) — ค้น "naming conventions" / "Z prefix"
เจอเนื้อหาจากไฟล์นี้ที่ score 0.86–0.89

## 5. ทดสอบความจำบทสนทนา + คำถามต่อเนื่อง (v1.9.0)

เคสจริงจาก senior: เทิร์น 1 วางโค้ด (AI แก้ให้) → เทิร์น 2 ถามต่อเรื่อง MARA
แบบไม่มีโค้ด → AI ตอบ "No ABAP source code was provided"

**การทดลอง (รูปแบบที่แก้แล้ว):** ส่ง history [โค้ดเทิร์น 1 + คำตอบ AI] + คำถาม
MARA ประโยคเดียวกับของ senior บน gpt-5.6-terra/medium
**ผล:** ✅ ตอบคำถามต่อเนื่องได้ อ้างโค้ดจากเทิร์นก่อน แปลงเป็น internal table +
`FIELD-SYMBOL` ตามที่ขอ — ไม่มี "no code" อีก

**Heuristic แยกโค้ด/คำถาม:**
- โค้ดตัวอย่าง ABAP (multi-line + keyword) → ✅ detected as code
- ประโยคคำถามของ senior → ✅ treated as question

## สรุป version ที่ออกวันนี้

| Version | เรื่อง |
|---|---|
| v1.8.0 | search_knowledge RAG tool + BC430 indexed |
| v1.8.1 | Lab/eval ตอบภายใต้เงื่อนไขเดียวกับ chat จริง |
| v1.8.2 | ป้าย 🔍 RAG ใน chat |
| v1.8.3 | ฟิกซ์ instructions หายหลัง tool call (Responses API) |
| v1.8.4 | กล่องโค้ดใน Lab: ลากแนวตั้ง + ไม่ตัดบรรทัด |
| v1.8.5 | ประวัติ Lab เห็นทุก skill + ป้ายบอก skill |
| v1.8.6 | เปลี่ยนคำ verdict → approve/การอนุมัติ |
| v1.8.7 | รองรับ .doc + สั่งให้โค้ดตามมาตรฐาน TA243 |
| v1.8.8 | ปุ่ม ➕ ทดสอบใหม่ใน Lab |
| v1.8.9 | กฎกัน hallucination (ห้ามแต่ง SAP object) |
| v1.9.0 | **ความจำบทสนทนา** + {code} skill รับคำถามธรรมดา |
