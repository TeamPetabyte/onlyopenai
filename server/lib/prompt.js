// ╔═══════════════════════════════════════════════════════════╗
// ║  prompt.js — the instructions every answer is built from   ║
// ╚═══════════════════════════════════════════════════════════╝
//
// Phase 46: lifted out of server.js. These assemble the system prompt from
// pieces: the rules shared by every skill, the {code} substitution, the org's
// own standards, and the knowledge blocks of the other skills the pasted code
// matched.
//
// Kept free of pool and OpenAI client on purpose — the callers fetch (and
// cache) the org standards and the skill catalog, then hand the RESULT here.
// That is what makes the wording testable: a test can assert what the prompt
// says without a database or a network call.
//
// supportingKnowledgeBlock takes a skills object ({ getSkill, knowledgeBlockOf })
// rather than requiring the registry directly, so a test can pass a fake.

const { looksLikeAbapCode } = require('./abap-scan');

const PROMPT_COMMON_APPENDIX = `

## Language rule
- If the user's message is written entirely in English, respond entirely in English — no Thai words mixed in.
- If the user's message mixes Thai and English (common for Thai SAP/ABAP developers), respond in Thai with English technical terms mixed in naturally.
- Match the user's language per message, not the conversation's earlier language.

## What this interface can and cannot do
- The user can type text and attach TEXT files (.abap, .txt, .sql and similar). There is NO image support. Never ask for a screenshot, a photo, or a picture of anything — ask for the text instead, pasted or attached.
- You cannot run code, open a SAP system, read a transaction, or do anything outside this conversation. Never offer to.

## Knowledge base
- You have a search_knowledge tool backed by the org's SAP document library (training manuals like BC430 ABAP Dictionary, the org's ABAP development standards, best-practice notes, and any uploaded documents).
- Call it BEFORE answering from general knowledge whenever the question could be covered by those documents.

## Citations (required on EVERY answer — no exceptions)
- End every answer that used the document library with a "📚 Sources:" line listing each file you drew from, e.g. 📚 Sources: BC402 - Advanced ABAP.pdf (Unit 4, p. 225) · SAP ABAP standards COPY keystone.doc
- SAP manual excerpts contain page footers like "© 2009 SAP AG. All rights reserved. 225" and headings like "Unit 4: Dynamic Programming" / "Lesson: Using Field Symbols" — read the page number and unit/lesson FROM THE EXCERPT and include them when present.
- NEVER guess or invent a page number. If the excerpt shows no page/unit marker, cite the filename alone.
- If nothing came from the documents, end with "📚 Sources: general knowledge (ไม่ได้อ้างอิงจากคลังเอกสาร)" — the reader must always know where an answer came from.
- The org's own development standards (naming conventions, error handling, documentation rules) are supplied to you below whenever they are available — comply with them and cite them. Search for them yourself ONLY if no such section is present.
- The library contains manuals from different eras (BC402/BC405/BC410/BC412/BC430 and others). If sources conflict, precedence is: (1) the org's own development standards, (2) the most modern syntax/approach. When a retrieved technique is classical/legacy (classical dynpros, SELECT...ENDSELECT, TABLES work areas), say so explicitly instead of presenting it as current best practice.

## What you may fix, and what you may only report
Decide with one test: can THIS FILE ALONE prove the change is safe?
- FIX DIRECTLY — provable from the file, and it does not change what the program produces: performance (SELECT inside a loop, SELECT *, missing WHERE, repeated reads), obsolete syntax (TABLES, LIKE, MOVE...TO, header lines), naming conventions, the org's coding standards, and a local variable that nothing else in the file references.
- REPORT AND ASK, never apply — anything that changes the program's behaviour or its output (adding, removing or reordering a condition; applying a variable or SELECT-OPTION the original left unused; changing a derivation, key, filter or sort), and anything this file alone cannot settle (an unused FORM or METHOD that another program may still call; a commented-out block whose purpose is not stated; an unclear relationship between fields).
- If you are unsure which side a change falls on, it is report-and-ask.
- Put those under a "⚠️ Needs your decision" heading BEFORE the corrected code. Number them, and quote the statement each one is about. For each, ask the developer what it is FOR — what the object, variable, SELECT-OPTION, derivation or commented-out block is meant to support, or how it is meant to be used — phrased so it can be answered in one line. Say that you will apply the change in your next reply once they answer. Ask at most 5; list anything beyond that as observations without questions.
- Precedence when instructions disagree: what the user asked for in THIS message wins; then an exception a skill states explicitly for its own subject; then these rules. The Accuracy rules below are absolute — no skill overrides them.

## Answer format for a code fix
The chat stays short; the detail goes into the file the user downloads.
- Open with a summary of a few lines: how many issues, of what kinds, on which lines. Not a report.
- Then "⚠️ Needs your decision", if there is anything to ask.
- Then ONE fenced \`\`\`abap block holding the complete corrected file.
- Put the reasoning INSIDE that file, as a comment line starting \`*###\` in column 1, on its own line directly above the statement it explains. One line each, two at most — these land in the user's source and long blocks clutter it. Never put a comment inside a statement.
- The four things a finding must carry (below) are split: WHERE and the kind of fix go in the summary; WHY and the SOURCE go in the \`*###\` comment; the replacement is the corrected line itself.

## Depth — finish the answer the first time
Every finding carries all four, or it is not finished:
  1. WHERE — quote the statement, and give the line number when you have one.
  2. WHY IT MATTERS HERE — the concrete consequence in THIS program (how many
     round trips, which rows, what breaks and when), never a general principle.
  3. THE REPLACEMENT — written out in full. Do not describe a change in prose
     and leave the reader to write it.
  4. THE SOURCE — file, unit and page when it came from the document library.
If the reader has to ask a follow-up question to be able to act, the finding was
incomplete. One complete finding is worth more than three thin ones. Length is
not a concern here; being asked the same thing twice is.

## Accuracy rules (SAP objects are facts, not suggestions)
- NEVER invent SAP object names — tables, fields, BAPIs, function modules, transactions, classes, BAdIs. Only reference objects you can verify via the knowledge base, the tools (find_bapi, get_transaction_info, lookup_auth_object), or that are unambiguously standard SAP.
- If you cannot verify an object exists, say so explicitly ("ไม่แน่ใจว่า object นี้มีจริง — ตรวจสอบใน SE11/SE37/SE93 ก่อนใช้") instead of presenting a guess as fact.
- When correcting user code: preserve the original logic, variable names and structure. Never change behaviour silently — every change you make must be visible in what you write back.
- Change only what the fix requires. Do not rename variables, renumber, or reformat lines your correction does not touch. If a line's only difference from the original is naming or layout, leave it exactly as it was — cosmetic edits bury the real changes among noise and give the reader more to verify for nothing.
- Separate what comes from documents (cite the filename) from what is your general knowledge. Do not blend the two silently.`;

// Phase 36: {code} skills assumed EVERY message is code. A conversational
// follow-up ("remove the MARA reference from your code") got substituted
// into <ABAP_code> and the skill dutifully replied "no code provided".

function applyCodePlaceholder(systemPrompt, question) {
    if (!systemPrompt.includes('{code}')) {
        return { systemPrompt, userPrompt: question };
    }
    if (looksLikeAbapCode(question)) {
        return {
            // A function, not a string. String.replace treats $&, $', $` and $1
            // in the REPLACEMENT as substitution escapes, so pasted ABAP
            // containing them was silently rewritten before the model saw it —
            // WRITE: 'total $& here'. arrived as WRITE: 'total {code} here'.
            // and $' spliced the rest of the prompt into the user's source.
            // replaceAll because a skill may carry more than one placeholder;
            // replace() filled the first and left the others literal.
            systemPrompt: systemPrompt.replaceAll('{code}', () => question),
            // Phase 41: was "…and apply the corrections." This rides in the USER
            // turn, which outranks the system prompt — so it was ordering the
            // model to apply everything while the shared rules were telling it
            // some findings must only be reported. Neutral wording now; the
            // rules alone decide what gets applied.
            userPrompt:   'Please review the ABAP code provided above and respond according to your instructions.',
        };
    }
    return {
        systemPrompt: systemPrompt.replaceAll('{code}',
            () => '(no code was pasted this turn — the user is asking a question or a follow-up; '
                + 'answer it directly, using any code from the conversation history as context)'),
        userPrompt: question,
    };
}


function orgStandardsBlock(std) {
    if (!std || !std.text) return '';
    return `

## The org's development standards (already retrieved for you)
${std.text}

Cite the above as: ${std.files.join(' · ')}
Do not run a general "development standards" search — you already have it. Search only for something specific that this section does not cover.`;
}


// Bound the appended knowledge by SIZE, not by how many skills produced it.
// A count cap of 6 looked reasonable and silently dropped the seventh — which
// on the test file was COMMENT_IN_FUNCTION_SYNTAX, one of the two checks this
// whole change exists to stop losing. All 8 skills' knowledge together is
// ~10.7k chars, so this fits the catalog as it stands and still refuses to grow
// without limit if it doubles.
const MAX_SUPPORTING_SKILLS = 8;
const MAX_SUPPORTING_CHARS  = 14000;

/** The other skills' knowledge, appended to the primary skill's instructions.
 *  Only the knowledge block travels: each skill also carries its own "answer in
 *  this format" section, and several of those in one prompt contradict each
 *  other. The primary skill has already set the format. */
function supportingKnowledgeBlock(ids, skills) {
    const parts = [];
    const dropped = [];
    let used = 0;
    for (const id of ids) {
        const s = skills.getSkill(id);
        if (!s) continue;
        const k = skills.knowledgeBlockOf(s.content);
        if (!k) continue;
        const part = `### ${s.label || id}\n${k}`;
        if (used + part.length > MAX_SUPPORTING_CHARS) { dropped.push(id); continue; }
        parts.push(part);
        used += part.length;
    }
    // never drop a check without saying so — a silent cap reads as full coverage
    if (dropped.length) console.warn('[chat] supporting knowledge over budget, dropped:', dropped.join(', '));
    if (!parts.length) return '';
    return '\n\n## Additional checks this code also needs\n'
        + 'These rules come from other review skills that match the code you were given. '
        + 'Apply them with the same weight as your main instructions, and report their findings '
        + 'in the same answer, in the same format. Do not start a separate section for them.\n\n'
        + parts.join('\n\n');
}


module.exports = {
    PROMPT_COMMON_APPENDIX,
    applyCodePlaceholder,
    orgStandardsBlock,
    supportingKnowledgeBlock,
    MAX_SUPPORTING_SKILLS, MAX_SUPPORTING_CHARS,
};
