// Skill prompt registry. Source of truth is tbl_prompt; server/config/skill-prompts.json
// seeds it on first boot and is the read fallback when no pool is wired or the DB is down.
// The chat hot path reads the in-memory cache synchronously; DB I/O only on load() and writes.

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

// Cap the registry file at 4 MB so a pasted blob is never pulled fully into memory.
const MAX_FILE_BYTES = 4 * 1024 * 1024;

const SKILL_ID_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/i;

// pg pool injected by server.js at boot; null means file-only mode.
let _pool = null;
function setPool(pool) { _pool = pool; }

// --- File source (seed + fallback) ---
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

// --- DB source ---
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
// Seed every file skill the DB has never heard of. A skill the trainer deleted has a history
// row, so it stays deleted; a skill newly added to the JSON reaches existing databases.
async function _seedNewFromFile() {
    const fr = _readFile();
    if (fr.error || fr.skills.length === 0) return 0;
    let seeded = 0;
    for (let i = 0; i < fr.skills.length; i++) {
        const s = fr.skills[i];
        const r = await _pool.query(
            `INSERT INTO tbl_prompt (id, label, description, content, openai_prompt_id, position, updated_by)
             SELECT $1::varchar,$2::varchar,$3::text,$4::text,$5::varchar,$6::int,'seed'
              WHERE NOT EXISTS (SELECT 1 FROM tbl_prompt WHERE id = $1)
                AND NOT EXISTS (SELECT 1 FROM tbl_prompt_history WHERE prompt_id = $1)
             RETURNING id`,
            [s.id, s.label, s.description, s.content, s.openaiPromptId, i]);
        if (r.rowCount) { await _writeHistory(s.id, 'seed', s, 'seed'); seeded++; }
    }
    if (seeded) console.log('[skill-prompts] seeded', seeded, 'new prompt(s) into tbl_prompt from JSON');
    return seeded;
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
            await _seedNewFromFile();
            const skills = await _loadFromDb();
            _cache = {
                loadedAt: new Date().toISOString(),
                skills, raw: null, error: null, source: 'db',
            };
            console.log('[skill-prompts] loaded', skills.length, 'skills from tbl_prompt (DB)');
            _warnMissingKnowledge();
            return _cache;
        } catch (e) {
            console.warn('[skill-prompts] DB load failed → file fallback:', e.message);
        }
    }
    const c = _loadFromFile();
    _warnMissingKnowledge();
    return c;
}

// Say it at boot rather than letting orchestration quietly skip the skill.
function _warnMissingKnowledge() {
    const a = auditKnowledgeBlocks();
    if (a.missing.length) {
        console.warn('[skill-prompts] no knowledge block found in:', a.missing.join(', '));
    }
}

// --- Sync read API (hot path, reads the cache) ---
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

/** True when a skill is still an unfinished stub. Shared with server.js so the rule has one copy. */
function isPlaceholder(content) {
    const c = String(content || '');
    if (c.trim().length < 50) return true;
    if (/REPLACE WITH FULL CONTENT/i.test(c)) return true;
    if (/\bTODO\b.*\b(fill|paste|prompt)\b/i.test(c)) return true;
    if (/\bPLACEHOLDER\b/i.test(c)) return true;
    if (/\bFIXME\b.*\b(prompt|skill)\b/i.test(c)) return true;
    return false;
}

/** Pull just the ABAP knowledge block out of a skill prompt, for orchestration (whole
 *  prompts carry contradicting output-format instructions). Accepts <best_practices> and
 *  <best_practice>, with or without a closing tag. Returns '' when there is no block. */
const KB_OPEN  = /<best_practices?>/i;
const KB_CLOSE = /<\/best_practices?>/i;
// Where the knowledge ends when the closing tag is missing: the output-format section.
const KB_STOP  = /<(?:modified\s+code|analysis|code)>/i;

function knowledgeBlockOf(content) {
    const c = String(content || '');
    const open = c.match(KB_OPEN);
    if (!open) return '';

    const after = c.slice(open.index + open[0].length);
    const close = after.match(KB_CLOSE) || after.match(KB_STOP);
    return (close ? after.slice(0, close.index) : after).trim();
}

/** Which skills would contribute nothing to an orchestrated answer.
 *  Placeholders are excluded — they are already kept out of the router. */
function auditKnowledgeBlocks() {
    const usable = _cache.skills.filter(s => !isPlaceholder(s.content));
    return {
        ok:      usable.filter(s =>  knowledgeBlockOf(s.content)).map(s => s.id),
        missing: usable.filter(s => !knowledgeBlockOf(s.content)).map(s => s.id),
    };
}

/** Build the router catalog the LLM picks from. Placeholders are not listed,
 *  so a "none" from the router means what it says. */
function buildRouterCatalog() {
    return _cache.skills
        .filter(s => !isPlaceholder(s.content))
        .map(s => ({
            id:          s.id,
            label:       s.label,
            description: s.description,
        }));
}

// Skill a generic-but-on-topic question falls back to. Override with ROUTER_CATCHALL_SKILL_ID.
const CATCHALL_ID = process.env.ROUTER_CATCHALL_SKILL_ID || 'abap_best_practice';

/** The configured catch-all, or null when that id is unknown or still a placeholder. */
function getCatchAllSkill() {
    const s = getSkill(CATCHALL_ID);
    if (!s || isPlaceholder(s.content)) return null;
    return s;
}

/** The configured catch-all id, even when it does not resolve to a usable skill. */
function getCatchAllId() { return CATCHALL_ID; }

// --- File write-path (fallback only, when no DB pool) ---
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
    _loadFromFile(); // refresh the cache
    return { error: null };
}

// --- Write API: admin prompt management. DB-first, JSON file fallback ---

/** Create or update a skill from { id, label, description, content, openaiPromptId, updatedBy? }.
 *  Returns { ok, created, skill } or { ok:false, error }. */
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

    // file fallback
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

    // file fallback
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
    isPlaceholder, getCatchAllSkill, getCatchAllId,
    knowledgeBlockOf, auditKnowledgeBlocks,
};
