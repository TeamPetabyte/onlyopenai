// tools.js — tool ฝั่ง server: อ่าน knowledge, ค้น vector store, pre-analysis, Responses loop
const fs_mod   = require('fs');
const path_mod = require('path');
const abapScan = require('../../lib/abap-scan');
const { looksLikeAbapCode, checkAbapSyntax } = abapScan;

module.exports = function createAiTools({ ai }) {
const { HAS_API_KEY, openai, getVectorStoreId, markProjectKeyInvalid, KNOWLEDGE_DIR } = ai;
// Assistants-API chat stack ถูกถอดตั้งแต่ v1.7.2 — Assistants เหลือใช้แค่ RAG/vector store

// ── TOOL EXECUTION ──

/** ค้นหา BAPI/RFC จาก knowledge file */
function findBapi(task, module) {
    try {
        const content = fs_mod.readFileSync(path_mod.join(KNOWLEDGE_DIR, '02_common_bapi_catalog.txt'), 'utf8');
        const taskWords = task.toLowerCase().split(/\s+/);
        const moduleLower = (module || '').toLowerCase();

        // แบ่งเป็น section ตาม BAPI แต่ละตัว (split by ###)
        const sections = content.split('###').filter(s => s.trim());
        const scored = sections.map(s => {
            const lower = s.toLowerCase();
            let score = taskWords.filter(w => w.length > 2 && lower.includes(w)).length;
            if (moduleLower && lower.includes(moduleLower)) score += 2;
            return { score, text: s.trim() };
        }).filter(s => s.score > 0).sort((a, b) => b.score - a.score);

        if (scored.length === 0) return { found: false, message: `ไม่พบ BAPI สำหรับ: "${task}"` };

        return {
            found: true,
            results: scored.slice(0, 3).map(s => {
                const lines = s.text.split('\n');
                return { name: lines[0].trim(), detail: lines.slice(1, 4).join(' ').trim() };
            }),
        };
    } catch (e) {
        return { found: false, error: e.message };
    }
}

/** ตรวจสอบ ABAP syntax และ obsolete patterns */
/** ดูข้อมูล SAP Transaction Code */
function getTransactionInfo(tcode) {
    try {
        const content = fs_mod.readFileSync(path_mod.join(KNOWLEDGE_DIR, '03_sap_transactions.txt'), 'utf8');
        const pattern = new RegExp(`\\|\\s*${tcode.toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\|([^|\\n]+)\\|`, 'i');
        const match   = content.match(pattern);
        if (!match) return { found: false, tcode: tcode.toUpperCase(), message: `ไม่พบข้อมูลสำหรับ T-Code: ${tcode.toUpperCase()}` };
        return { found: true, tcode: tcode.toUpperCase(), description: match[1].trim() };
    } catch (e) {
        return { found: false, error: e.message };
    }
}

/** ค้นหาข้อมูล S/4HANA migration จาก knowledge file */
function searchS4Migration(topic) {
    try {
        const content = fs_mod.readFileSync(path_mod.join(KNOWLEDGE_DIR, '05_s4hana_migration_guide.txt'), 'utf8');
        const words   = topic.toLowerCase().split(/\s+/).filter(w => w.length > 2);
        const lines   = content.split('\n');
        const results = [];
        lines.forEach((line, i) => {
            if (words.some(w => line.toLowerCase().includes(w))) {
                const snippet = lines.slice(i, i + 6).join('\n').trim();
                if (!results.some(r => r.startsWith(snippet.slice(0, 30)))) results.push(snippet);
            }
        });
        if (results.length === 0) return { found: false, message: `ไม่พบข้อมูล migration สำหรับ: "${topic}"` };
        return { found: true, results: results.slice(0, 4) };
    } catch (e) { return { found: false, error: e.message }; }
}

/** ดึง ABAP best practice จาก knowledge file */
function getBestPractice(topic) {
    try {
        const content  = fs_mod.readFileSync(path_mod.join(KNOWLEDGE_DIR, '01_abap_best_practices.txt'), 'utf8');
        const words    = topic.toLowerCase().split(/\s+/).filter(w => w.length > 2);
        const sections = content.split(/\n#{2,3} /);
        const scored   = sections.map(s => ({
            score: words.filter(w => s.toLowerCase().includes(w)).length,
            text:  s.trim(),
        })).filter(s => s.score > 0).sort((a, b) => b.score - a.score);
        if (scored.length === 0) return { found: false, message: `ไม่พบ best practice สำหรับ: "${topic}"` };
        return { found: true, practices: scored.slice(0, 3).map(s => s.text.slice(0, 600)) };
    } catch (e) { return { found: false, error: e.message }; }
}

/** อธิบาย ABAP dump จาก error_patterns knowledge file */
function explainAbapDump(errorType, context) {
    try {
        const content  = fs_mod.readFileSync(path_mod.join(KNOWLEDGE_DIR, '07_abap_error_patterns.txt'), 'utf8');
        const errorUp  = errorType.toUpperCase();
        const lines    = content.split('\n');
        const matchIdx = lines.findIndex(l => l.toUpperCase().includes(errorUp));
        if (matchIdx === -1) return { found: false, error_type: errorUp, message: `ไม่พบข้อมูลสำหรับ error: ${errorUp} — ลองค้นใน SAP note หรือ ST22 โดยตรง` };
        const explanation = lines.slice(matchIdx, matchIdx + 15).join('\n').trim();
        return { found: true, error_type: errorUp, explanation, has_context: !!context };
    } catch (e) { return { found: false, error: e.message }; }
}

/** ค้นหา SAP authorization object — อ่านจาก knowledge file basis_admin */
function lookupAuthObject(object, intent) {
    try {
        const content = fs_mod.readFileSync(path_mod.join(KNOWLEDGE_DIR, '13_basis_admin.txt'), 'utf8');
        const up      = String(object || '').toUpperCase().trim();
        if (!up) return { found: false, message: 'กรุณาระบุ authorization object' };

        // Common objects → canonical blurbs (fast-path, doesn't depend on file parse)
        const CATALOG = {
            'S_DEVELOP':   { fields: ['DEVCLASS','OBJTYPE','OBJNAME','P_GROUP','ACTVT'], actvt: ['01 create','02 change','03 display','06 delete','16 execute'], use: 'ABAP workbench access — ควบคุม class/program/table ตาม P_GROUP' },
            'S_TCODE':     { fields: ['TCD'],                                             actvt: ['(no ACTVT — ผ่านการเข้า tx เท่านั้น)'],                 use: 'อนุญาตให้เข้า transaction code; ต่อด้วย object อื่นใน tx นั้นอีกที' },
            'S_TABU_DIS':  { fields: ['DICBERCLS','ACTVT'],                                actvt: ['02 change','03 display'],                                use: 'เปิด/แก้ table ผ่าน authgroup (SM30/SM31/SE16)' },
            'S_TABU_NAM':  { fields: ['TABLE','ACTVT'],                                    actvt: ['02 change','03 display'],                                use: 'เปิด/แก้ table ตาม name — ละเอียดกว่า S_TABU_DIS' },
            'S_PROGRAM':   { fields: ['P_ACTION','P_GROUP'],                               actvt: ['SUBMIT','BTCSUBMIT','VARIANT','EDIT'],                  use: 'ควบคุมสิทธิ์รัน/แก้ ABAP program ตาม authgroup' },
            'S_RFC':       { fields: ['ACTVT','RFC_TYPE','RFC_NAME'],                      actvt: ['16 execute'],                                            use: 'จำกัดการเรียก RFC — ต่ำมากสุดควรกำหนดเป็น function group' },
            'S_BTCH_JOB':  { fields: ['JOBACTION','JOBGROUP'],                             actvt: ['RELE','SHOW','DELE','PLAN','PROT'],                     use: 'การจัดการ background job (SM36/SM37)' },
            'S_DATASET':   { fields: ['ACTVT','FILENAME','PROGRAM'],                       actvt: ['06 delete','33 read','34 write'],                       use: 'เข้าถึง application server file (OPEN DATASET)' },
            'S_TRANSPRT':  { fields: ['TTYPE','ACTVT'],                                    actvt: ['01 create','02 change','03 display','60 import','75 release'], use: 'จัดการ transport request' },
            'S_USER_GRP':  { fields: ['CLASS','ACTVT'],                                    actvt: ['01 create','02 change','03 display','05 lock','06 delete','24 assign'], use: 'สิทธิ์ใน SU01 ตาม user group' },
            'S_ADMI_FCD':  { fields: ['S_ADMI_FCD'],                                       actvt: ['(token-based)'],                                         use: 'admin functions เช่น SPAD, SP01, SM02' },
        };

        const cat = CATALOG[up];
        const authCheckSnippet = cat
            ? `AUTHORITY-CHECK OBJECT '${up}'\n  ID '${cat.fields[0] || 'X'}' FIELD lv_val${cat.fields.includes('ACTVT') ? "\n  ID 'ACTVT'     FIELD '03'" : ''}.\nIF sy-subrc <> 0.\n  MESSAGE 'No authorization' TYPE 'E'.\nENDIF.`
            : null;

        // Also fetch surrounding knowledge-file context if it mentions the object
        let kbContext = null;
        const idx = content.toUpperCase().indexOf(up);
        if (idx !== -1) {
            kbContext = content.substring(Math.max(0, idx - 80), idx + 400).trim();
        }

        if (cat) {
            return {
                found: true,
                object: up,
                fields: cat.fields,
                common_actvt_values: cat.actvt,
                use_case: cat.use,
                code_snippet: authCheckSnippet,
                intent_hint: intent || null,
                kb_context: kbContext,
                tip: 'หาก AUTHORITY-CHECK ล้มเหลว ให้ user รัน SU53 ทันทีเพื่อดู object/field ที่ขาด',
            };
        }

        if (kbContext) return { found: true, object: up, kb_context: kbContext, note: 'object นี้ไม่ได้อยู่ใน catalog หลัก — ข้อมูลจาก knowledge base' };
        return { found: false, object: up, message: `ไม่พบข้อมูล authorization object: ${up}` };
    } catch (e) { return { found: false, error: e.message }; }
}

/** อธิบาย T-code ในเชิง config + enhancement — อ่านจาก transactions + functional KB */
function explainTcodeConfig(tcode, module) {
    try {
        const up = String(tcode || '').toUpperCase().trim();
        if (!up) return { found: false, message: 'กรุณาระบุ T-code' };

        // 1) Base description from 03_sap_transactions.txt
        const base = getTransactionInfo(up);

        // 2) Scan functional KB for SPRO path + config table hints
        const funcContent = fs_mod.readFileSync(path_mod.join(KNOWLEDGE_DIR, '17_functional_config_spro.txt'), 'utf8');
        const lines = funcContent.split('\n');
        const matchIdx = lines.findIndex(l => l.toUpperCase().includes(up));
        let funcSnippet = null;
        if (matchIdx !== -1) {
            funcSnippet = lines.slice(Math.max(0, matchIdx - 2), matchIdx + 8).join('\n').trim();
        }

        // 3) Enhancement hints — quick heuristics by module
        const ENH_HINTS = {
            VA01: { badi: 'BADI_SD_SALES_ITEM', user_exit: 'USEREXIT_MOVE_FIELD_TO_VBAK (MV45AFZZ)', tables: ['VBAK','VBAP','VBKD'] },
            VA02: { badi: 'BADI_SD_SALES_ITEM', user_exit: 'USEREXIT_SAVE_DOCUMENT_PREPARE (MV45AFZZ)', tables: ['VBAK','VBAP'] },
            ME21N:{ badi: 'ME_PROCESS_PO_CUST', user_exit: '(no classic; use BAdI)', tables: ['EKKO','EKPO','EKET'] },
            ME22N:{ badi: 'ME_PROCESS_PO_CUST', user_exit: '(no classic; use BAdI)', tables: ['EKKO','EKPO'] },
            MIGO: { badi: 'MB_DOCUMENT_BADI', user_exit: 'EXIT_SAPMM07M_001', tables: ['MATDOC','MKPF','MSEG'] },
            MIRO: { badi: 'INVOICE_UPDATE', user_exit: 'EXIT_SAPLMRMH_001', tables: ['RBKP','RSEG'] },
            FB01: { badi: 'BADI_FDCB_SUBBAS01', user_exit: 'USEREXIT_* (SAPLF040)', tables: ['BKPF','BSEG'] },
            FB60: { badi: 'BADI_FDCB_SUBBAS01', user_exit: 'USEREXIT_*', tables: ['BKPF','BSEG'] },
            F110: { badi: 'FI_F110', user_exit: 'FEDI0003 / FEDI0005', tables: ['REGUH','REGUP'] },
            FBN1: { badi: '(number range — use SNRO BAdI NUMBER_RANGE_OBJECT)', tables: ['NRIV','T003'] },
            OBYC: { badi: '(customizing — no enhancement; is configuration)', tables: ['T030'] },
            OB13: { badi: '(customizing)', tables: ['T004','SKA1','SKB1'] },
            VOV8: { badi: '(customizing)', tables: ['TVAK','TVAKT'] },
            OMS2: { badi: '(customizing)', tables: ['T134'] },
            PFCG: { badi: '(not applicable — admin tx)', tables: ['AGR_*','USR*'] },
            SU01: { badi: 'BBP_SEARCH_SHLP_USER', tables: ['USR02','USR04','USER_ADDR'] },
            BP:   { badi: 'BUPA_FURTHER_CHECKS', tables: ['BUT000','BUT020','BUT100','CVI_*'] },
        };
        const enh = ENH_HINTS[up] || null;

        return {
            found: !!(base?.found || funcSnippet || enh),
            tcode: up,
            module: module || null,
            description: base?.description || null,
            spro_or_config_snippet: funcSnippet,
            enhancements: enh,
            recommendation: enh
                ? `ใช้ ${enh.badi} สำหรับ custom logic, แก้ FS เฉพาะกรณีไม่มีตัวเลือกอื่น`
                : 'ตรวจสอบ enhancement ผ่าน SE84 → Business Add-Ins ค้นคำสำคัญของ tx',
        };
    } catch (e) { return { found: false, error: e.message }; }
}

/** Dispatcher — เรียก tool function ที่ถูกต้อง */
/** Phase 35: semantic search ทั้ง vector store — ครอบคลุมทุกไฟล์รวมเอกสาร
 *  ที่อัพโหลดใหม่ (PDF/DOCX) โดยไม่ต้องแก้โค้ดเพิ่ม ต่างจาก tool ตัวอื่น
 *  ที่อ่านไฟล์ .txt แบบระบุชื่อตายตัว */
async function searchKnowledge(query) {
    if (!query) return { found: false, error: 'empty query' };
    if (!HAS_API_KEY || !getVectorStoreId()) {
        return { found: false, error: 'knowledge base ยังไม่พร้อมใช้งาน (no vector store)' };
    }
    try {
        const page = await openai.vectorStores.search(getVectorStoreId(), {
            query,
            max_num_results: 6,
        });
        // แต่ละ result: { filename, score, content: [{type:'text', text}] }
        // จำกัดขนาด chunk กัน context บวม — 6 × 2500 chars ≈ 4k tokens สูงสุด
        const results = (page?.data || [])
            .map(r => ({
                file:  r.filename,
                score: Math.round((r.score || 0) * 1000) / 1000,
                text:  (r.content || [])
                    .filter(c => c.type === 'text')
                    .map(c => c.text)
                    .join('\n')
                    .slice(0, 2500),
            }))
            .filter(r => r.text);
        if (results.length === 0) {
            return { found: false, note: 'ไม่พบเนื้อหาที่เกี่ยวข้องใน knowledge base — ตอบจากความรู้ทั่วไปได้ แต่ระบุให้ user ทราบ' };
        }
        return { found: true, results };
    } catch (e) {
        console.warn('[searchKnowledge]', e.message);
        return { found: false, error: e.message };
    }
}

// org standards: ทุกคำตอบเคยเปิดด้วย search เดิมซ้ำ ๆ — round trip ละหนึ่งรอบ reasoning เต็ม ๆ
// จึง fetch ครั้งเดียว cache 6 ชม. แล้วแนบใน prompt แทน; หาไม่เจอ = ไม่แนบ ให้ model ค้นเองแบบเดิม
const ORG_STANDARDS_QUERY     = 'organization ABAP development standards naming conventions error handling documentation';
const ORG_STANDARDS_TTL_MS    = 6 * 60 * 60 * 1000;   // re-read a few times a day
const ORG_STANDARDS_MAX_CHARS = 6000;                 // ~1.5k tokens; fits two chunks of the org doc
// จัดไฟล์ standards ององค์กรขึ้นก่อน — คะแนน search ดันคู่มือ SAP ทั่วไปชนะเอกสารจริง
const ORG_STANDARDS_FILE_RE   = /standard|keystone/i;
let _orgStandards = { text: '', files: [], fetchedAt: 0 };

async function getOrgStandards() {
    const now = Date.now();
    if (_orgStandards.fetchedAt && now - _orgStandards.fetchedAt < ORG_STANDARDS_TTL_MS) {
        return _orgStandards;
    }
    // Stamp the time first: a failing lookup must not retry on every message.
    _orgStandards = { ..._orgStandards, fetchedAt: now };
    try {
        const r = await searchKnowledge(ORG_STANDARDS_QUERY);
        if (r?.found && Array.isArray(r.results) && r.results.length) {
            let text = '';
            const files = [];
            // stable sort: org standards first, search order kept within each group
            const ranked = [...r.results].sort((a, c) =>
                (ORG_STANDARDS_FILE_RE.test(a.file) ? 0 : 1) - (ORG_STANDARDS_FILE_RE.test(c.file) ? 0 : 1));
            for (const x of ranked) {
                if (text.length + x.text.length > ORG_STANDARDS_MAX_CHARS) break;
                text += `\n[${x.file}]\n${x.text}\n`;
                files.push(x.file);
            }
            _orgStandards = { text: text.trim(), files: [...new Set(files)], fetchedAt: now };
            console.log(`[org-standards] cached ${_orgStandards.text.length} chars from ${_orgStandards.files.join(' · ') || '(none)'}`);
        } else {
            _orgStandards = { text: '', files: [], fetchedAt: now };
            console.warn('[org-standards] nothing found — the model will search for them itself');
        }
    } catch (e) {
        console.warn('[org-standards] lookup failed, model will search instead:', e.message);
        _orgStandards = { text: '', files: [], fetchedAt: now };
    }
    return _orgStandards;
}

// pre-analysis: งานที่ rule ตัดสินได้ทำฝั่ง server ก่อน — แนบผล scan (บรรทัดแม่น) + เอกสารที่ตรง
// เหลือให้ model แค่ส่วนที่มันเก่ง: ตัดสินวิธีแก้และอธิบาย
const PREANALYSIS_MAX_CHARS = 4000;

function scanQueryTerms(scan) {
    const terms = new Set();
    for (const i of scan.issues || []) {
        const c = String(i.code || '').toUpperCase();
        if (/\bTABLES\b/.test(c))      terms.add('obsolete TABLES statement work area');
        if (/\bMOVE\b/.test(c))        terms.add('MOVE TO obsolete assignment');
        if (/SELECT\s+\*/.test(c))     terms.add('SELECT * explicit field list performance');
        if (/ENDSELECT/.test(c))        terms.add('SELECT ENDSELECT loop INTO TABLE');
        if (/\bWRITE\b/.test(c))       terms.add('WRITE classical list ALV');
        if (/\bLIKE\b/.test(c))        terms.add('LIKE obsolete data declaration TYPE');
    }
    return [...terms];
}

/** Findings + the documents that speak to them, ready to drop into the prompt. */
async function buildPreAnalysis(userMessage) {
    const text = String(userMessage || '');
    if (!looksLikeAbapCode(text)) return '';

    let block = '';
    try {
        const scan = checkAbapSyntax(text);
        if (scan.issueCount > 0) {
            block += '\n\n## Detected by a static scan of the code above (line numbers are exact)\n'
                  + 'These were found mechanically — treat them as given and spend your effort on the fix, not on locating them. This list is not exhaustive; keep looking for anything it cannot see.\n';
            for (const i of scan.issues) {
                block += `  line ${i.line} [${i.severity}] ${i.message}\n      ${String(i.code).slice(0, 110)}\n`;
            }
        }

        // query สร้างจาก defect ที่ scan เจอ + prose บรรทัดแรกสั้น ๆ — ยาวกว่านั้นลาก header report มาปนจน query เละ
        const terms = scanQueryTerms(scan);
        // ใช้ firstProseLine จาก abap-scan — กติกาเดียว ที่เดียว ไม่ก๊อปมา drift
        const ask = abapScan.firstProseLine(text);
        const query = [...terms, ask.slice(0, 120)].filter(Boolean).join(' ').trim();
        if (query) {
            const r = await searchKnowledge(query);
            if (r?.found && r.results?.length) {
                let docs = '', files = [];
                for (const x of r.results) {
                    if (docs.length + x.text.length > PREANALYSIS_MAX_CHARS) break;
                    docs += `\n[${x.file}]\n${x.text}\n`;
                    files.push(x.file);
                }
                if (docs) {
                    block += '\n## Reference material for exactly these findings (already retrieved)\n'
                          + docs.trim()
                          + `\n\nCite the above as: ${[...new Set(files)].join(' · ')}`;
                }
            }
        }
    } catch (e) {
        console.warn('[pre-analysis] skipped:', e.message);
        return '';
    }
    return block;
}

/** The prompt block carrying the standards, or '' when we have none. */
// badge ฝั่ง UI: ดึง query จาก tool-call แล้วสรุปผลเป็น event สั้น (ชื่อไฟล์ top ไม่ส่ง chunk)
function ragQueryOf(name, rawArgs) {
    if (name !== 'search_knowledge') return null;
    try { return String((JSON.parse(rawArgs || '{}')).query || ''); } catch (_) { return ''; }
}
function ragResultEvent(result) {
    const files = [...new Set((result?.results || []).map(r => r.file).filter(Boolean))].slice(0, 3);
    return { type: 'tool_result', name: 'search_knowledge', found: !!result?.found, files };
}

async function executeTool(name, args) {
    console.log(`[🔧 tool] ${name}(${JSON.stringify(args).slice(0, 120)})`);
    switch (name) {
        case 'find_bapi':            return findBapi(args.task, args.module);
        case 'check_abap_syntax':    return checkAbapSyntax(args.code || '');
        case 'get_transaction_info': return getTransactionInfo(args.tcode || '');
        case 'search_s4_migration':  return searchS4Migration(args.topic || '');
        case 'get_best_practice':    return getBestPractice(args.topic || '');
        case 'explain_abap_dump':    return explainAbapDump(args.error_type || '', args.context || '');
        case 'lookup_auth_object':   return lookupAuthObject(args.object || '', args.intent || '');
        case 'explain_tcode_config': return explainTcodeConfig(args.tcode || '', args.module || '');
        case 'search_knowledge':     return searchKnowledge(args.query || '');
        default: return { error: `Unknown tool: ${name}` };
    }
}

// Responses API loop — ปล่อย SSE ชุดเดียวกับ Chat Completions เพื่อไม่ต้องแตะ frontend/billing

// Chat Completions tool = {type:'function', function:{name,description,parameters}}
// Responses tool        = {type:'function', name, description, parameters}  (flat)
function toResponsesTools(tools) {
    return tools.map(t => ({
        type: 'function',
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
    }));
}

async function runResponsesTurn({ oai, userId, model, effort, instructions, userPrompt, history, tools, sendEvent, acc, isAborted, setStream }) {
    const MAX_TOOL_TURNS = 3;
    const MAX_LENGTH_CONTINUATIONS = 4;   // Phase 32 analog for Responses
    // เพดาน output คงที่ต่อ effort สูง ๆ — reasoning แชร์ budget เดียวกับ text, เพดานต่ำเคยได้ bubble เปล่า
    // token คิดตามใช้จริง เพดานใหญ่ไม่เสียอะไรกับคำตอบสั้น
    const RESP_MAX_OUT = { none: 12000, low: 12000, medium: 16000, high: 24000, xhigh: 24000, max: 32000 };
    const maxOutputTokens = RESP_MAX_OUT[effort] || 8000;
    const rTools = toResponsesTools(tools);
    // store:false — OpenAI ไม่เก็บบทสนทนาไว้ฝั่งตน (โค้ดลูกค้าอยู่ในนั้น) แลกกับที่เราต้องพก context เองทุก call
    // input จึงเป็น array เสมอ และผลลัพธ์ของแต่ละ turn ถูกต่อกลับเข้าไปแทน previous_response_id
    const STORE_ARGS = { store: false, include: ['reasoning.encrypted_content'] };
    let input = [
        ...((history && history.length) ? history.map(m => ({ role: m.role, content: m.content })) : []),
        { role: 'user', content: userPrompt },
    ];
    let toolTurn = 0;
    let lengthContinuations = 0;

    // One streaming Responses call. Accumulates text + tool calls, updates acc
    // usage/text, returns { calls, incomplete, respId }.
    async function once(args) {
        // นับจำนวน call ต่อคำตอบ — ตัวเลขที่อธิบาย turn ช้า ไม่ใช่ token รวม
        acc.apiCalls = (acc.apiCalls || 0) + 1;
        let stream;
        try {
            stream = await oai.responses.create(args);
        } catch (e) {
            // Mirror the chat path's project-key 401 → global-key fallback.
            if (e?.status === 401 && oai !== openai && openai) {
                await markProjectKeyInvalid(userId, 'responses stream 401');
                stream = await openai.responses.create(args);
            } else { throw e; }
        }
        setStream(stream);
        const fcalls = {};   // item_id → { call_id, name, args }
        let usage = null, incomplete = null, outputItems = [];
        try {
            for await (const ev of stream) {
                if (isAborted()) break;
                switch (ev.type) {
                    case 'response.output_text.delta':
                        acc.fullText += ev.delta;
                        sendEvent({ type: 'chunk', text: ev.delta });
                        break;
                    case 'response.output_item.added':
                        if (ev.item?.type === 'function_call') {
                            fcalls[ev.item.id] = { call_id: ev.item.call_id, name: ev.item.name, args: '' };
                        }
                        break;
                    case 'response.function_call_arguments.delta':
                        if (fcalls[ev.item_id]) fcalls[ev.item_id].args += ev.delta;
                        break;
                    // truncated จบด้วย response.incomplete ไม่ใช่ .completed — เคยพลาดจน usage ไม่ถูกอ่าน (บิลขาด),
                    // continuation ไม่ทำงาน (ไฟล์โดนตัดเงียบ) และ chain ของ response.id ขาด; สอง event รูปเดียวกันเลยแชร์ case
                    case 'response.completed':
                    case 'response.incomplete':
                        usage = ev.response?.usage;
                        incomplete = ev.response?.incomplete_details;
                        // item ที่โมเดลผลิต (reasoning + message + function_call) — ต้องส่งกลับเป็น context เอง
                        outputItems = ev.response?.output || [];
                        break;
                    case 'response.failed':
                    case 'error':
                        throw new Error(ev.response?.error?.message || ev.message || 'Responses API stream error');
                }
            }
        } catch (streamErr) {
            if (isAborted()) return { calls: [], incomplete: null, outputItems: [] };
            throw streamErr;
        } finally {
            setStream(null);
        }
        if (usage) {
            acc.inputTokens     += usage.input_tokens  || 0;
            acc.outputTokens    += usage.output_tokens || 0;
            acc.cachedTokens    += usage.input_tokens_details?.cached_tokens     || 0;
            acc.reasoningTokens += usage.output_tokens_details?.reasoning_tokens || 0;
        } else if (!isAborted()) {
            // call จบโดยไม่มี usage = token หายจากบิลทั้งก้อน — ตะโกนไว้ดีกว่าเงียบ
            console.warn('[chat/responses] a call ended with no usage — tokens for it are NOT billed'
                + ` (text so far ${acc.fullText.length} chars). Unhandled terminal event?`);
        }
        return { calls: Object.values(fcalls), incomplete, outputItems };
    }

    while (toolTurn < MAX_TOOL_TURNS) {
        if (isAborted()) break;
        const args = {
            model, stream: true, max_output_tokens: maxOutputTokens,
            tools: rTools, reasoning: { effort }, ...STORE_ARGS,
            instructions,      // ส่งใหม่ทุก call — ไม่มี state ฝั่ง OpenAI ให้สืบทอด
            input,
        };

        const { calls, incomplete, outputItems } = await once(args);
        if (isAborted()) return;
        // ผลของ turn นี้กลายเป็น context ของ turn ถัดไป (เดิม previous_response_id ทำให้แทน)
        if (outputItems.length) input = input.concat(outputItems);

        // Truncated by the output cap (no tool call pending) → ask to continue.
        if (calls.length === 0 && incomplete?.reason === 'max_output_tokens'
            && lengthContinuations < MAX_LENGTH_CONTINUATIONS) {
            lengthContinuations++;
            acc.continuations = (acc.continuations || 0) + 1;
            console.warn(`[chat/responses] truncated — continuing (${lengthContinuations}/${MAX_LENGTH_CONTINUATIONS})`);
            input = input.concat([{ role: 'user',
                content: 'Continue exactly where you left off. Do not repeat any earlier text or restart the file.' }]);
            continue;
        }

        if (calls.length === 0) return;   // plain answer → done

        // Tool calls → execute and feed outputs back on the next turn.
        // attach the document-search query so the UI badge can show it.
        const rQuery = calls.map(c => ragQueryOf(c.name, c.args)).find(q => q != null);
        sendEvent({ type: 'tool_call', tools: calls.map(c => c.name), ...(rQuery != null ? { search: { query: rQuery } } : {}) });
        const outputs = [];
        for (const c of calls) {
            let parsed = {};
            try { parsed = JSON.parse(c.args || '{}'); } catch (_) {}
            const result = await executeTool(c.name, parsed);
            if (c.name === 'search_knowledge') sendEvent(ragResultEvent(result));
            outputs.push({ type: 'function_call_output', call_id: c.call_id, output: JSON.stringify(result) });
        }
        input = input.concat(outputs);   // function_call items ถูกต่อไว้แล้วด้านบน
        toolTurn++;
        acc.toolTurns = (acc.toolTurns || 0) + 1;
    }

    // ชน tool-turn cap โดยไม่มีคำตอบ → ยิงปิดท้าย พร้อมส่ง tool output ที่ค้าง — ทิ้งไปจะโดน 400 No tool output
    if (!isAborted() && acc.fullText.length === 0 && toolTurn > 0) {
        console.warn(`[chat/responses] hit MAX_TOOL_TURNS — forcing a final answer turn`
            + ` (${input.length} context item(s) carried over)`);
        const nudge = { role: 'user', content: 'Based on the tool results above, give the final answer now.' };
        await once({
            model, stream: true, max_output_tokens: maxOutputTokens,
            reasoning: { effort }, ...STORE_ARGS, tool_choice: 'none',
            instructions,
            input: input.concat([nudge]),
        });
    }
}

return {
    findBapi, getTransactionInfo, searchS4Migration, getBestPractice,
    explainAbapDump, lookupAuthObject, explainTcodeConfig,
    searchKnowledge, getOrgStandards, buildPreAnalysis,
    ragQueryOf, ragResultEvent, executeTool, toResponsesTools, runResponsesTurn,
};
};
