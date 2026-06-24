// ╔═══════════════════════════════════════════════════════════╗
// ║  skill-prompts.js — Phase 18 / 23 skill prompt registry   ║
// ╚═══════════════════════════════════════════════════════════╝
//
// Source of truth (Phase 23): the `tbl_prompt` DB table.
//   - On first boot, if the table is EMPTY, it is seeded from
//     server/config/skill-prompts.json (the prompts committed in git).
//   - After that, the DB is canonical: the admin UI add/edit/delete writes
//     go to the DB (persist across redeploys, shared across instances, with
//     a tbl_prompt_history audit trail).
//
// Resilience: if the DB is unreachable OR no pool has been wired in, the
// registry falls back to reading skill-prompts.json directly, so the chat
// router never breaks. The JSON file therefore doubles as the seed + the
// offline fallback.
//
// In-memory cache: the catalog is loaded into `_cache` on boot / reload /
// after every write. The hot chat path (getSkills / buildRouterCatalog) reads
// the cache SYNCHRONOUSLY — DB I/O only happens on load() and on writes.
//
// Safety: invalid rows are skipped, never crash the server — getSkills()
// returns [] and the chat path falls back to "no extra instructions".

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'config', 'skill-prompts.json');

let _cache = {
    loadedAt: null,
    skills:   [],
    raw:      null,
    error:    null,
    source:   'none',   // 'db' | 'file' | 'none'
};

// Phase 19.3: cap the registry file at 4 MB so an accidentally-pasted huge
// prompt (or a binary blob renamed to .json) doesn't get pulled fully into
// memory. The whole catalog is < 100 KB today; 4 MB is ~40x headroom.
const MAX_FILE_BYTES = 4 * 1024 * 1024;

const SKILL_ID_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/i;

// Phase 23: the pg pool, injected by server.js at boot (setPool). When null,
// the registry runs in file-only mode.
let _pool = null;
function setPool(pool) { _pool = pool; }

// ── File source (seed + fallback) ─────────────────────────────
function _readFile() {
    if (!fs.existsSync(FILE)) {
        return { error: 'skill-prompts.json not found at ' + FILE, skills: [], raw: null };
    }
    try {
        const st = fs.statSync(FILE);
        if (st.size > MAX_FILE_BYTES) {
            return {
                error: 'skill-prompts.json too large (' + st.size + ' bytes; cap ' + MAX_FILE_BYTES + ')',
                skills: [],
                raw: null,
            };
        }
    } catch (e) {
        return { error: 'stat failed: ' + e.message, skills: [], raw: null };
    }
    let raw;
    try {
        raw = fs.readFileSync(FILE, 'utf8');
    } catch (e) {
        return { error: 'read failed: ' + e.message, skills: [], raw: null };
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        return { error: 'invalid JSON: ' + e.message, skills: [], raw };
    }
    const skills = Array.isArray(parsed?.skills) ? parsed.skills : [];

    // Validate each entry: drop incomplete ones, log what went wrong.
    const valid = [];
    const dropped = [];
    for (const s of skills) {
        if (!s || typeof s !== 'object') { dropped.push({ s, why: 'not an object' }); continue; }
        if (!s.id || typeof s.id !== 'string') { dropped.push({ s, why: 'missing id' }); continue; }
        if (!s.content || typeof s.content !== 'string') { dropped.push({ s, why: 'missing content' }); continue; }
        valid.push({
            id:             String(s.id),
            label:          String(s.label || s.id),
            description:    String(s.description || ''),
            content:        String(s.content),
            openaiPromptId: String(s.openaiPromptId || ''),
        });
    }
    if (dropped.length > 0) {
        console.warn('[skill-prompts] dropped', dropped.length, 'invalid entries:',
            dropped.map(d => d.why));
    }
    return { error: null, skills: valid, raw };
}

function _loadFromFile() {
    const result = _readFile();
    _cache = {
        loadedAt: new Date().toISOString(),
        skills:   result.skills,
        raw:      result.raw,
        error:    result.error,
        source:   'file',
    };
    if (result.error) {
        console.warn('[skill-prompts] load error:', result.error);
    } else {
        console.log('[skill-prompts] loaded', result.skills.length, 'skills from', path.basename(FILE), '(file)');
    }
    return _cache;
}

// ── DB source (Phase 23) ──────────────────────────────────────
function _rowToSkill(r) {
    return {
        id:             String(r.id),
        label:          String(r.label || r.id),
        description:    String(r.description || ''),
        content:        String(r.content || ''),
        openaiPromptId: String(r.openai_prompt_id || ''),
    };
}

async function _loadFromDb() {
    const r = await _pool.query(
        `SELECT id, label, description, content, openai_prompt_id
         FROM tbl_prompt WHERE is_active = TRUE
         ORDER BY position, id`);
    return r.rows.map(_rowToSkill);
}

/** First-boot seed: if tbl_prompt is empty, copy the JSON file into it. */
async function _seedFromFileIfEmpty() {
    const cnt = await _pool.query('SELECT count(*)::int AS n FROM tbl_prompt');
    if (cnt.rows[0].n > 0) return false;
    const fr = _readFile();
    if (fr.error || fr.skills.length === 0) return false;
    for (let i = 0; i < fr.skills.length; i++) {
        const s = fr.skills[i];
        await _pool.query(
            `INSERT INTO tbl_prompt (id, label, description, content, openai_prompt_id, position, updated_by)
             VALUES ($1,$2,$3,$4,$5,$6,'seed')
             ON CONFLICT (id) DO NOTHING`,
            [s.id, s.label, s.description, s.content, s.openaiPromptId, i]);
        await _writeHistory(s.id, 'seed', s, 'seed');
    }
    console.log('[skill-prompts] seeded', fr.skills.length, 'prompts into tbl_prompt from JSON');
    return true;
}

/** Best-effort audit snapshot — never fails the calling write. */
async function _writeHistory(promptId, action, snapshot, changedBy) {
    if (!_pool) return;
    try {
        await _pool.query(
            `INSERT INTO tbl_prompt_history (prompt_id, action, label, description, content, changed_by)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [promptId, action,
             snapshot?.label ?? null, snapshot?.description ?? null, snapshot?.content ?? null,
             changedBy ?? null]);
    } catch (e) {
        console.warn('[skill-prompts] history write failed:', e.message);
    }
}

/** Load the catalog into the in-memory cache. DB-first, file fallback. */
async function load() {
    if (_pool) {
        try {
            await _seedFromFileIfEmpty();
            const skills = await _loadFromDb();
            _cache = {
                loadedAt: new Date().toISOString(),
                skills, raw: null, error: null, source: 'db',
            };
            console.log('[skill-prompts] loaded', skills.length, 'skills from tbl_prompt (DB)');
            return _cache;
        } catch (e) {
            console.warn('[skill-prompts] DB load failed → file fallback:', e.message);
        }
    }
    return _loadFromFile();
}

// ── Sync read API (hot path — reads the cache) ────────────────
/** Return all known skills (id, label, description, content, openaiPromptId). */
function getSkills() { return _cache.skills.slice(); }

/** Lookup a single skill by id. Returns null if unknown. */
function getSkill(id) {
    if (!id) return null;
    return _cache.skills.find(s => s.id === id) || null;
}

/** Return load metadata for admin UI (timestamp, error, count, source). */
function getStatus() {
    return {
        loadedAt: _cache.loadedAt,
        count:    _cache.skills.length,
        error:    _cache.error,
        source:   _cache.source,
        path:     _pool ? 'tbl_prompt (DB)' : FILE,
    };
}

/** Build the router prompt that lists skills for the LLM to pick from. */
function buildRouterCatalog() {
    return _cache.skills.map(s => ({
        id:          s.id,
        label:       s.label,
        description: s.description,
    }));
}

// ── File write-path (fallback only, when no DB pool) ──────────
function _readDocForWrite() {
    let doc = { version: 1, skills: [] };
    if (fs.existsSync(FILE)) {
        let raw;
        try {
            raw = fs.readFileSync(FILE, 'utf8');
        } catch (e) {
            return { error: 'read failed: ' + e.message };
        }
        try {
            doc = JSON.parse(raw);
        } catch (e) {
            return { error: 'refusing to overwrite — current file is invalid JSON: ' + e.message };
        }
    }
    if (!doc || typeof doc !== 'object') doc = { version: 1, skills: [] };
    if (!Array.isArray(doc.skills)) doc.skills = [];
    return { doc };
}

function _writeDoc(doc) {
    const out = JSON.stringify(doc, null, 2) + '\n';
    if (Buffer.byteLength(out, 'utf8') > MAX_FILE_BYTES) {
        return { error: 'file would exceed size cap (' + MAX_FILE_BYTES + ' bytes)' };
    }
    const tmp = FILE + '.tmp';
    try {
        fs.writeFileSync(tmp, out, 'utf8');
        fs.renameSync(tmp, FILE);
    } catch (e) {
        try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
        return { error: 'write failed: ' + e.message };
    }
    _loadFromFile(); // refresh in-memory cache + router catalog
    return { error: null };
}

// ── Write API (Phase 22/23): admin prompt management ──────────
// DB-first when a pool is wired in; otherwise falls back to the JSON file.

/**
 * Create or update a skill. `input` = { id, label, description, content,
 * openaiPromptId, updatedBy? }. Returns { ok, created, skill } or
 * { ok:false, error }.
 */
async function upsertSkill(input) {
    if (!input || typeof input !== 'object') return { ok: false, error: 'no payload' };
    const id = String(input.id || '').trim();
    if (!id) return { ok: false, error: 'id is required' };
    if (!SKILL_ID_RE.test(id)) {
        return { ok: false, error: 'id must be 2-64 chars: letters, digits, _ or - (no spaces)' };
    }
    const content = String(input.content == null ? '' : input.content);
    if (content.trim().length < 1) return { ok: false, error: 'content is required' };

    const entry = {
        id,
        label:          String(input.label || id),
        description:    String(input.description || ''),
        openaiPromptId: String(input.openaiPromptId || ''),
        content,
    };
    const changedBy = String(input.updatedBy || 'admin');

    if (_pool) {
        try {
            const existing = await _pool.query('SELECT position FROM tbl_prompt WHERE id = $1', [id]);
            const created = existing.rowCount === 0;
            const position = created
                ? (await _pool.query('SELECT COALESCE(MAX(position) + 1, 0) AS p FROM tbl_prompt')).rows[0].p
                : existing.rows[0].position;
            await _pool.query(
                `INSERT INTO tbl_prompt (id, label, description, content, openai_prompt_id, position, updated_at, updated_by)
                 VALUES ($1,$2,$3,$4,$5,$6,NOW(),$7)
                 ON CONFLICT (id) DO UPDATE SET
                     label = EXCLUDED.label, description = EXCLUDED.description,
                     content = EXCLUDED.content, openai_prompt_id = EXCLUDED.openai_prompt_id,
                     position = EXCLUDED.position, is_active = TRUE,
                     updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
                [id, entry.label, entry.description, entry.content, entry.openaiPromptId, position, changedBy]);
            await _writeHistory(id, created ? 'insert' : 'update', entry, changedBy);
            await load();
            return { ok: true, created, skill: entry };
        } catch (e) {
            return { ok: false, error: 'db write failed: ' + e.message };
        }
    }

    // ── file fallback ──
    const { doc, error } = _readDocForWrite();
    if (error) return { ok: false, error };
    const idx = doc.skills.findIndex(s => s && s.id === id);
    let created = false;
    if (idx >= 0) {
        doc.skills[idx] = { ...doc.skills[idx], ...entry };
    } else {
        doc.skills.push(entry);
        created = true;
    }
    const w = _writeDoc(doc);
    if (w.error) return { ok: false, error: w.error };
    return { ok: true, created, skill: entry };
}

/** Delete a skill by id. Returns { ok, deleted } or { ok:false, error }. */
async function deleteSkill(id, opts = {}) {
    id = String(id || '').trim();
    if (!id) return { ok: false, error: 'id is required' };

    if (_pool) {
        try {
            const cur = await _pool.query('SELECT label, description, content FROM tbl_prompt WHERE id = $1', [id]);
            const r = await _pool.query('DELETE FROM tbl_prompt WHERE id = $1 RETURNING id', [id]);
            if (r.rowCount === 0) return { ok: false, error: 'skill not found: ' + id };
            await _writeHistory(id, 'delete', cur.rows[0] || null, String(opts.deletedBy || 'admin'));
            await load();
            return { ok: true, deleted: id };
        } catch (e) {
            return { ok: false, error: 'db delete failed: ' + e.message };
        }
    }

    // ── file fallback ──
    const { doc, error } = _readDocForWrite();
    if (error) return { ok: false, error };
    const before = doc.skills.length;
    doc.skills = doc.skills.filter(s => !(s && s.id === id));
    if (doc.skills.length === before) return { ok: false, error: 'skill not found: ' + id };
    const w = _writeDoc(doc);
    if (w.error) return { ok: false, error: w.error };
    return { ok: true, deleted: id };
}

module.exports = {
    setPool, load, getSkills, getSkill, getStatus, buildRouterCatalog,
    upsertSkill, deleteSkill,
};
