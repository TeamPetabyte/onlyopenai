// ╔═══════════════════════════════════════════════════════════╗
// ║  skill-prompts.js — Phase 18 skill prompt registry        ║
// ╚═══════════════════════════════════════════════════════════╝
//
// Loads the JSON file at server/config/skill-prompts.json into memory
// and exposes a small read API for the chat router + admin UI.
//
// Why a JSON file (not a DB) — for now
// ───────────────────────────────────
// The PM still needs to approve the schema for a prompt-management table.
// Until then we keep the registry in version-controllable JSON so:
//   - Edits are reviewable via git diff
//   - Migration to DB later is a one-time INSERT pass over `skills[]`
//   - Zero new DB columns to design + migrate now
//
// In-memory cache + hot reload
// ────────────────────────────
// The file is read ONCE at boot and cached. POST /api/skills/reload
// (admin only) re-reads it without a server restart. We deliberately do NOT
// watch the file with fs.watch — that fires too many events on common
// editors (save → temp file → rename) and ends up reloading multiple times.
//
// Safety
// ──────
// Invalid JSON or missing required fields are logged but never crash the
// server — `getSkills()` simply returns an empty array, and the chat path
// falls back to "no additional instructions" (Assistant + vector store
// answer on their own, which is the documented Phase 1 behaviour).

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'config', 'skill-prompts.json');

let _cache = {
    loadedAt: null,
    skills:   [],
    raw:      null,
    error:    null,
};

// Phase 19.3: cap the registry file at 4 MB so an accidentally-pasted huge
// prompt (or a binary blob renamed to .json) doesn't get pulled fully into
// memory. The whole catalog is < 100 KB today; 4 MB is ~40x headroom.
const MAX_FILE_BYTES = 4 * 1024 * 1024;

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

function load() {
    const result = _readFile();
    _cache = {
        loadedAt: new Date().toISOString(),
        skills:   result.skills,
        raw:      result.raw,
        error:    result.error,
    };
    if (result.error) {
        console.warn('[skill-prompts] load error:', result.error);
    } else {
        console.log('[skill-prompts] loaded', result.skills.length, 'skills from', path.basename(FILE));
    }
    return _cache;
}

/** Return all known skills (id, label, description, content, openaiPromptId). */
function getSkills() { return _cache.skills.slice(); }

/** Lookup a single skill by id. Returns null if unknown. */
function getSkill(id) {
    if (!id) return null;
    return _cache.skills.find(s => s.id === id) || null;
}

/** Return load metadata for admin UI (timestamp, error, count). */
function getStatus() {
    return {
        loadedAt: _cache.loadedAt,
        count:    _cache.skills.length,
        error:    _cache.error,
        path:     FILE,
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

// ── Write path (Phase 22): admin UI prompt management ─────────
//
// Prompt engineers edit/add skills directly from the admin page. These
// helpers read the current file fresh, mutate the skills[] array, then
// write it back atomically (temp file + rename) and reload the in-memory
// cache so the chat router picks up the change immediately — no restart,
// no manual "reload" click needed.
//
// NOTE: edits made on the deployed server are written to that machine's
// skill-prompts.json only; they are NOT in git and WILL be overwritten by
// the next code update (ZIP/clone). The canonical copy still lives in the
// repo — keep them in sync (the admin UI shows the file path).

const SKILL_ID_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/i;

/** Read + parse the file fresh for a write op. Returns { doc } or { error }. */
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

/** Atomically write the doc to disk, then reload the cache. */
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
    load(); // refresh in-memory cache + router catalog
    return { error: null };
}

/**
 * Create or update a skill. `input` = { id, label, description, content,
 * openaiPromptId }. Returns { ok, created, skill } or { ok:false, error }.
 */
function upsertSkill(input) {
    if (!input || typeof input !== 'object') return { ok: false, error: 'no payload' };
    const id = String(input.id || '').trim();
    if (!id) return { ok: false, error: 'id is required' };
    if (!SKILL_ID_RE.test(id)) {
        return { ok: false, error: 'id must be 2-64 chars: letters, digits, _ or - (no spaces)' };
    }
    const content = String(input.content == null ? '' : input.content);
    if (content.trim().length < 1) return { ok: false, error: 'content is required' };

    const { doc, error } = _readDocForWrite();
    if (error) return { ok: false, error };

    const entry = {
        id,
        label:          String(input.label || id),
        description:    String(input.description || ''),
        openaiPromptId: String(input.openaiPromptId || ''),
        content,
    };
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
function deleteSkill(id) {
    id = String(id || '').trim();
    if (!id) return { ok: false, error: 'id is required' };

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
    load, getSkills, getSkill, getStatus, buildRouterCatalog,
    upsertSkill, deleteSkill,
};
