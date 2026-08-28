// skill-router.js — เลือก skill จาก catalog: code-shape fast path -> LLM -> catch-all
const abapScan  = require('../../lib/abap-scan');
const promptLib = require('../../lib/prompt');
const { looksLikeAbapCode, proseOf } = abapScan;

module.exports = function createSkillRouter({ ai, skillPrompts }) {
const { openai } = ai;
function isSkillPlaceholder(content) {
    return skillPrompts.isPlaceholder(content);
}


// ── SKILL ROUTER — เลือก system prompt จาก catalog (tbl_prompt) ──

// ลำดับตัดสิน: paste เปล่า ๆ ตัดสินจากโค้ด (ไม่เรียก LLM) → gpt-4o-mini เลือกจาก catalog (เห็นหัว+ท้าย
// ของข้อความ + 2 turn ล่าสุด) → ต่ำ/ใช้ไม่ได้ตกไป code-shape แล้ว catch-all — จะไม่มี skill ก็ต่อเมื่อ
// ไม่ใช่เรื่อง ABAP จริง ๆ; source (llm/code-shape/catch-all) ติดไปกับ event ให้ UI บอกที่มา

// กติกา code-shape อยู่ lib/abap-scan — สองตัวนี้แค่เช็คกับ catalog ว่า skill มีจริงและไม่ใช่ placeholder
// ใช้เฉพาะที่ไม่มีเจตนา user ให้ตีความผิด — ไม่ override pick มั่นใจของ LLM
function pickSkillFromCodeShape(text) {
    // filter ก่อนแล้วค่อยเช็คเหลือหนึ่ง — v1.11.4 สลับลำดับแล้วเคสมี placeholder แตก (v1.11.6 แก้กลับ)
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

// supportingKnowledgeBlock moved to lib/prompt.js. The registry is
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

    // fast path เฉพาะ paste ที่ไม่มีคำพูดเลย — พิมพ์อะไรมาด้วยให้ LLM เพราะคำพูดชนะรูปโค้ด
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

    // a follow-up ("แก้ตรงนี้ให้หน่อย") carries no signal of its own —
    // without the previous turns the router could only ever answer "none" to it.
    const recent = (history || []).slice(-ROUTER_HISTORY_TURNS)
        .map(m => `[${m.role}] ${String(m.content || '').slice(0, 800)}`)
        .join('\n');

    try {
        const client = oai || openai;
        // ไม่มี userId ตรงนี้เลยไม่ใช้ fallback หรู ๆ — throw ให้ /api/chat จับ; response_format บังคับ JSON กัน parse พัง
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

        // LLM ว่าง/ได้ catch-all → ให้โค้ดชี้ check เฉพาะทางเมื่อชี้ได้ตัวเดียว
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

        // เชื่อ "none" เฉพาะข้อความที่ไม่ใช่ ABAP จริง ๆ — นอกนั้น catch-all กันช่องว่างเงียบ
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
