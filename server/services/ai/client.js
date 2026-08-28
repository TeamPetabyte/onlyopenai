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
// Model-compatibility knobs. Newer models (gpt-5.5, o-series) reject a custom
// `temperature` (only the default is allowed) and require `max_completion_tokens`
// instead of `max_tokens`. OPENAI_TEMPERATURE: a number = use it; empty = omit
// it; unset = 0.4 (fine for gpt-4o). If a model rejects it at runtime we flip
// _tempUnsupported so we stop sending it (avoids a failed call every message).
const OAI_TEMPERATURE = (process.env.OPENAI_TEMPERATURE !== undefined)
    ? (process.env.OPENAI_TEMPERATURE.trim() === '' ? null : Number(process.env.OPENAI_TEMPERATURE))
    : 0.4;
let _tempUnsupported = false;

// Phase 34: model registry — which models the picker exposes, and which OpenAI
// API each one uses. The gpt-5.6 family (sol/terra/luna) runs on the Responses
// API (/v1/responses) with reasoning.effort; gpt-5.5 stays on the existing Chat
// Completions loop (dual-path, safe rollback). Single source for request-side
// validation. Per-model pricing lives in tbl_pricing (phase27-001). The bare
// `gpt-5.6` alias resolves to sol (see resolveModel below).
// Phase 46: moved to lib/models.js. resolveModel now takes the deployment
// default explicitly instead of closing over MODEL, which is what let it move.
const _models = require('./lib/models');
const resolveModel  = (requested) => _models.resolveModel(requested, MODEL);
const resolveEffort = _models.resolveEffort;

let openai = null;
let OpenAI = null;
// Optional corporate egress proxy + fail-fast timeout for OpenAI calls.
// On a locked-down company network the server often cannot reach
// api.openai.com directly (blocked or proxy-only). openai v4 uses a
// node-fetch shim and does NOT auto-honor HTTPS_PROXY — the agent must be
// wired in explicitly. The timeout makes a blocked egress fail fast (and the
// chat UI shows a real error) instead of hanging silently on the SDK default.
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

// ── Phase 17.2 + 17.2.1: per-project OpenAI client routing ───
// Phase 17.2.1 adds an "invalidation" path so a project whose stored key
// turns out to be 401 (revoked/expired/wrong) doesn't break chat forever —
// the chat path catches the 401 once, marks the project, and from then on
// `getProjectOpenAI` short-circuits to the global client. Cleared via
// invalidateProjectClient() when an admin saves a new key.
// When a user makes a chat request we look up their project's
// `project_api_key` (decrypted) and use that key for the OpenAI call.
// This gives us:
//   - Per-project cost separation in OpenAI's billing dashboard
//   - Per-project quota isolation (one runaway project doesn't burn org quota)
//   - Per-project audit trail (usage tagged with the project's SA)
//
// Fallback strategy: any case where we don't have a usable per-project key
// (user has no project / project has no key / decrypt failed / key looks
// invalid) returns the GLOBAL `openai` client. This keeps backward
// compatibility — nothing breaks during the rollout while admins are still
// pasting in keys per project.
//
// Cache: clients are cached by project_id so we don't re-construct one on
// every request. Cache is invalidated when admin saves a new key on the
// project (PUT /api/projects/:id) — see invalidateProjectClient() call sites.
const _projectClientCache = new Map();      // projectId -> { client, decryptedKeyTail }
const _invalidProjectKeys = new Set();       // project_ids whose stored key returned 401 — see chatWithFallback

async function getProjectOpenAI(userId) {
    if (!openai) return openai;                        // no key configured at all
    if (!userId) return openai;                        // no auth context

    // Resolve the user's current project. (Cached fetchUsersFromDB on client
    // is great for UI, but here we read fresh from DB so a project change
    // takes effect on the very next request.)
    const u = await pool.query(
        'SELECT project_id FROM tbl_user WHERE user_id = $1 AND is_deleted = FALSE',
        [userId]);
    const projectId = u.rows[0]?.project_id;
    if (!projectId) return openai;

    // Phase 17.2.1: short-circuit projects we've already proven have a bad
    // key — we caught a 401 on a previous chat call and marked them. Admin
    // saving a new key clears the flag via invalidateProjectClient().
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
        // Phase 3: ถ้ามี vector store ใหม่ให้ patch assistant
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
// File types the vector store can parse natively — .txt plus documents
// (PDF/DOC/DOCX/MD/HTML) so manuals can be dropped in without conversion.
// HTML added for the SAP offline library (SR13/ABAPHELP exports).
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
        // Enumerate vector store → resolve filenames.
        // Phase 38: list() returns ONE page (default 20). Past 20 files the
        // diff saw a truncated set and re-uploaded "missing" files on every
        // boot, duplicating them in the store. for-await walks ALL pages.
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
        .then(()  => syncNewKnowledgeFiles())  // Phase 14: pick up any new knowledge files
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
