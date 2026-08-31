// client.js — OpenAI clients: global + per-project (พร้อม 401 fallback), assistant/vector store
const fs_mod   = require('fs');
const path_mod = require('path');
const cryptoStore = require('../../crypto');
const { PHASE4_TOOLS, ASSISTANT_INSTRUCTIONS } = require('./tool-defs');

module.exports = function createAiClient({ pool }) {
// ── OpenAI ─────────────────────────────────────────────────
const HAS_API_KEY = !!(
    process.env.OPENAI_API_KEY &&
    !process.env.OPENAI_API_KEY.startsWith('sk-xxx')
);
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
// model ใหม่ปฏิเสธ temperature ที่ตั้งเอง — เจอ reject ครั้งแรกแล้วเลิกส่งถาวรผ่าน _tempUnsupported
const OAI_TEMPERATURE = (process.env.OPENAI_TEMPERATURE !== undefined)
    ? (process.env.OPENAI_TEMPERATURE.trim() === '' ? null : Number(process.env.OPENAI_TEMPERATURE))
    : 0.4;
let _tempUnsupported = false;

// registry model อยู่ lib/models.js — gpt-5.6 วิ่ง Responses API, gpt-5.5 วิ่ง Chat Completions
const _models = require('../../lib/models');
const resolveModel  = (requested) => _models.resolveModel(requested, MODEL);
const resolveEffort = _models.resolveEffort;

let openai = null;
let OpenAI = null;
// เครือข่ายบริษัทมัก proxy-only — SDK ไม่อ่าน HTTPS_PROXY เอง ต้อง wire agent; timeout ให้ fail เร็วไม่แขวนเงียบ
const _OAI_PROXY = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
let _oaiAgent = undefined;
if (_OAI_PROXY) {
    try {
        const { HttpsProxyAgent } = require('https-proxy-agent');
        _oaiAgent = new HttpsProxyAgent(_OAI_PROXY);
        console.log(`🌐 OpenAI egress via proxy: ${_OAI_PROXY}`);
    } catch (e) {
        console.warn('[openai] HTTPS_PROXY is set but `https-proxy-agent` is not installed — run `npm i https-proxy-agent` in server/. Continuing WITHOUT proxy.');
    }
}
// timeout = time to start getting a response (does not cut a flowing stream);
// maxRetries 0 so a hard egress block fails once, fast, and surfaces clearly.
const OAI_OPTS = { timeout: 60000, maxRetries: 0, ...(_oaiAgent ? { httpAgent: _oaiAgent } : {}) };

if (HAS_API_KEY) {
    OpenAI = require('openai');
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, ...OAI_OPTS });
    console.log(`✅ OpenAI ready — model: ${MODEL}`);
} else {
    console.log('⚠️  No OpenAI API Key — MOCK mode');
}

// client ต่อ project (key จาก DB, decrypt แล้ว cache) — แยกบิล/โควต้า/รอยเท้าใน dashboard ของ OpenAI
// key ใช้ไม่ได้ทุกกรณี → ถอยไป client กลาง; เจอ 401 กลางแชทจะ mark ไว้จน admin วาง key ใหม่
const _projectClientCache = new Map();      // projectId -> { client, decryptedKeyTail }
const _invalidProjectKeys = new Set();       // project_ids whose stored key returned 401 — see chatWithFallback

async function getProjectOpenAI(userId) {
    if (!openai) return openai;                        // no key configured at all
    if (!userId) return openai;                        // no auth context

    // อ่าน project สดจาก DB — เปลี่ยน project แล้วมีผล request ถัดไปทันที
    const u = await pool.query(
        'SELECT project_id FROM tbl_user WHERE user_id = $1 AND is_deleted = FALSE',
        [userId]);
    const projectId = u.rows[0]?.project_id;
    if (!projectId) return openai;

    // project ที่พิสูจน์แล้วว่า key เสีย → ข้ามไป client กลางจนกว่าจะ invalidate
    if (_invalidProjectKeys.has(projectId)) return openai;

    // Check cache
    const cached = _projectClientCache.get(projectId);
    if (cached) return cached.client;

    // Pull encrypted key from DB, decrypt, build a new client.
    const p = await pool.query(
        'SELECT project_api_key FROM tbl_project WHERE project_id = $1 AND is_deleted = FALSE',
        [projectId]);
    const blob = p.rows[0]?.project_api_key;
    if (!blob) return openai;
    const key = cryptoStore.tryDecrypt(blob);
    if (!key || !/^sk-/i.test(key)) return openai;     // bad/placeholder — fallback

    const client = new OpenAI({ apiKey: key, ...OAI_OPTS });
    _projectClientCache.set(projectId, {
        client,
        decryptedKeyTail: key.slice(-4),               // for diagnostic logs only
    });
    return client;
}

/** Drop the cached client so the next request rebuilds with the latest key.
 *  Also clears the "known bad" flag so a freshly-saved key gets a clean retry. */
function invalidateProjectClient(projectId) {
    if (!projectId) return;
    _projectClientCache.delete(projectId);
    _invalidProjectKeys.delete(projectId);
}

/** Mark a project's stored key as invalid (401 detected mid-chat).
 *  Subsequent getProjectOpenAI() calls for this project will short-circuit
 *  to the global client until an admin saves a new key. */
async function markProjectKeyInvalid(userId, reason) {
    if (!userId) return null;
    try {
        const r = await pool.query(
            'SELECT project_id FROM tbl_user WHERE user_id = $1 AND is_deleted = FALSE',
            [userId]);
        const projectId = r.rows[0]?.project_id;
        if (!projectId) return null;
        _invalidProjectKeys.add(projectId);
        _projectClientCache.delete(projectId);
        console.warn('[chat] flagged', projectId, 'as having an invalid project_api_key — falling back to global. reason:', reason);
        // best-effort: record into action log so admin can see why
        try {
            await pool.query(
                `INSERT INTO tbl_action_admin (user_id, role_id, action_type, target_type, change_json)
                 VALUES (1, 1, 'project_key_invalid', 'project', $1)`,
                [JSON.stringify({ project_id: projectId, reason })]);
        } catch (_) { /* non-fatal */ }
        return projectId;
    } catch (e) {
        console.warn('[chat] markProjectKeyInvalid failed:', e.message);
        return null;
    }
}

/** Call openai.chat.completions.create with auto-fallback to the global
 *  client on 401. Use this in EVERY chat path so a bad per-project key
 *  never breaks a user-visible request — we just log + degrade gracefully. */
async function safeChatCompletion(oai, args, userId) {
    try { return await oai.chat.completions.create(args); }
    catch (e) {
        const status = e?.status || e?.statusCode;
        if (status === 401 && oai !== openai && openai) {
            await markProjectKeyInvalid(userId, 'chat.completions 401');
            return await openai.chat.completions.create(args);   // retry once with global
        }
        throw e;
    }
}


// ── Phase 2: OpenAI Assistant (auto-create/load) ───────────
let ASSISTANT_ID = process.env.OPENAI_ASSISTANT_ID || null;

async function ensureAssistant(vectorStoreId = null) {
    if (!HAS_API_KEY) return null;
    if (ASSISTANT_ID) {
        // ถ้ามี vector store ใหม่ให้ patch assistant
        if (vectorStoreId) {
            try {
                await openai.beta.assistants.update(ASSISTANT_ID, {
                    tools: PHASE4_TOOLS,
                    tool_resources: { file_search: { vector_store_ids: [vectorStoreId] } }
                });
                console.log(`✅ Assistant patched with vector store + Phase4 tools: ${vectorStoreId}`);
            } catch (e) { console.warn('[assistant] patch failed:', e.message); }
        }
        return ASSISTANT_ID;
    }
    try {
        const createParams = {
            name:         'PetabyteAi SAP Expert',
            instructions: ASSISTANT_INSTRUCTIONS,
            model:        MODEL,
            tools:        PHASE4_TOOLS,
        };
        if (vectorStoreId) {
            createParams.tool_resources = { file_search: { vector_store_ids: [vectorStoreId] } };
        }
        const assistant = await openai.beta.assistants.create(createParams);
        ASSISTANT_ID = assistant.id;
        const envPath = path_mod.join(__dirname, '.env');
        let envContent = fs_mod.readFileSync(envPath, 'utf8');
        if (!envContent.includes('OPENAI_ASSISTANT_ID')) {
            envContent += `\nOPENAI_ASSISTANT_ID=${ASSISTANT_ID}\n`;
            fs_mod.writeFileSync(envPath, envContent);
        }
        console.log(`✅ Assistant created: ${ASSISTANT_ID}`);
        return ASSISTANT_ID;
    } catch (e) {
        console.warn('[assistant] Failed to create:', e.message);
        return null;
    }
}

// ── Phase 3: Vector Store + File Search (RAG) ─────────────
let VECTOR_STORE_ID = process.env.OPENAI_VECTOR_STORE_ID || null;
const KNOWLEDGE_DIR = path_mod.join(__dirname, 'knowledge');
// ชนิดไฟล์ที่ vector store อ่านออกเอง (.txt + เอกสาร + .html สำหรับ SAP offline library)
const KB_FILE_RE = /\.(txt|md|pdf|docx?|html?)$/i;

async function ensureVectorStore() {
    if (!HAS_API_KEY) return null;
    try {
        // สร้าง Vector Store ใหม่ถ้ายังไม่มี
        if (!VECTOR_STORE_ID) {
            const vs = await openai.vectorStores.create({
                name: 'PetabyteAi SAP Knowledge Base',
            });
            VECTOR_STORE_ID = vs.id;
            const envPath = path_mod.join(__dirname, '.env');
            let envContent = fs_mod.readFileSync(envPath, 'utf8');
            if (!envContent.includes('OPENAI_VECTOR_STORE_ID')) {
                envContent += `\nOPENAI_VECTOR_STORE_ID=${VECTOR_STORE_ID}\n`;
                fs_mod.writeFileSync(envPath, envContent);
            }
            console.log(`✅ Vector Store created: ${VECTOR_STORE_ID}`);

            // อัปโหลด knowledge files ทั้งหมด
            await seedKnowledgeFiles();
        } else {
            console.log(`✅ Vector Store loaded: ${VECTOR_STORE_ID}`);
        }
        return VECTOR_STORE_ID;
    } catch (e) {
        console.warn('[vectorStore] Failed:', e.message);
        return null;
    }
}

async function seedKnowledgeFiles() {
    if (!fs_mod.existsSync(KNOWLEDGE_DIR)) return;
    const files = fs_mod.readdirSync(KNOWLEDGE_DIR).filter(f => KB_FILE_RE.test(f));
    console.log(`[☁️ RAG] Uploading ${files.length} knowledge files...`);
    const fileIds = [];
    for (const filename of files) {
        try {
            const filePath = path_mod.join(KNOWLEDGE_DIR, filename);
            const uploaded = await openai.files.create({
                file:    fs_mod.createReadStream(filePath),
                purpose: 'assistants',
            });
            fileIds.push(uploaded.id);
            console.log(`  ✅ Uploaded: ${filename} (${uploaded.id})`);
        } catch (e) {
            console.warn(`  ⚠️  Failed: ${filename}:`, e.message);
        }
    }
    if (fileIds.length > 0) {
        await openai.vectorStores.fileBatches.createAndPoll(
            VECTOR_STORE_ID,
            { file_ids: fileIds }
        );
        console.log(`[☁️ RAG] ✅ All ${fileIds.length} files indexed in vector store`);
    }
}

/**
 * Sync ONLY new knowledge files into the existing vector store.
 * Reads current filenames from the vector store, diffs against local
 * knowledge/*.txt, and uploads whatever is missing. Safe to call on every
 * boot — it's a no-op if there are no new files. Phase 14 extension.
 */
async function syncNewKnowledgeFiles() {
    if (!HAS_API_KEY || !VECTOR_STORE_ID) return;
    if (!fs_mod.existsSync(KNOWLEDGE_DIR)) return;
    try {
        const localFiles = fs_mod.readdirSync(KNOWLEDGE_DIR).filter(f => KB_FILE_RE.test(f));
        // เดินทุกหน้า — list() หน้าเดียว (20 ไฟล์) เคยทำให้ไฟล์เก่าถูกอัพซ้ำทุก boot
        const existing   = new Set();
        for await (const vf of openai.vectorStores.files.list(VECTOR_STORE_ID, { limit: 100 })) {
            try {
                const meta = await openai.files.retrieve(vf.id);
                if (meta?.filename) existing.add(meta.filename);
            } catch (_) { /* ignore single-file hiccup */ }
        }
        const missing = localFiles.filter(f => !existing.has(f));
        if (missing.length === 0) {
            console.log(`[☁️ RAG] Knowledge base up to date (${localFiles.length} files)`);
            return;
        }
        console.log(`[☁️ RAG] Found ${missing.length} new knowledge file(s): ${missing.join(', ')}`);
        const newIds = [];
        for (const filename of missing) {
            try {
                const uploaded = await openai.files.create({
                    file:    fs_mod.createReadStream(path_mod.join(KNOWLEDGE_DIR, filename)),
                    purpose: 'assistants',
                });
                newIds.push(uploaded.id);
                console.log(`  ✅ Uploaded: ${filename} (${uploaded.id})`);
            } catch (e) {
                console.warn(`  ⚠️  Upload failed for ${filename}:`, e.message);
            }
        }
        if (newIds.length > 0) {
            await openai.vectorStores.fileBatches.createAndPoll(
                VECTOR_STORE_ID,
                { file_ids: newIds }
            );
            console.log(`[☁️ RAG] ✅ Indexed ${newIds.length} new file(s)`);
        }
    } catch (e) {
        console.warn('[syncNewKnowledgeFiles]', e.message);
    }
}


function startKnowledgeInit() {
// Startup: init Vector Store → Assistant (async, non-blocking)
if (HAS_API_KEY) {
    ensureVectorStore()
        .then(vsId => ensureAssistant(vsId))
        .then(id  => { if (id) console.log(`✅ System ready: assistant=${id} vs=${VECTOR_STORE_ID}`); })
        .then(()  => syncNewKnowledgeFiles())  // pick up any new knowledge files
        .catch(e  => console.error('[startup]', e.message));
}
}

return {
    HAS_API_KEY, MODEL, OAI_TEMPERATURE, OAI_OPTS,
    isTempUnsupported: () => _tempUnsupported,
    markTempUnsupported: () => { _tempUnsupported = true; },
    resolveModel, resolveEffort,
    openai, PHASE4_TOOLS,
    getProjectOpenAI, invalidateProjectClient, markProjectKeyInvalid, safeChatCompletion,
    ensureAssistant, ensureVectorStore, seedKnowledgeFiles, syncNewKnowledgeFiles,
    startKnowledgeInit,
    getAssistantId: () => ASSISTANT_ID,
    getVectorStoreId: () => VECTOR_STORE_ID,
    KNOWLEDGE_DIR, KB_FILE_RE,
};
};
