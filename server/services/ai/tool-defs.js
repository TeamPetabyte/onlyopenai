// tool-defs.js — นิยาม tool + system instructions (pure data)

// ── Phase 4: Tool Definitions (Joule-style Function Calling) ──
const PHASE4_TOOLS = [
    { type: 'file_search' },
    {
        type: 'function',
        function: {
            name: 'find_bapi',
            description: 'ค้นหา BAPI หรือ Function Module ที่เหมาะสมสำหรับงาน SAP ที่ต้องการ',
            parameters: {
                type: 'object',
                properties: {
                    task:   { type: 'string', description: 'งานที่ต้องการทำ เช่น "post goods movement", "create sales order"' },
                    module: { type: 'string', description: 'SAP module เช่น MM, SD, FI, HR (optional)' },
                },
                required: ['task'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'check_abap_syntax',
            description: 'ตรวจสอบ syntax และ obsolete statements ใน ABAP code',
            parameters: {
                type: 'object',
                properties: {
                    code: { type: 'string', description: 'ABAP source code ที่ต้องการตรวจสอบ' },
                },
                required: ['code'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_transaction_info',
            description: 'ดูข้อมูลและคำอธิบายของ SAP Transaction Code',
            parameters: {
                type: 'object',
                properties: {
                    tcode: { type: 'string', description: 'SAP Transaction Code เช่น SE38, SM30, ST22' },
                },
                required: ['tcode'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'search_s4_migration',
            description: 'ค้นหาข้อมูลการ migrate จาก SAP ECC ไป S/4HANA เช่น table changes, custom code adaptation',
            parameters: {
                type: 'object',
                properties: {
                    topic: { type: 'string', description: 'หัวข้อที่ต้องการ เช่น "BSEG", "custom code", "table changes", "HANA"' },
                },
                required: ['topic'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_best_practice',
            description: 'ดึง ABAP best practices สำหรับหัวข้อที่ต้องการ เช่น performance, naming, error handling',
            parameters: {
                type: 'object',
                properties: {
                    topic: { type: 'string', description: 'หัวข้อ เช่น "SELECT performance", "error handling", "naming convention", "OO"' },
                },
                required: ['topic'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'explain_abap_dump',
            description: 'วิเคราะห์ ABAP runtime error หรือ short dump จาก ST22',
            parameters: {
                type: 'object',
                properties: {
                    error_type: { type: 'string', description: 'ประเภท error เช่น "RAISE_EXCEPTION", "DBIF_RSQL_SQL_ERROR", "DYNPRO_SEND_IN_BACKGROUND"' },
                    context:    { type: 'string', description: 'code หรือ context ที่เกิด error (optional)' },
                },
                required: ['error_type'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'lookup_auth_object',
            description: 'ค้นหาข้อมูล SAP authorization object สำหรับการออกแบบ role ใน PFCG หรือใส่ AUTHORITY-CHECK ใน ABAP — บอก fields, ACTVT values และ use case',
            parameters: {
                type: 'object',
                properties: {
                    object: { type: 'string', description: 'ชื่อ authorization object เช่น "S_TABU_DIS", "S_DEVELOP", "S_TCODE", "S_RFC", "S_BTCH_JOB", "S_DATASET"' },
                    intent: { type: 'string', description: '(optional) สิ่งที่ต้องการทำ เช่น "protect custom table", "restrict program execution"' },
                },
                required: ['object'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'explain_tcode_config',
            description: 'อธิบายว่า T-code ของ SAP ทำงานที่ไหนใน SPRO, เกี่ยวข้องกับ config tables อะไร, และมี enhancement point (BAdI / User Exit) ที่แนะนำ',
            parameters: {
                type: 'object',
                properties: {
                    tcode:  { type: 'string', description: 'SAP Transaction Code เช่น "VA01", "ME21N", "MIGO", "FBN1", "OBYC"' },
                    module: { type: 'string', description: '(optional) SAP module เพื่อช่วย disambiguate เช่น "SD", "MM", "FI", "CO"' },
                },
                required: ['tcode'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'search_knowledge',
            description: 'ค้นหาเนื้อหาจาก SAP knowledge base ทั้งหมด (เอกสาร คู่มือ training material เช่น BC430 ABAP Dictionary และไฟล์ที่องค์กรอัพโหลดไว้) — ใช้เมื่อคำถามน่าจะมีคำตอบในเอกสาร หรือเมื่อ tool เฉพาะทางตัวอื่นไม่ครอบคลุมหัวข้อนั้น',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'ข้อความค้นหา — คำถามหรือหัวข้อที่ต้องการหาในเอกสาร (ภาษาอังกฤษได้ผลดีสุดเพราะเอกสารส่วนใหญ่เป็นภาษาอังกฤษ)' },
                },
                required: ['query'],
            },
        },
    },
];


const ASSISTANT_INSTRUCTIONS = `You are PipekAI, an Expert SAP/ABAP AI Assistant for the SAP S/4HANA system.
You have memory of the entire conversation in this thread — use it to give contextual, accurate answers.

## Your capabilities:
- ABAP Code Generation: reports, classes, function modules, BAPI calls
- Code Review & Best Practices: performance, obsolete syntax, error handling
- Obsolete Statement Detection: TABLES, LIKE, implicit SELECT
- Performance Optimization: SELECT-in-LOOP, full table scan, HANA pushdown
- Error Analysis: ABAP dumps, ST22, runtime exceptions
- Unit Testing: ABAP Unit Test classes
- CDS Views: Interface and Consumption views for Fiori
- RAP / Steampunk: CDS root + BDEF + behavior class + projection + service binding
- Fiori / SAPUI5: manifest.json, XML view, controller, Fiori Elements, OData V2/V4
- Basis & Authorization: PFCG roles, authorization objects, transports, background jobs, system monitoring
- Integration: IDoc (WE02/WE19/BD87), tRFC/qRFC, CPI / Integration Suite, BTP Event Mesh, API Mgmt
- Functional config: SPRO/IMG navigation for FI/MM/SD/CO, enterprise structure, number ranges, output
- Documentation: technical specs, functional specs, code comments
- BAPI/RFC Finder: suggest the most appropriate function module
- General SAP Q&A: modules, configurations, transactions

## Tools available (call them when they help the answer):
- file_search — retrieve from your SAP knowledge base (17 files covering ABAP, RAP, Basis, Integration, SPRO)
- find_bapi, check_abap_syntax, get_transaction_info
- search_s4_migration, get_best_practice, explain_abap_dump
- lookup_auth_object — canonical info for S_TCODE / S_DEVELOP / S_TABU_* / S_RFC etc.
- explain_tcode_config — SPRO path + config tables + recommended BAdI / User Exit for a T-code

## Instructions:
1. Remember all code and context from previous messages in this thread
2. When user says "fix line 5" or "add error handling" — refer to code from earlier in the conversation
3. Always respond in the same language the user used (Thai or English)
4. Format code blocks properly with language tags
5. Be concise but complete — never truncate important code`;

module.exports = { PHASE4_TOOLS, ASSISTANT_INSTRUCTIONS };
