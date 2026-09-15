// skill-router.js — เลือก skill จาก catalog: code-shape fast path -> LLM -> catch-all
const abapScan  = require('../../lib/abap-scan');
const promptLib = require('../../lib/prompt');
const { looksLikeAbapCode, proseOf } = abapScan;

module.exports = function createSkillRouter({ ai, skillPrompts }) {
const { openai } = ai;
function isSkillPlaceholder(content) {
    return skillPrompts.isPlaceholder(content);
}


// ลำดับตัดสิน: paste เปล่าตัดสินจากโค้ด (ไม่เรียก LLM) → gpt-4o-mini เลือกจาก catalog → ต่ำ/ใช้ไม่ได้
// ตกไป code-shape แล้ว catch-all; ไม่มี skill เฉพาะเมื่อไม่ใช่เรื่อง ABAP จริง ๆ. source ติดไปกับ event

// กติกา code-shape อยู่ lib/abap-scan; สองตัวนี้แค่เช็คว่า skill มีใน catalog และไม่ใช่ placeholder.
// ไม่ override pick ที่มั่นใจของ LLM
function pickSkillFromCodeShape(text) {
    // filter placeholders first, then require exactly one survivor — the order matters
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

// supportingKnowledgeBlock lives in lib/prompt.js; the registry is passed in so it is testable without a DB.
const MAX_SUPPORTING_SKILLS   = promptLib.MAX_SUPPORTING_SKILLS;
const supportingKnowledgeBlock = (ids) => promptLib.supportingKnowledgeBlock(ids, skillPrompts);

const ROUTER_HEAD_CHARS     = 1500;
const ROUTER_TAIL_CHARS     = 1500;
const ROUTER_MIN_CONFIDENCE = 0.5;
const ROUTER_HISTORY_TURNS  = 2;

/** Head + tail window of the message: declarations at the top and the logic/instruction at the bottom matter most. */
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
        // no usable catalog — caller falls through to the base SAP/ABAP prompt
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

    // the LLM must echo back the id exactly
    const catalogText = catalog.map(s =>
        `- id: "${s.id}"\n    label: ${s.label}\n    description: ${s.description}`
    ).join('\n');

    const catchAllId  = skillPrompts.getCatchAllId();
    const hasCatchAll = catalog.some(s => s.id === catchAllId);

    const sys = `You are a router for an SAP/ABAP development assistant (code review and code generation). Pick exactly ONE skill from the list below that best fits the user's LATEST message.

Available skills:
${catalogText}

Rules:
  - Return ONLY a JSON object — no prose, no markdown.
  - "id" must be one of the ids above, or "none".
  - Prefer the most specific skill that fits the request or the pasted code.
${hasCatchAll ? `  - If the message IS about ABAP/SAP development but no focused skill clearly fits — including short generic requests such as "review this", "optimize my code", "ช่วยดูโค้ดนี้ให้หน่อย", or a plain code paste — return the catch-all id "${catchAllId}". Do NOT return "none" for those.\n` : ''}  - Return "none" ONLY when the message has nothing to do with ABAP/SAP development at all (greetings, small talk, unrelated topics).
  - "confidence" is between 0 and 1.

Schema: {"id": "<skill_id or 'none'>", "confidence": 0.0-1.0, "reason": "<one short sentence>"}`;

    // a follow-up ("แก้ตรงนี้ให้หน่อย") has no signal of its own without the previous turns
    const recent = (history || []).slice(-ROUTER_HISTORY_TURNS)
        .map(m => `[${m.role}] ${String(m.content || '').slice(0, 800)}`)
        .join('\n');

    try {
        const client = oai || openai;
        // no userId here, so errors throw to /api/chat; response_format forces JSON
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
            // chat works only if the router survives, so trade attribution for availability
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

        // validate the LLM's pick
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
