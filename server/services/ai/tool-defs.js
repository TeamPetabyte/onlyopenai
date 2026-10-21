// tool-defs.js — นิยาม tool + system instructions (pure data)

// Tool definitions (function calling)
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
            description: 'ตรวจ ABAP code ด้วย parser จริง (abaplint) ตาม target release ของ project: syntax, ตัวแปรที่ไม่ได้ประกาศ, type ที่ไม่รู้จัก, และ obsolete statements. เรียกกับโค้ดทั้งไฟล์ก่อนส่งคำตอบทุกครั้ง',
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


module.exports = { PHASE4_TOOLS };
