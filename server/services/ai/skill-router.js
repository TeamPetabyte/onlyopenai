// skill-router.js — เลือก skill จาก catalog: code-shape fast path -> LLM -> catch-all
const abapScan  = require('../../lib/abap-scan');
const promptLib = require('../../lib/prompt');
const { looksLikeAbapCode, proseOf } = abapScan;

module.exports = function createSkillRouter({ ai, skillPrompts }) {
const { openai } = ai;
function isSkillPlaceholder(content) {
    return skillPrompts.isPlaceholder(content);
}


// ══════════════════════════════════════════════════════════
//  SKILL ROUTER — picks a system prompt from the tbl_prompt catalog
// ══════════════════════════════════════════════════════════

// Phase 18: picks a skill from the DB-backed catalog (skill-prompts.js).
// Phase 31: this is now the ONLY router — the old hardcoded
// INTENT_SKILL_MAP/detectIntent() classifier was removed.
//
// Phase 40 rewrite. The router was answering "none" for the request people
// actually type ("ช่วยรีวิวโค้ดนี้ให้หน่อย" + a paste), so the Prompt Lab
// prompts looked like they were never used unless the tester named the check
// out loud. Four things caused it, all fixed here:
//   1. the prompt ORDERED it to return "none" for anything generic, while the
//      catalog carries a catch-all skill meant for exactly those requests;
//   2. it only saw the first 800 chars — on a paste that is the header comment
//      and the DATA block, and an instruction typed after the code was lost;
//   3. the 0.7 cut-off, against six deliberately-overlapping checks the model
//      hedges between (0.5-0.6 is its honest answer, not a bad one);
//   4. a pick that turned out to be a placeholder was dropped with no
//      second-best, so a half-finished prompt meant NO prompt.
//
// Behaviour now
// ─────────────
//   - A bare code paste is decided from the code itself — no LLM call at all.
//   - Otherwise gpt-4o-mini picks from the catalog, seeing a head+tail window
//     of the message plus the last two conversation turns.
//   - "none"/low-confidence/unusable picks fall through to the code shape,
//     then to the catch-all skill. Only a message that is genuinely not about
//     ABAP/SAP ends with no skill injected.
//   - Returns { skillId, label, confidence, reason, content, source }.
//     `source` is 'llm' | 'code-shape' | 'catch-all' | 'none' — it rides the
//     `routed` SSE event so the chat UI can show WHY, not just WHAT.

// ── Phase 40: code-shape rules ────────────────────────────────
// Which focused check a piece of ABAP obviously calls for, judged from the
// CODE rather than from what the user typed. Consulted only where there is no
// competing user intent to misread:
//   • a bare paste with essentially no prose → decided here, LLM call skipped;
//   • after the LLM returned nothing, or settled for the catch-all → upgraded.
// It never overrides a confident LLM pick, so "generate a unit test for this"
// can't be hijacked into "cleanup commented code" by the shape of the code.
// Phase 46: the rules moved to lib/abap-scan.js. These two wrappers keep the
// registry check that used to live inside them — the rules match text, the
// catalog decides which of those matched skills actually exist.
function pickSkillFromCodeShape(text) {
    // Filter FIRST, then require exactly one — the order the pre-v1.11.4 code
    // used. v1.11.4 swapped it and the commit claimed the filtering was
    // unchanged, which was wrong: with two rules firing where one names a
    // placeholder skill, the old code dropped the placeholder and picked the
    // survivor, and the new code saw "two hits" and gave up. The equivalence
    // test missed it because every skill in the test catalog was real.
    const hits = abapScan.ROUTER_CODE_RULES
        .filter(r => { try { return r.test(text); } catch (_) { return false; } })
        .map(r => r.id)
        .filter(id => {
            const s = skillPrompts.getSkill(id);
            return s && !isSkillPlaceholder(s.content);
        });
    return hits.length === 1 ? hits[0] : null;
}
function skillsForCode(text) {
    return abapScan.matchingSkillIds(text).filter(id => {
        const s = skillPrompts.getSkill(id);
        return s && !isSkillPlaceholder(s.content);
    });
}

// Phase 46: supportingKnowledgeBlock moved to lib/prompt.js. The registry is
// passed in rather than reached for, so the builder is testable without a DB.
const MAX_SUPPORTING_SKILLS   = promptLib.MAX_SUPPORTING_SKILLS;
const supportingKnowledgeBlock = (ids) => promptLib.supportingKnowledgeBlock(ids, skillPrompts);

const ROUTER_HEAD_CHARS     = 1500;
const ROUTER_TAIL_CHARS     = 1500;
const ROUTER_MIN_CONFIDENCE = 0.5;
const ROUTER_HISTORY_TURNS  = 2;

/** Head + tail window of the message. The middle of a long program is the
 *  least diagnostic part; the top (declarations) and the bottom (the logic,
 *  and often the instruction typed after the paste) are what matter. */
function routerWindow(text) {
    const t = String(text || '');
    const cap = ROUTER_HEAD_CHARS + ROUTER_TAIL_CHARS;
    if (t.length <= cap) return t;
    return t.slice(0, ROUTER_HEAD_CHARS)
        + `\n\n[... ${t.length - cap} chars omitted ...]\n\n`
        + t.slice(-ROUTER_TAIL_CHARS);
}

function _noSkill(reason, confidence = 0, fromCatalog = true) {
    return { skillId: null, label: null, confidence, reason, content: null, fromCatalog, source: 'none' };
}
function _skillResult(skill, { confidence, reason, source }) {
    return {
        skillId: skill.id, label: skill.label, confidence, reason,
        content: skill.content, fromCatalog: true, source,
    };
}

async function pickSkillFromCatalog(userMessage, oai, history) {
    const catalog = skillPrompts.buildRouterCatalog();
    if (catalog.length === 0) {
        // No usable catalog (file missing, parse error, or every entry still a
        // placeholder) — caller falls through to the base SAP/ABAP prompt.
        return _noSkill('catalog empty', 0, false);
    }

    const fullText = String(userMessage || '');

    // ── Fast path: a bare code paste with (almost) no words ───────
    // There is no instruction to contradict, so the code decides and the
    // gpt-4o-mini round trip is skipped entirely.
    // A LITERALLY bare paste — not "short prose". If the user typed anything at
    // all we ask the LLM, because the words outrank the code's shape ("generate
    // a unit test for this" must not become "cleanup commented code").
    if (looksLikeAbapCode(fullText) && proseOf(fullText) === '') {
        const shapeId = pickSkillFromCodeShape(fullText);
        const s = shapeId && skillPrompts.getSkill(shapeId);
        if (s) {
            console.log(`[router] code-shape fast path: "${s.id}" (bare paste — no LLM call)`);
            return _skillResult(s, { confidence: 1, reason: 'code shape (bare paste)', source: 'code-shape' });
        }
    }

    // Render the catalog as a list for the LLM. We include id + label +
    // description; the LLM must echo back the id exactly.
    const catalogText = catalog.map(s =>
        `- id: "${s.id}"\n    label: ${s.label}\n    description: ${s.description}`
    ).join('\n');

    const catchAllId  = skillPrompts.getCatchAllId();
    const hasCatchAll = catalog.some(s => s.id === catchAllId);

    const sys = `You are a router for an SAP/ABAP code-review assistant. Pick exactly ONE skill from the list below that best fits the user's LATEST message.

Available skills:
${catalogText}

Rules:
  - Return ONLY a JSON object — no prose, no markdown.
  - "id" must be one of the ids above, or "none".
  - Prefer the most specific skill that fits the request or the pasted code.
${hasCatchAll ? `  - If the message IS about ABAP/SAP development but no focused skill clearly fits — including short generic requests such as "review this", "optimize my code", "ช่วยดูโค้ดนี้ให้หน่อย", or a plain code paste — return the catch-all id "${catchAllId}". Do NOT return "none" for those.\n` : ''}  - Return "none" ONLY when the message has nothing to do with ABAP/SAP development at all (greetings, small talk, unrelated topics).
  - "confidence" is between 0 and 1.

Schema: {"id": "<skill_id or 'none'>", "confidence": 0.0-1.0, "reason": "<one short sentence>"}`;

    // Phase 40: a follow-up ("แก้ตรงนี้ให้หน่อย") carries no signal of its own —
    // without the previous turns the router could only ever answer "none" to it.
    const recent = (history || []).slice(-ROUTER_HISTORY_TURNS)
        .map(m => `[${m.role}] ${String(m.content || '').slice(0, 800)}`)
        .join('\n');

    try {
        const client = oai || openai;
        // safeChatCompletion handles the 401-fallback to global, but we don't
        // have the userId here — pass undefined so it just rethrows instead
        // (caller's outer try/catch in /api/chat will catch it).
        // Phase 19.3: force JSON output. gpt-4o-mini occasionally wraps its
        // answer in prose ("Sure! Here's the JSON: ...") which then breaks
        // JSON.parse and we'd silently miss-classify the request.
        const messages = [{ role: 'system', content: sys }];
        if (recent) {
            messages.push({ role: 'user', content:
                'Earlier turns, for context only — classify the NEW message that follows:\n' + recent });
        }
        messages.push({ role: 'user', content: routerWindow(fullText) });

        const routerArgs = {
            model:           'gpt-4o-mini',
            max_tokens:      120,
            temperature:     0,
            response_format: { type: 'json_object' },
            messages,
        };
        const resp = await client.chat.completions.create(routerArgs).catch(async (e) => {
            // Auto-fallback for the router specifically: chat works only if
            // the router survives, so trade attribution for availability.
            if ((e?.status === 401) && client !== openai && openai) {
                console.warn('[router] catalog: 401 from project key — retrying with global');
                return await openai.chat.completions.create(routerArgs);
            }
            throw e;
        });
        const raw = resp.choices[0]?.message?.content || '{}';
        const parsed = JSON.parse(raw);
        const id     = String(parsed.id || 'none');
        const conf   = Number(parsed.confidence || 0);
        const reason = String(parsed.reason || '');

        // ── Validate the LLM's pick ───────────────────────────────
        let skill = null;
        if (id !== 'none') {
            const cand = skillPrompts.getSkill(id);
            if (!cand) {
                console.warn(`[router] catalog: unknown id "${id}" — ignoring the pick`);
            } else if (isSkillPlaceholder(cand.content)) {
                console.warn(`[router] catalog: "${cand.id}" still a placeholder — ignoring the pick`);
            } else if (conf < ROUTER_MIN_CONFIDENCE) {
                console.log(`[router] catalog: "${cand.id}" conf=${conf} < ${ROUTER_MIN_CONFIDENCE} — ignoring the pick`);
            } else {
                skill = cand;
            }
        }

        // ── Code-shape upgrade / rescue ───────────────────────────
        // The LLM gave us nothing, or settled for the catch-all. Let the code
        // itself name a focused check when it points at exactly one.
        if (!skill || skill.id === catchAllId) {
            const shapeId = pickSkillFromCodeShape(fullText);
            if (shapeId && shapeId !== (skill && skill.id)) {
                const s2 = skillPrompts.getSkill(shapeId);
                if (s2) {
                    console.log(`[router] code-shape ${skill ? 'upgrade' : 'rescue'}: "${shapeId}" (llm said "${id}" conf=${conf})`);
                    return _skillResult(s2, {
                        confidence: Math.max(conf, ROUTER_MIN_CONFIDENCE),
                        reason:     `code shape → ${shapeId} (llm: ${reason || id})`,
                        source:     'code-shape',
                    });
                }
            }
        }

        if (skill) {
            console.log(`[router] catalog: picked "${skill.id}" (${skill.label}) conf=${conf}`);
            return _skillResult(skill, { confidence: conf, reason, source: 'llm' });
        }

        // ── Catch-all ─────────────────────────────────────────────
        // Trust an explicit "none" only when the message really doesn't look
        // like ABAP work. Otherwise use the catch-all rather than answering
        // with no skill at all — that silent gap is what made the Prompt Lab
        // prompts look like they were never wired up.
        const offTopic = (id === 'none') && !looksLikeAbapCode(fullText);
        if (!offTopic) {
            const fallback = skillPrompts.getCatchAllSkill();
            if (fallback) {
                console.log(`[router] catch-all: "${fallback.id}" (llm said "${id}" conf=${conf})`);
                return _skillResult(fallback, {
                    confidence: conf,
                    reason:     reason || 'generic ABAP request → catch-all',
                    source:     'catch-all',
                });
            }
        }

        console.log(`[router] catalog: id="${id}" conf=${conf} → no prompt injected (reason: ${reason})`);
        return _noSkill(reason, conf);
    } catch (e) {
        console.warn('[router] pickSkillFromCatalog failed:', e.message);
        return _noSkill('router error: ' + e.message);
    }
}

return {
    isSkillPlaceholder, pickSkillFromCodeShape, skillsForCode,
    MAX_SUPPORTING_SKILLS, supportingKnowledgeBlock,
    routerWindow, pickSkillFromCatalog,
};
};
