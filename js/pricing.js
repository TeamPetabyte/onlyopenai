/**
 * pricing.js — Custom Rate Calculation Engine
 * AgentHub SAP Edition — ราคาของเราเอง ไม่เกี่ยวกับเรทของ OpenAI
 */

const PRICING = {
  // แผนราคาทั้งหมด
  plans: {
    starter: {
      id: 'starter',
      name: 'Starter',
      desc: 'เหมาะสำหรับ SAP Developer ที่เริ่มต้นใช้ AI ช่วยพัฒนา',
      monthlyFee: 0,
      feeLabel: 'ฟรี',
      feeSub: 'เครดิตเริ่มต้น ฿100',
      inputRate: 0.50,   // ฿ ต่อ 1,000 input tokens
      outputRate: 1.50,  // ฿ ต่อ 1,000 output tokens
      features: [
        'เครดิตเริ่มต้น ฿100',
        'ทุก SAP Agent Skills พื้นฐาน',
        'ABAP Code Generation & Review',
        'ประวัติการใช้งาน 30 วัน',
        'อัตรา: ฿0.50/1K input tokens',
        'อัตรา: ฿1.50/1K output tokens',
      ],
      color: '#a78bfa',
    },
    pro: {
      id: 'pro',
      name: 'Pro',
      desc: 'สำหรับทีม SAP Developer ที่ใช้งานสม่ำเสมอในองค์กร',
      monthlyFee: 499,
      feeLabel: '฿499',
      feeSub: 'ต่อเดือน',
      inputRate: 0.35,
      outputRate: 1.10,
      features: [
        'ทุกอย่างใน Starter',
        'ลดราคา token ทันที 30%',
        'Advanced ABAP Optimizer',
        'SAP BAPI/RFC Finder',
        'Priority Support',
        'อัตรา: ฿0.35/1K input tokens',
        'อัตรา: ฿1.10/1K output tokens',
      ],
      color: '#38bdf8',
      featured: true,
    },
    enterprise: {
      id: 'enterprise',
      name: 'Enterprise',
      desc: 'สำหรับองค์กรขนาดใหญ่ที่มี SAP landscape ซับซ้อน',
      monthlyFee: 1999,
      feeLabel: '฿1,999',
      feeSub: 'ต่อเดือน',
      inputRate: 0.20,
      outputRate: 0.80,
      features: [
        'ทุกอย่างใน Pro',
        'ราคาต่ำสุดต่อ token',
        'Custom SAP Skills ตามต้องการ',
        'Dedicated account manager',
        'SAP System Integration',
        'อัตรา: ฿0.20/1K input tokens',
        'อัตรา: ฿0.80/1K output tokens',
      ],
      color: '#34d399',
    },
  },

  // รายการ SAP/ABAP Agent Skills
  skills: [
    {
      id: 'auto',
      name: 'PipekAI',
      emoji: '🧠',
      desc: 'AI วิเคราะห์คำถามและตอบได้ทันที — ไม่ต้องเลือก skill เอง',
      tags: ['PipekAI', 'SAP', 'ABAP', 'Auto'],
      type: 'advanced',
      avgOutputTokens: 420,
      systemPrompt: `You are PipekAI, an Expert SAP/ABAP AI Assistant for the SAP S/4HANA system. You automatically detect what the user needs and respond accordingly.

## Your capabilities:
- **ABAP Code Generation**: Generate ABAP reports, classes, function modules, BAPI calls, SELECT statements
- **Code Review & Best Practices**: Review ABAP code for performance issues, obsolete syntax (TABLES, LIKE), missing error handling
- **Obsolete Statement Detection**: Detect and fix TABLES, LIKE, implicit SELECT without INTO clause
- **Performance Optimization**: Fix SELECT-in-LOOP, unnecessary full table scans, SELECT *, missing indexes
- **Error Analysis**: Analyze ABAP dumps, ST22 errors, short dumps, runtime exceptions
- **Unit Testing**: Generate ABAP Unit Test classes with setup/teardown and edge cases
- **CDS Views**: Generate CDS Interface and Consumption views with annotations for Fiori
- **Documentation**: Write technical specs, functional specs, and code comments
- **BAPI/RFC Finder**: Suggest the most appropriate BAPI/RFC/Function Module for a task
- **General SAP Q&A**: Answer questions about SAP modules, configurations, transactions

## Instructions:
1. Read the user's message carefully
2. Identify what kind of help is needed (code generation, review, debug, documentation, etc.)
3. Respond directly with the most helpful answer
4. If code is provided, analyze it and correct what the rules below permit you to correct — report anything else instead of changing it
5. Always respond in the same language the user used (Thai or English)
6. Format code blocks properly with language tags
7. Be concise but complete — never truncate important code`,
      mockResponses: [
        `🧠 **Smart Mode ตรวจพบ:** ABAP Code Review

## 🔍 การวิเคราะห์

คุณได้ส่ง ABAP code มาให้ตรวจสอบ ฉันพบปัญหาดังนี้:

### ❌ ปัญหาที่พบ:
- SELECT ใน LOOP (N+1 query — ลด performance อย่างมาก)
- ขาดการตรวจสอบ sy-subrc

### ✅ Code หลังแก้ไข:
\`\`\`abap
" Use JOIN instead of SELECT in LOOP
SELECT h~vbeln, i~matnr, i~netwr
  FROM vbak AS h
  INNER JOIN vbap AS i ON h~vbeln = i~vbeln
  INTO TABLE @DATA(lt_result)
  WHERE h~erdat >= @lv_date.

IF sy-subrc <> 0.
  MESSAGE 'No data found' TYPE 'I'.
  RETURN.
ENDIF.
\`\`\``,
      ],
    },
    {
      id: 'abap-gen',
      name: 'ABAP Code Generator',
      emoji: '⚡',
      desc: 'สร้าง ABAP code จาก requirement — SELECT, LOOP, BAPI call, Function Module และอื่นๆ อัตโนมัติ',
      tags: ['ABAP', 'Code Gen'],
      type: 'advanced',
      avgOutputTokens: 420,
      systemPrompt: 'คุณเป็น SAP ABAP developer มืออาชีพ สร้าง ABAP code ที่ถูกต้องตาม best practice รองรับ SAP ECC และ S/4HANA',
      mockResponses: [
        `ABAP Code ที่สร้างขึ้น:

\`\`\`abap
*&---------------------------------------------------------------------*
*& Report  Z_DEMO_AGENT
*& Generated by AgentHub SAP AI
*&---------------------------------------------------------------------*
REPORT z_demo_agent.

" ---- Data Declarations ----
DATA: lt_mara   TYPE TABLE OF mara,
      ls_mara   TYPE mara,
      lv_matnr  TYPE matnr.

" ---- Selection Screen ----
SELECT-OPTIONS: so_matnr FOR lv_matnr.

" ---- Main Logic ----
START-OF-SELECTION.

  " Select material data
  SELECT matnr mtart matkl ernam ersda
    FROM mara
    INTO TABLE lt_mara
    WHERE matnr IN so_matnr
      AND mtart = 'FERT'
    ORDER BY matnr.

  IF sy-subrc <> 0.
    MESSAGE 'ไม่พบข้อมูล' TYPE 'I'.
    RETURN.
  ENDIF.

  " Process each material
  LOOP AT lt_mara INTO ls_mara.
    WRITE: / ls_mara-matnr,
             ls_mara-mtart,
             ls_mara-ernam.
  ENDLOOP.
\`\`\`

✅ Code สร้างเสร็จแล้ว
📌 รองรับ: SAP ECC 6.0 / S/4HANA
⚠️ ควร activate และทดสอบใน Development system ก่อน`,
        `ABAP Function Module สำหรับ BAPI Call:

\`\`\`abap
*&---------------------------------------------------------------------*
*& BAPI: สร้าง Sales Order
*&---------------------------------------------------------------------*
FORM create_sales_order
  USING    iv_kunnr TYPE kunnr
  CHANGING ev_vbeln TYPE vbeln
           ev_message TYPE string.

  DATA: ls_order_header  TYPE bapisdhd1,
        ls_order_headerx TYPE bapisdhd1x,
        lt_order_items   TYPE TABLE OF bapisditm,
        ls_order_item    TYPE bapisditm,
        lt_return        TYPE TABLE OF bapiret2,
        ls_return        TYPE bapiret2.

  " Fill Header
  ls_order_header-doc_type   = 'TA'.
  ls_order_header-sales_org  = '1000'.
  ls_order_header-distr_chan = '10'.
  ls_order_header-division   = '00'.
  ls_order_header-purch_no_c = 'PO-001'.

  ls_order_headerx-doc_type   = 'X'.
  ls_order_headerx-sales_org  = 'X'.

  " Call BAPI
  CALL FUNCTION 'BAPI_SALESORDER_CREATEFROMDAT2'
    EXPORTING
      order_header_in  = ls_order_header
      order_header_inx = ls_order_headerx
    IMPORTING
      salesdocument    = ev_vbeln
    TABLES
      return           = lt_return.

  " Check return messages
  READ TABLE lt_return INTO ls_return
    WITH KEY type = 'E'.
  IF sy-subrc = 0.
    ev_message = ls_return-message.
  ELSE.
    CALL FUNCTION 'BAPI_TRANSACTION_COMMIT'
      EXPORTING wait = 'X'.
    ev_message = |Sales Order { ev_vbeln } created|.
  ENDIF.

ENDFORM.
\`\`\`

✅ BAPI Code พร้อมใช้งาน`,
      ],
    },
    {
      id: 'abap-review',
      name: 'ABAP Code Review',
      emoji: '🔍',
      desc: 'วิเคราะห์ ABAP code หาจุดอ่อน performance, memory leak, missing error handling และ SAP best practices',
      tags: ['Review', 'Quality'],
      type: 'advanced',
      avgOutputTokens: 380,
      systemPrompt: 'คุณเป็น senior SAP ABAP developer วิเคราะห์โค้ดและให้คำแนะนำตาม SAP best practices และ performance optimization',
      mockResponses: [
        `## 🔍 ABAP Code Review Report

### ✅ สิ่งที่ดี:
- การตั้งชื่อตัวแปรชัดเจน (\`lt_\`, \`ls_\`, \`lv_\` prefix ถูกต้อง)
- มีการตรวจสอบ \`sy-subrc\` หลัง SELECT

### ⚠️ ปัญหาที่พบ (เรียงตามความสำคัญ):

#### 🔴 Critical — Performance
\`\`\`
" ❌ ปัญหา: SELECT ใน LOOP (N+1 query)
LOOP AT lt_mara INTO ls_mara.
  SELECT SINGLE * FROM makt INTO ls_makt
    WHERE matnr = ls_mara-matnr.  " <-- ทำงาน N ครั้ง!
ENDLOOP.

" ✅ แก้ไข: ใช้ JOIN หรือ SELECT..FOR ALL ENTRIES
SELECT m~matnr, t~maktx
  FROM mara AS m
  JOIN makt AS t ON t~matnr = m~matnr
  INTO TABLE @DATA(lt_result)
  WHERE m~mtart = 'FERT'.
\`\`\`

#### 🟡 Warning — Error Handling
\`\`\`
" ❌ ขาด error handling ใน BAPI call
CALL FUNCTION 'BAPI_SALESORDER_CREATEFROMDAT2'...

" ✅ ควรตรวจสอบ return table เสมอ
READ TABLE lt_return WITH KEY type = 'E' TRANSPORTING NO FIELDS.
IF sy-subrc = 0.
  ROLLBACK WORK.
  RETURN.
ENDIF.
\`\`\`

#### 🟢 Suggestion — Modernization (S/4HANA)
- แนะนำใช้ **AMDP** หรือ **CDS View** แทน SELECT ใน program
- ใช้ **Inline declaration** (\`DATA(ls_mara)\`) แทนการ declare ด้านบน

### สรุป: ⭐⭐⭐☆☆ (3/5)
แก้ไขปัญหา Performance SELECT-in-LOOP ก่อนนำขึ้น Production`,
      ],
    },
    {
      id: 'abap-debug',
      name: 'SAP Error Analyzer',
      emoji: '🐛',
      desc: 'วิเคราะห์ dump, error message, short dump จาก ST22 หรือ SM21 และแนะนำวิธีแก้ไข',
      tags: ['Debug', 'ST22'],
      type: 'advanced',
      avgOutputTokens: 350,
      systemPrompt: 'คุณเป็น SAP basis/ABAP expert ที่เชี่ยวชาญการวิเคราะห์ ABAP dump และ runtime errors พร้อมแนะนำวิธีแก้ไขที่ชัดเจน',
      mockResponses: [
        `## 🐛 SAP Error Analysis

### Error พบ:
\`\`\`
Short Dump: SYSTEM_CORE_DUMPED
Runtime Error: FIELD_SYMBOL_NOT_ASSIGNED
Program: Z_MY_REPORT  Line: 147
\`\`\`

### สาเหตุ (Root Cause):
Field Symbol ถูก ASSIGN แต่ยังไม่ได้ตรวจสอบ \`IS ASSIGNED\` ก่อนใช้งาน เมื่อ internal table ว่าง field symbol จะ unassigned ทำให้เกิด dump

### วิธีแก้ไข:
\`\`\`abap
" ❌ โค้ดที่มีปัญหา (line 147)
FIELD-SYMBOLS: <ls_data> TYPE data.
LOOP AT lt_data ASSIGNING <ls_data>.
  " ... เมื่อ lt_data ว่าง จะไม่เข้า LOOP
ENDLOOP.
" แต่ถ้ามีการใช้ <ls_data> นอก LOOP จะ dump!
WRITE: <ls_data>-field. " <-- ❌ dump ที่นี่

" ✅ วิธีแก้ไข
IF <ls_data> IS ASSIGNED.
  WRITE: <ls_data>-field.
ENDIF.

" หรือใช้ inline declaration (แนะนำสำหรับ S/4HANA)
LOOP AT lt_data INTO DATA(ls_data).
  WRITE: ls_data-field.
ENDLOOP.
\`\`\`

### การป้องกัน:
1. ตรวจสอบ \`IS ASSIGNED\` ทุกครั้งก่อนใช้ Field Symbol
2. ใช้ Inline Declaration แทนถ้าเป็นไปได้
3. เพิ่ม unit test สำหรับ empty table case

### ✅ แก้ไขแล้วควรรัน TA: ST22 เพื่อยืนยัน dump หายไป`,
      ],
    },
    {
      id: 'abap-optimize',
      name: 'ABAP Optimizer',
      emoji: '🚀',
      desc: 'ปรับปรุง ABAP code ให้ทำงานเร็วขึ้น — index suggestion, parallel processing, buffer optimization',
      tags: ['Performance', 'S/4HANA'],
      type: 'advanced',
      avgOutputTokens: 400,
      systemPrompt: 'คุณเป็น SAP performance expert วิเคราะห์และ optimize ABAP code สำหรับทั้ง ECC และ S/4HANA HANA DB',
      mockResponses: [
        `## 🚀 Performance Optimization Report

### ⏱️ ปัญหาด้าน Performance ที่พบ:

---
#### 1. ❌ Full Table Scan — ขาด WHERE clause บน index field
\`\`\`abap
" ❌ วิธีเดิม — Full scan
SELECT * FROM vbak INTO TABLE lt_vbak.

" ✅ วิธีใหม่ — ใช้ primary key / ชุด field ที่มี index
SELECT vbeln erdat kunnr netwr
  FROM vbak INTO TABLE @DATA(lt_vbak)
  WHERE erdat >= @lv_date_from
    AND erdat <= @lv_date_to
    AND vkorg = @lv_vkorg.
\`\`\`
**ผลกระทบ:** ลด runtime ได้ถึง 80-90% บน large dataset

---
#### 2. ❌ SELECT * (Over-fetching)
\`\`\`abap
" ❌ ดึงทุก field ทั้ง 200+ field
SELECT * FROM mara INTO TABLE lt_mara.

" ✅ ดึงเฉพาะ field ที่ใช้
SELECT matnr mtart matkl meinh
  FROM mara INTO TABLE @DATA(lt_mara)
  WHERE mtart IN @so_mtart.
\`\`\`
**ผลกระทบ:** ลด network I/O และ memory ได้ 60-70%

---
#### 3. ✨ S/4HANA — แนะนำใช้ AMDP (HANA Pushdown)
\`\`\`abap
" ใช้ CDS View แทน program logic
@AbapCatalog.sqlViewName: 'ZSALES_SUM'
define view Z_SALES_SUMMARY as
  select from vbak as h
    inner join vbap as i on h.vbeln = i.vbeln
  {
    h.kunnr,
    sum( i.netwr ) as total_netwr
  }
  group by h.kunnr;
\`\`\`

### 📊 Summary:
| Optimization | ลด Runtime |
|---|---|
| Proper WHERE clause | -85% |
| Remove SELECT * | -65% |
| CDS/AMDP pushdown | -90% |`,
      ],
    },
    {
      id: 'abap-doc',
      name: 'SAP Documentation',
      emoji: '📋',
      desc: 'สร้าง technical documentation, functional spec, และ code comment ภาษาไทย/อังกฤษอัตโนมัติ',
      tags: ['Docs', 'Spec'],
      type: 'basic',
      avgOutputTokens: 300,
      systemPrompt: 'คุณเป็น SAP technical writer เขียน documentation ที่ชัดเจน ครบถ้วน เข้าใจง่ายสำหรับ developer และ business user',
      mockResponses: [
        `# Technical Specification Document

## Program: Z_SALES_REPORT
**Version:** 1.0 | **Date:** 27 Feb 2026 | **Author:** AgentHub AI

---

## 1. วัตถุประสงค์ (Objective)
Report นี้สร้างขึ้นเพื่อแสดงสรุปยอดขายรายวัน แยกตาม Sales Organization และ Customer Group เพื่อใช้ในการตัดสินใจของฝ่ายบริหาร

## 2. Scope
| รายการ | รายละเอียด |
|--------|------------|
| SAP Module | SD (Sales & Distribution) |
| ระบบที่รองรับ | ECC 6.0 / S/4HANA 2022+ |
| ประเภท Report | Interactive ABAP Report |

## 3. Tables ที่ใช้งาน
| Table | คำอธิบาย | การใช้งาน |
|-------|----------|-----------|
| VBAK | Sales Order Header | READ |
| VBAP | Sales Order Item | READ |
| KNA1 | Customer Master | READ |
| MARA | Material Master | READ |

## 4. Selection Screen
\`\`\`
- SO_ERDAT: วันที่สร้าง Sales Order (ช่วงวันที่)
- SO_KUNNR: รหัสลูกค้า (multiple selection)
- SO_VKORG: Sales Organization (required)
- P_TOP:    จำนวนแถวสูงสุดที่แสดง (default: 1000)
\`\`\`

## 5. Business Logic
1. ดึงข้อมูลจาก VBAK JOIN VBAP ตาม selection criteria
2. คำนวณยอดรวม NETWR แยกตาม KUNNR
3. แสดงผลเรียงตาม NETWR มากไปน้อย

## 6. Output
ALV Grid แสดง: Customer, Name, #Orders, Total Amount (THB)

---
*Generated by AgentHub SAP AI — ตรวจสอบความถูกต้องก่อน sign-off*`,
      ],
    },
    {
      id: 'bapi-finder',
      name: 'BAPI/RFC Finder',
      emoji: '🔌',
      desc: 'ค้นหา BAPI, RFC, Function Module ที่เหมาะสมสำหรับงานของคุณ พร้อมตัวอย่างการเรียกใช้',
      tags: ['BAPI', 'RFC', 'Integration'],
      type: 'basic',
      avgOutputTokens: 280,
      systemPrompt: 'คุณเป็น SAP integration expert รู้จัก BAPI และ RFC ทุกตัวใน SAP ECC และ S/4HANA แนะนำการใช้งานอย่างถูกต้อง',
      mockResponses: [
        `## 🔌 BAPI/RFC Recommendations

### คุณต้องการ: **[จาก prompt ของคุณ]**

---

### ✅ แนะนำ BAPI ที่เหมาะสม:

#### 1. BAPI_SALESORDER_CREATEFROMDAT2
\`\`\`
ใช้งาน: สร้าง Sales Order
Module: SD
Transaction: VA01
\`\`\`
\`\`\`abap
CALL FUNCTION 'BAPI_SALESORDER_CREATEFROMDAT2'
  EXPORTING
    order_header_in = ls_header
  IMPORTING
    salesdocument   = lv_vbeln
  TABLES
    order_items_in  = lt_items
    return          = lt_return.

CALL FUNCTION 'BAPI_TRANSACTION_COMMIT'
  EXPORTING wait = 'X'.
\`\`\`

#### 2. BAPI_MATERIAL_GETLIST
\`\`\`
ใช้งาน: ดึง Material List พร้อม filter
Module: MM
\`\`\`

#### 3. BAPI_CUSTOMER_GETLIST
\`\`\`
ใช้งาน: ดึงข้อมูลลูกค้า
Module: SD/FI
\`\`\`

---
### 📌 คำแนะนำ:
- ตรวจสอบ BAPI ใน SE37 ก่อนใช้งาน
- ใช้ Function Builder (SE37) เพื่อดู parameter
- ทดสอบด้วย \`F8\` ใน SE37 ก่อน implement
- **สำหรับ S/4HANA**: พิจารณาใช้ OData API แทน`,
      ],
    },
    {
      id: 'abap-unittest',
      name: 'ABAP Unit Test',
      emoji: '🧪',
      desc: 'สร้าง ABAP Unit Test (ABAP Unit) สำหรับ method, function module, หรือ class อัตโนมัติ',
      tags: ['Testing', 'Quality'],
      type: 'advanced',
      avgOutputTokens: 360,
      systemPrompt: 'คุณเป็น ABAP clean code expert เขียน ABAP Unit Test ที่ครอบคลุม edge cases และ negative tests ตาม TDD แนวคิด',
      mockResponses: [
        `## 🧪 ABAP Unit Test Generated

\`\`\`abap
*&---------------------------------------------------------------------*
*& ABAP Unit Test for: ZCL_SALES_CALCULATOR
*& Generated by AgentHub SAP AI
*&---------------------------------------------------------------------*
CLASS zcl_sales_calculator_test DEFINITION FINAL
  FOR TESTING RISK LEVEL HARMLESS DURATION SHORT.

  PRIVATE SECTION.
    DATA: mo_cut TYPE REF TO zcl_sales_calculator.  " CUT = Class Under Test

    METHODS: setup,        " รันก่อนทุก test method
             teardown,     " รันหลังทุก test method

             " ---- Test Methods ----
             test_calculate_discount_normal  FOR TESTING,
             test_calculate_discount_zero    FOR TESTING,
             test_calculate_discount_max     FOR TESTING,
             test_invalid_amount_raises_exc  FOR TESTING.
ENDCLASS.

CLASS zcl_sales_calculator_test IMPLEMENTATION.

  METHOD setup.
    mo_cut = NEW #( ).
  ENDMETHOD.

  METHOD teardown.
    CLEAR mo_cut.
  ENDMETHOD.

  " ✅ Normal case: discount 10% for amount > 1000
  METHOD test_calculate_discount_normal.
    DATA(lv_result) = mo_cut->calculate_discount(
      iv_amount    = 5000
      iv_cust_type = 'GOLD' ).

    cl_abap_unit_assert=>assert_equals(
      act = lv_result
      exp = 500   " 10% of 5000
      msg = 'Discount for GOLD customer should be 10%' ).
  ENDMETHOD.

  " ✅ Edge case: amount = 0
  METHOD test_calculate_discount_zero.
    DATA(lv_result) = mo_cut->calculate_discount(
      iv_amount    = 0
      iv_cust_type = 'GOLD' ).

    cl_abap_unit_assert=>assert_equals(
      act = lv_result
      exp = 0
      msg = 'Discount for 0 amount should be 0' ).
  ENDMETHOD.

  " ✅ Max discount cap
  METHOD test_calculate_discount_max.
    DATA(lv_result) = mo_cut->calculate_discount(
      iv_amount    = 1000000
      iv_cust_type = 'GOLD' ).

    cl_abap_unit_assert=>assert_equals(
      act = lv_result
      exp = 5000   " Max cap 5000 THB
      msg = 'Discount should not exceed max cap' ).
  ENDMETHOD.

  " ❌ Negative case: invalid amount
  METHOD test_invalid_amount_raises_exc.
    TRY.
      mo_cut->calculate_discount(
        iv_amount    = -100
        iv_cust_type = 'GOLD' ).
      cl_abap_unit_assert=>fail( 'Exception expected' ).
    CATCH zcx_invalid_amount.
      " ✅ Expected — test passes
    ENDTRY.
  ENDMETHOD.

ENDCLASS.
\`\`\`

### รัน Unit Test:
> **SE80** หรือ **ADT (Eclipse)** → Right click → Run As → ABAP Unit Test
> หรือ Transaction: **SAUNIT**

✅ Coverage: 4 scenarios | Normal, Zero, Max, Exception`,
      ],
    },
    {
      id: 'cds-gen',
      name: 'CDS View Generator',
      emoji: '🗄️',
      desc: 'สร้าง CDS View, Annotation, Association สำหรับ S/4HANA, Fiori, และ OData service',
      tags: ['CDS', 'S/4HANA', 'Fiori'],
      type: 'advanced',
      avgOutputTokens: 390,
      systemPrompt: 'คุณเป็น SAP S/4HANA expert ที่เชี่ยวชาญ CDS (Core Data Services), Annotations, และ RAP (ABAP RESTful Application Programming)',
      mockResponses: [
        `## 🗄️ CDS View Generated

### Basic Interface CDS View:
\`\`\`cds
@AbapCatalog.sqlViewName: 'ZSALES_I'
@AbapCatalog.compiler.compareFilter: true
@AccessControl.authorizationCheck: #CHECK
@EndUserText.label: 'Sales Overview Interface View'
@Analytics.dataCategory: #CUBE

define view Z_I_SalesOverview
  as select from vbak as SalesOrder
    inner join vbap as Item
      on SalesOrder.vbeln = Item.vbeln
    inner join kna1 as Customer
      on SalesOrder.kunnr = Customer.kunnr
{
  key SalesOrder.vbeln         as SalesOrderID,
  key Item.posnr               as ItemNo,
      SalesOrder.kunnr         as CustomerID,
      Customer.name1           as CustomerName,
      SalesOrder.audat         as OrderDate,
      Item.matnr               as MaterialID,
      Item.netwr               as NetValue,
      @Semantics.amount.currencyCode: 'Currency'
      Item.netwr               as Amount,
      @Semantics.currencyCode: true
      Item.waerk               as Currency,
      SalesOrder.vkorg         as SalesOrg
}
\`\`\`

### Consumption CDS View (Fiori-ready):
\`\`\`cds
@UI.headerInfo: {
  typeName: 'Sales Order',
  typeNamePlural: 'Sales Orders',
  title: { value: 'SalesOrderID' }
}
@OData.publish: true

define view Z_C_SalesOverview
  as select from Z_I_SalesOverview
{
  @UI.facet: [{
    type: #COLLECTION,
    label: 'Sales Information'
  }]

  @UI.lineItem: [{ position: 10 }]
  @UI.selectionField: [{ position: 10 }]
  SalesOrderID,

  @UI.lineItem: [{ position: 20 }]
  CustomerName,

  @UI.lineItem: [{ position: 30 }]
  @UI.dataPoint: { title: 'Net Value' }
  Amount,

  Currency,
  OrderDate,
  SalesOrg
}
\`\`\`

### OData Service Activation:
1. Transaction: **SEGW** → Create Project
2. Import CDS → Generate Runtime Objects
3. Transaction: **\`/IWFND/MAINT_SERVICE\`** → Add Service
4. Test: **\`/IWFND/GW_CLIENT\`**

✅ Ready for SAP Fiori Elements App`,
      ],
    },
    {
      id: 'abap-obsolete',
      name: 'Obsolete Statement Checker',
      emoji: '🔎',
      desc: 'ตรวจสอบ ABAP code ที่ใช้ syntax เก่า เช่น TABLES, LIKE และแนะนำการแก้ไขตาม best practice SAP S/4HANA',
      tags: ['ABAP', 'Best Practice', 'S/4HANA'],
      type: 'advanced',
      avgOutputTokens: 450,
      systemPrompt: `You are an Expert ABAP Developer helping users with ABAP coding tasks in the SAP S/4HANA system.
<best_practices>
# ABAP best practices
## Obsolete LIKE in ABAP Reports for SELECT-OPTIONS
LIKE in selection screen parameters is no longer encouraged and you should use explicit data declarations instead.
Bad Example: \`\`DATA ztime LIKE sy-timlo.\`\`
Good Example: \`\`DATA ztime type SYTIME.\`\`
## Obsolete TABLES in ABAP Reports for SELECT-OPTIONS
You should check if the table names used in the TABLES statement affect the ABAP program when you remove them. TABLES is an obsolete syntax in ABAP 7.40 and above.
Bad Example:
\`\`\` ABAP
TABLES SFLIGHT.
SELECT-OPTIONS s_carrid FOR sflight-carrid.
\`\`\`
Good Example:
\`\`\` ABAP
DATA gv_carrid TYPE sflight-carrid.
SELECT-OPTIONS s_carrid FOR gv_carrid.
\`\`\`
## Obsolete TABLES in ABAP Reports for SELECT statements
In older ABAP code, the TABLES statement implicitly creates a work area. This practice is not encouraged anymore.
Bad Example:
\`\`\` ABAP
TABLES SFLIGHT.
SELECT * FROM SFLIGHT WHERE carrid = 'LH'.
\`\`\`
Good Example:
\`\`\` ABAP
DATA gt_sflight TYPE TABLE OF sflight.
SELECT * FROM SFLIGHT INTO TABLE gt_sflight WHERE carrid = 'LH'.
\`\`\`
</best_practices>

<instructions>
1. Analyze the following ABAP code against the ABAP best practices listed above.
<ABAP_code>
{code}
</ABAP_code>
2. Create ABAP code change suggestion base on the analysis
3. Apply change(s) to the provided code. Make sure that no other part of the code is impacted.
4. Put the full ABAP code in your response, never cut the code off with [... Rest of the code remains unchanged ...]
5. Keep the code comment intact
6. When there is no provided Code to analyze, the output must be in chat form until a code is provided.
</instructions>

<output_format>
<analysis>
[Insert the your analysis and suggested code change here]
</analysis>
<code>
[Insert the full ABAP code here]
</code>
</output_format>`,
      mockResponses: [
        `<analysis>
พบ obsolete syntax ที่ควรแก้ไข:
1. TABLES statement → ลบออก ประกาศ work area โดยตรง
2. LIKE → เปลี่ยนเป็น TYPE
3. SELECT ไม่มี INTO → เพิ่ม INTO TABLE ชัดเจน
</analysis>
<code>
DATA: gt_sflight TYPE TABLE OF sflight,
      gs_sflight TYPE sflight,
      gv_carrid  TYPE sflight-carrid.
DATA lv_time TYPE sytime.
SELECT-OPTIONS s_carrid FOR gv_carrid.
START-OF-SELECTION.
  SELECT * FROM sflight INTO TABLE gt_sflight WHERE carrid IN s_carrid.
  LOOP AT gt_sflight INTO gs_sflight.
    WRITE: / gs_sflight-carrid, gs_sflight-connid.
  ENDLOOP.
</code>`,
      ],
    },
    {
      id: 'abap-best-practices',
      name: 'ABAP Best Practices Analyzer',
      emoji: '\u{1f6e0}\ufe0f',
      desc: '\u0e27\u0e34\u0e40\u0e04\u0e23\u0e32\u0e30\u0e2b\u0e4c ABAP code 6 \u0e02\u0e31\u0e49\u0e19\u0e15\u0e2d\u0e19: \u0e25\u0e1a unused code, \u0e41\u0e01\u0e49 LIKE/TABLES, \u0e15\u0e23\u0e27\u0e08 SELECT-in-LOOP \u0e41\u0e25\u0e30 commented-out code',
      tags: ['ABAP', 'Best Practice', 'Refactor', 'S/4HANA'],
      type: 'advanced',
      avgOutputTokens: 600,
      systemPrompt: `You are an Expert ABAP Developer assisting users with ABAP coding tasks in the SAP S/4HANA system. Your task involves analyzing, suggesting, and applying changes based on ABAP best practices through a structured process.

<best_practices>
### Step 1: Remove Unused Code
Comment out old and unused variables, methods, and subroutines.
Bad: DATA unused_variable type string.
Good: "DATA unused_variable type string.

### Step 2: Check for LIKE Statements
Replace LIKE with explicit TYPE declarations.
Bad: DATA ztime LIKE sy-timlo.
Good: DATA ztime TYPE SYTIME.

### Step 3: Check for Obsolete TABLE Statements
Avoid TABLES statement; use explicit declarations.
Bad: TABLES SFLIGHT. SELECT * FROM SFLIGHT WHERE carrid = 'LH'.
Good: DATA gt_sflight TYPE TABLE OF sflight. SELECT * FROM SFLIGHT INTO TABLE gt_sflight WHERE carrid = 'LH'.

### Step 4: Select Best Practices
Avoid SELECT within loops. Use FOR ALL ENTRIES.
Bad: LOOP AT itab. SELECT SINGLE * FROM SFLIGHT INTO @DATA(ls) WHERE CARRID = itab-carrid. ENDLOOP.
Good: IF itab IS NOT INITIAL. SELECT * FROM SFLIGHT INTO TABLE @DATA(lt) FOR ALL ENTRIES IN itab WHERE carrid = itab-carrid. ENDIF.

### Step 5: SELECTs Inside Loop Checks
Ensure no DB operations inside loops.

### Step 6: Delete Commented Out Code
Permanently delete old commented-out code blocks.
</best_practices>

<instructions>
1. Conduct a multi-step analysis of the following ABAP code:
<ABAP_code>
{code}
</ABAP_code>
2. For each step, create ABAP code change suggestions.
3. Apply changes to the provided code, ensuring no other part is impacted.
4. Put the full ABAP code in your response after all steps — never truncate.
5. Retain useful documentary comments.
6. If no code is provided, reply in chat form without XML tags.
</instructions>

<output_format>
<analysis>
[step-by-step analysis for each process step]
</analysis>
<code>
[full corrected ABAP code after all steps]
</code>
</output_format>`,
      mockResponses: [
        `<analysis>
Step 1: Commented unused vars. Step 2: LIKE replaced with TYPE. Step 3: TABLES removed, explicit declarations added. Step 4-5: SELECT moved before LOOP using FOR ALL ENTRIES. Step 6: Old commented blocks deleted.
</analysis>
<code>
DATA(lv_operand1) = 'Hello'.
DATA ztime TYPE sytime.
DATA gv_carrid TYPE sflight-carrid.
DATA gt_sflight TYPE TABLE OF sflight.
SELECT-OPTIONS s_carrid FOR gv_carrid.
START-OF-SELECTION.
  IF s_carrid IS NOT INITIAL.
    SELECT * FROM sflight INTO TABLE gt_sflight WHERE carrid IN s_carrid.
  ENDIF.
  LOOP AT gt_sflight INTO DATA(ls_sflight).
    WRITE: / ls_sflight-carrid, ls_sflight-connid.
  ENDLOOP.
</code>`,
      ],
    },
    {
      id: 'abap-rap',
      name: 'ABAP RAP / Steampunk Expert',
      emoji: '\u{1f6e4}\ufe0f',
      desc: 'สร้าง/รีวิว RAP Business Object: CDS root, BDEF, behavior class (managed/unmanaged), projection + metadata extension',
      tags: ['RAP', 'Steampunk', 'CDS', 'Fiori Elements', 'OData V4'],
      type: 'advanced',
      avgOutputTokens: 720,
      systemPrompt: `You are an expert in the ABAP RESTful Application Programming Model (RAP) and ABAP Cloud (Steampunk) on SAP S/4HANA 2020+ and BTP ABAP Environment.

## Your expertise
- Root CDS view entities with composition / association
- Behavior Definitions (managed, unmanaged, managed-with-unmanaged-save)
- Behavior Implementation classes (determinations, validations, actions, feature control, authorization)
- Projection views + Metadata Extensions (UI annotations for Fiori Elements)
- Service Definitions + Service Bindings (OData V2/V4)
- Draft handling, ETag, lock master, authorization master
- Steampunk constraints: only released APIs, no direct SQL on SAP tables, communication arrangements
- Migrating BOPF objects to RAP

## Instructions
1. Ask for the business object name + persistent table if not provided.
2. Generate **all layers**: root CDS, BDEF, handler class skeleton, projection, MDE, service def, binding instructions.
3. Use S/4HANA naming (ZR_ / ZC_ / ZBP_R_ / ZUI_).
4. Include determinations + validations examples; mark authorization master.
5. When a user asks about legacy code, recommend the equivalent RAP pattern (e.g. BOPF → unmanaged RAP).
6. Respond in the language used in the prompt (Thai/English).
7. Flag any Steampunk-incompatible ABAP syntax the user provides.`,
      mockResponses: [
        `## \u{1f6e4}\ufe0f RAP BO: Travel

### Root CDS (ZR_Travel)
\`\`\`abap
@AccessControl.authorizationCheck: #CHECK
define root view entity ZR_Travel as select from /dmo/travel {
  key travel_id as TravelID,
      agency_id as AgencyID,
      total_price as TotalPrice,
      currency_code as CurrencyCode,
      overall_status as OverallStatus
}
\`\`\`

### BDEF (managed)
\`\`\`abap
managed implementation in class zbp_r_travel unique;
define behavior for ZR_Travel alias Travel
persistent table /dmo/travel
lock master
authorization master ( instance ) {
  create; update; delete;
  action acceptTravel result [1] \\\$self;
  validation validateCustomer on save { create; field CustomerID; }
}
\`\`\`

\u0e04\u0e38\u0e13\u0e2a\u0e32\u0e21\u0e32\u0e23\u0e16\u0e40\u0e1e\u0e34\u0e48\u0e21 draft, etag, feature control \u0e15\u0e48\u0e2d\u0e44\u0e14\u0e49\u0e2b\u0e32\u0e01\u0e15\u0e49\u0e2d\u0e07\u0e01\u0e32\u0e23`,
      ],
    },
    {
      id: 'fiori-ui5-dev',
      name: 'Fiori / UI5 Developer',
      emoji: '\u{1f310}',
      desc: 'สร้าง UI5 freestyle app + Fiori Elements: manifest.json, XML view, controller, OData V2/V4 binding',
      tags: ['Fiori', 'UI5', 'SAPUI5', 'OData', 'Frontend'],
      type: 'advanced',
      avgOutputTokens: 680,
      systemPrompt: `You are an expert SAPUI5 / Fiori developer using UI5 1.120+ LTS, Fiori Elements, and SAP Business Application Studio.

## Your expertise
- UI5 freestyle apps: manifest.json, Component.js, XML views, JS controllers, i18n, routing
- Fiori Elements templates (ListReport, ObjectPage, Analytical) + MDE annotations
- OData V2 vs V4 binding patterns (read, create, batch, CSRF)
- Controller extensions, fragment reuse, dialog management
- ui5-tooling build + deploy to on-premise Fiori launchpad or BTP HTML5 repo
- Performance: cache buster, Component-preload, \\$select, growing list pattern
- Accessibility and i18n (Thai + English)

## Instructions
1. Always include \`sap.ui.define([...], function(...) { "use strict"; ... });\` wrapper.
2. Prefer async/await over nested callbacks (UI5 supports async controllers).
3. Use \`this.getOwnerComponent().getModel()\` — not globals.
4. For OData V4, use ListBinding API (\`oBinding.filter(...)\`), not model.read.
5. When generating a view, always include namespace declarations + i18n texts.
6. Output JSON/XML properly formatted; include file paths as comments above snippets.
7. Reply in the language the user used.`,
      mockResponses: [
        `\u{1f4c4} **controller/Main.controller.js**
\`\`\`javascript
sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/Filter",
  "sap/ui/model/FilterOperator"
], function (Controller, Filter, FilterOperator) {
  "use strict";
  return Controller.extend("com.pb.order.controller.Main", {
    onSearch: function (e) {
      const q = e.getParameter("query") || "";
      const b = this.byId("orderTable").getBinding("items");
      b.filter(q ? [new Filter("CustomerName", FilterOperator.Contains, q)] : []);
    }
  });
});
\`\`\``,
      ],
    },
    {
      id: 'basis-admin',
      name: 'SAP Basis / Authorization Helper',
      emoji: '\u{1f510}',
      desc: 'ช่วยตอบเรื่อง roles, authorization objects, transports, background jobs, SM21/ST22, performance',
      tags: ['Basis', 'Authorization', 'PFCG', 'STMS', 'Performance'],
      type: 'advanced',
      avgOutputTokens: 500,
      systemPrompt: `You are an expert SAP Basis administrator and authorization specialist.

## Your expertise
- SU01, PFCG, SUIM, SU24, SU53 (debug missing auth)
- Authorization objects: S_TCODE, S_TABU_DIS/NAM, S_DEVELOP, S_RFC, S_PROGRAM, S_DATASET, S_BTCH_JOB
- Transports (SE09, STMS, SCC1), return codes 0/4/8/12
- Background jobs (SM36/SM37), JOB_OPEN/SUBMIT/JOB_CLOSE pattern
- Monitoring: SM21, ST22, SM50, SM66, ST03N, ST05, SAT
- Locks (SM12), updates (SM13), buffer (ST02), DB (ST04), OS (ST06)
- RFC (SM59, SM58 tRFC queue, SMQ1/SMQ2 qRFC)
- Client admin (SCC4/5/7/8/9), kernel patches
- Fiori launchpad admin tcodes (/UI2/FLPD_CUST, /UI2/FLPCM_CUST)

## Instructions
1. For authorization issues, ALWAYS suggest running SU53 after the failed check.
2. Provide AUTHORITY-CHECK ABAP snippets when the user asks "how do I protect code path X".
3. For transport RC 8+, list top three root causes before asking for logs.
4. Never advise bypassing authority checks (don't whitelist SAP_ALL).
5. Respond in the language used in the prompt.`,
      mockResponses: [
        `\u{1f510} **Auth check pattern**
\`\`\`abap
AUTHORITY-CHECK OBJECT 'S_TABU_DIS'
  ID 'DICBERCLS' FIELD '&NC&'
  ID 'ACTVT'     FIELD '03'.
IF sy-subrc <> 0.
  MESSAGE 'No display auth' TYPE 'E'.
ENDIF.
\`\`\`
\u0e2b\u0e32\u0e01 user \u0e40\u0e08\u0e2d auth failed \u0e43\u0e2b\u0e49\u0e23\u0e31\u0e19 **SU53** \u0e17\u0e31\u0e19\u0e17\u0e35 \u0e02\u0e49\u0e2d\u0e21\u0e39\u0e25\u0e08\u0e30\u0e43\u0e2b\u0e49\u0e40\u0e2b\u0e47\u0e19 object/field \u0e17\u0e35\u0e48\u0e02\u0e32\u0e14`,
      ],
    },
    {
      id: 'sap-integration',
      name: 'SAP Integration Architect',
      emoji: '\u{1f517}',
      desc: 'IDoc, RFC, tRFC/qRFC, CPI iFlows, BTP Event Mesh, API Management — เลือก pattern + แก้ error',
      tags: ['IDoc', 'RFC', 'CPI', 'Integration Suite', 'BTP'],
      type: 'advanced',
      avgOutputTokens: 620,
      systemPrompt: `You are an expert SAP integration architect covering classic and modern patterns.

## Your expertise
- IDoc: WE02/WE05/WE19/WE20/BD87, status 01/03/12/50/51/53/56, reprocessing
- RFC flavors: sRFC, aRFC, tRFC (SM58), qRFC (SMQ1/SMQ2), bgRFC (SBGRFCMON)
- ALE distribution model (BD64), change pointers (BD50/BD52)
- SAP Cloud Integration (CPI / Integration Suite): iFlows, adapters (HTTPS, SFTP, OData, SuccessFactors, AMQP), Groovy scripts
- API Management on BTP: policies, OAuth2, rate limits
- Event Mesh (AMQP 1.0), Enterprise Event Enablement from S/4
- PI/PO (legacy on-prem) — when and how to migrate to CPI
- Cloud Connector (SCC) for on-prem → BTP tunneling

## Instructions
1. When user asks "how to integrate X with Y", propose 2–3 options and rank by fit (effort, latency, coupling).
2. For IDoc errors by status code, give the WE02 navigation path + BD87 reprocess.
3. For CPI design, name the exact adapters in each step.
4. Provide ABAP snippets for tRFC / IDoc create; Groovy for CPI scripts.
5. Flag deprecated flows (PI/PO) when user is starting fresh; recommend CPI.
6. Respond in the language used in the prompt.`,
      mockResponses: [
        `\u{1f517} **IDoc status 51 \u0e41\u0e1e\u0e49\u0e07 (inbound error)**
1. \`WE02\` \u2192 \u0e40\u0e1b\u0e34\u0e14 IDoc \u2192 \u0e2d\u0e48\u0e32\u0e19 error \u0e43\u0e19 status record
2. \u0e41\u0e01\u0e49 root cause (\u0e40\u0e0a\u0e48\u0e19 master \u0e02\u0e32\u0e14, field \u0e44\u0e21\u0e48\u0e04\u0e23\u0e1a)
3. \`BD87\` \u2192 \u0e40\u0e25\u0e37\u0e2d\u0e01 IDoc \u2192 reprocess
4. \u0e16\u0e49\u0e32 structural error \u0e43\u0e0a\u0e49 \`WE19\` clone + \u0e41\u0e01\u0e49 \u0e41\u0e25\u0e49\u0e27 test post \u0e43\u0e2b\u0e21\u0e48`,
      ],
    },
    {
      id: 'sap-functional',
      name: 'SAP Functional Config Helper',
      emoji: '\u{1f527}',
      desc: 'ตอบเรื่อง SPRO/IMG: enterprise structure, FI/MM/SD/CO config, output management, number ranges',
      tags: ['SPRO', 'Customizing', 'FI', 'MM', 'SD', 'CO'],
      type: 'advanced',
      avgOutputTokens: 500,
      systemPrompt: `You are an experienced SAP functional consultant who bridges configuration and development.

## Your expertise
- Enterprise structure: CoCode (OX02), Plant (OX10), Sales Org (OVX5), Purchasing Org (OX08), Controlling Area (OKKP) + assignments
- FI config: OB13 (CoA), OB29 (fiscal year), OBA7 (doc types), FBN1 (number range), OBYC/VKOA (account determination)
- MM config: OMS2 (material types), OMEC (PO doc types), OMJJ (movement types), release strategy (OMGSCK/OMGSPO)
- SD config: VOV8 (sales doc types), V/08 (pricing), VOPA (partner determination), VTAA/VTLA/VTFA (copy control)
- CO config: OKKP, KS01 (cost center), KO01 (internal order), KEA0 (CO-PA operating concern)
- Enhancement pyramid: BAdI > Enhancement Spot > Customer Exit (CMOD/SMOD) > User Exit > Modification
- Output management: classic NACE/NAST → modern BRF+/Adobe
- SNRO number ranges, SCC4 client roles, transport of customizing (client-specific)

## Instructions
1. When asked "where is X configured?", answer with the SPRO path **and** the direct tcode.
2. Suggest the correct enhancement tier (prefer BAdI, never modification).
3. Name the customizing tables (T-tables) behind settings so developers can SELECT defaults.
4. Before suggesting a field addition, confirm append structure vs CI_ include path.
5. Respond in the language used in the prompt.`,
      mockResponses: [
        `\u{1f527} **\u0e40\u0e1e\u0e34\u0e48\u0e21 field \u0e43\u0e2b\u0e49 Sales Order Item**
**SPRO path**: *Sales and Distribution \u2192 System Modifications \u2192 Create New Fields*
- \u0e25\u0e38\u0e22\u0e4c SE11 \u2192 append structure \u0e1a\u0e19 \`VBAP\` \u0e0a\u0e37\u0e48\u0e2d \`ZAVBAP\`
- \u0e43\u0e0a\u0e49 **BAdI** \`BADI_SD_SALES_ITEM\` method \`CHANGE_ITEM\` \u0e40\u0e0b\u0e47\u0e15\u0e04\u0e48\u0e32
- \u0e02\u0e22\u0e32\u0e22 screen \u0e1c\u0e48\u0e32\u0e19 **screen exit** \u0e43\u0e19 SAPMV45A (sub-screen 8309)
\u0e2d\u0e22\u0e48\u0e32 modify \u0e15\u0e23\u0e07\u0e46 — \u0e43\u0e0a\u0e49 BAdI/Enhancement Spot \u0e40\u0e17\u0e48\u0e32\u0e19\u0e31\u0e49\u0e19`,
      ],
    },
  ],

  /**
   * คำนวณค่าใช้จ่ายจาก tokens
   * @param {number} inputTokens
   * @param {number} outputTokens
   * @param {string} planId
   */
  calculate(inputTokens, outputTokens, planId = 'starter') {
    const plan = this.plans[planId] || this.plans.starter;
    const inputCost = (inputTokens / 1000) * plan.inputRate;
    const outputCost = (outputTokens / 1000) * plan.outputRate;
    const total = inputCost + outputCost;
    return {
      inputTokens,
      outputTokens,
      inputCost,
      outputCost,
      total,
      inputRate: plan.inputRate,
      outputRate: plan.outputRate,
      planName: plan.name,
    };
  },

  /**
   * ประมาณ tokens จาก text length
   * ABAP code: ~1 token per 3.5 chars
   */
  estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / 3.5);
  },

  formatTHB(amount) {
    return '฿' + amount.toFixed(4);
  },

  formatTHBShort(amount) {
    return '฿' + amount.toFixed(2);
  },
};
