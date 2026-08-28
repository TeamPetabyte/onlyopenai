// @ts-check
// ╔═══════════════════════════════════════════════════════════╗
// ║  abap-scan.js — reading pasted ABAP by rule, not by model  ║
// ╚═══════════════════════════════════════════════════════════╝
//
// Phase 46: lifted out of server.js. Everything here is a pure function of a
// string — no pool, no OpenAI client, no skill registry — so each rule can be
// tested against a snippet directly instead of only through a live request.
//
// One deliberate change of shape while moving. server.js filtered matched rule
// ids against the skill catalog INSIDE these functions, which tied text
// matching to a database. They now return ids and the caller decides which of
// those skills exist — hence codeShapeSkillId and matchingSkillIds take no
// registry argument. The filtering still happens, in server.js, unchanged.

function looksLikeAbapCode(text) {
    const t = String(text || '');
    if (t.split('\n').length < 3) return false;
    // A keyword alone is not code: "How do I select the right / data type for a
    // currency / field in a class?" is three lines and contains DATA, SELECT and
    // CLASS. Require a line that actually PARSES as a statement — opens with a
    // keyword and terminates with a period — before treating the message as a
    // paste, because that decision substitutes the text into the skill's
    // <ABAP_code> block and runs a static scan over it.
    return t.split('\n').some(l => !_isCommentLine(l) && isStatementLine(l));
}

function _isCommentLine(line) { return /^\s*[*"]/.test(line); }

/** True when a line reads as an ABAP STATEMENT rather than a sentence.
 *
 *  Starting with a keyword is not enough, and that was the bug behind three
 *  separate defects. ABAP_STMT_START_RE contains CREATE, WRITE, DELETE, CHECK,
 *  READ and SET — all ordinary English imperatives — so "Create a unit test for
 *  this class." was stripped as if it were code, proseOf() returned empty, and
 *  the message took the bare-paste fast path that skips the router entirely.
 *  The comment above ABAP_STMT_START_RE says this must not happen; it was
 *  happening for every synonym of "generate".
 *
 *  A statement also ENDS somewhere: ABAP terminates on a period, and a
 *  continued statement (a DATA: chain, a multi-line SELECT) ends on a comma or
 *  an opening that clearly continues. A sentence ends in a word, a question
 *  mark, or nothing at all. */
// Listing English words was the wrong shape of rule and it failed twice. The
// first cut missed "Read through this and tell me what is wrong."; the second
// still ate "Create a unit test." and "Delete unused variables." — the very
// defect it was written to fix — because those happen to use none of the
// twenty listed words. A blocklist of a natural language cannot be finished.
//
// So ask the opposite question, about ABAP rather than about English: does
// this line carry any of the marks a statement has and a sentence does not?
// An operator, a literal, a colon, an @-escape, an identifier with an
// underscore or a structure dash, or a second ABAP keyword in a position only
// code puts one. A sentence has none of them.
// Marks that are code and nothing else. No English word is on this list, so it
// can be applied to a line that has not already declared itself ABAP.
const CODE_MARK_RE = new RegExp([
    '[=<>]',                       // assignment or comparison
    "['\u0060]",                   // a quoted or backtick literal
    '@\\w',                        // an escaped host variable
    ':\\s',                        // a chained statement
    '\\w_\\w',                     // lv_total, gt_flight — ABAP naming
    '\\w-\\w',                     // sy-subrc, wa-matnr
    '\\b\\d',                       // a numeric literal
].join('|'), 'i');

// Words that mean code only once the line has ALREADY opened with an ABAP
// keyword. On their own they are ordinary English — "Refactor into a class"
// and "Convert from FORM to METHOD" were both read as continuations of a
// statement because they contain INTO and FROM.
const CODE_WORD_RE = new RegExp(
    ',|\\b(TYPE|LIKE|INTO|FROM|WHERE|VALUE|USING|CHANGING|EXPORTING|IMPORTING|'
    + 'EXCEPTIONS|TABLES|OCCURS|SINGLE|APPENDING|TRANSPORTING|BINARY|STANDARD|'
    + 'REF|BEGIN\\s+OF|END\\s+OF|ASSIGNING|COMPONENTS)\\b', 'i');

const CODE_SHAPE_RE = new RegExp(CODE_MARK_RE.source + '|' + CODE_WORD_RE.source, 'i');

// English function words that are NOT also ABAP keywords. Unlike verbs this is
// a closed class, so the list can be short and stay short — and it is only ever
// a veto, applied after the unambiguous code marks have had their say.
const ENGLISH_FUNCTION_RE = /\b(a|an|the|this|that|these|those|it|its|my|your|our|their|his|her|please|what|how|why|which|who|would|should|could|can|will|must|have|has|had|been|being|was|were|are|about|than|but|very|just|also|too|again|here|there|now|me|you|we|they|he|she|more|most|each|every|because|however)\b/i;

// A parameter section header standing alone inside a CALL FUNCTION.
const BARE_PARAM_RE = /^(EXPORTING|IMPORTING|CHANGING|TABLES|EXCEPTIONS|RECEIVING)$/i;

/** How many words the line holds. `REPORT z.` and `ENDLOOP.` are whole
 *  statements carrying none of the marks above; nothing a person types is that
 *  short and also opens with an ABAP keyword. */
function _wordCount(l) { return String(l).trim().split(/\s+/).filter(Boolean).length; }

function isStatementLine(line) {
    const l = String(line || '');
    if (!ABAP_STMT_START_RE.test(l)) return false;
    // A statement ends somewhere — a period, or a comma continuing a chain.
    if (!/[.,]\s*(?:"[^"]*)?$/.test(l.replace(/\s+$/, ''))) return false;
    return _isCodeShaped(l);
}

/** Order matters here, and getting it wrong is what let "Select the right data
 *  type" through: CODE_WORD_RE contains TYPE, so the ambiguous half matched
 *  before anything had a chance to notice the English.
 *
 *  Unambiguous marks decide first. Then English function words veto — they are
 *  never ABAP, so anything carrying one is a sentence. Only then do the
 *  ambiguous words get a say. */
function _isCodeShaped(l) {
    if (CODE_MARK_RE.test(l)) return true;
    if (ENGLISH_FUNCTION_RE.test(l)) return false;
    return _wordCount(l) <= 2 || CODE_WORD_RE.test(l);
}

/** Opens a statement that finishes on a later line — `SELECT carrid connid`,
 *  `CALL FUNCTION 'Z_X'`, the first line of a multi-line WHERE. It is code, so
 *  proseOf must not hand it back as something the user typed: the bare-paste
 *  fast path only fires when proseOf() is empty, and four leaked opener lines
 *  meant a genuinely bare paste never took it.
 *
 *  Deliberately weaker than isStatementLine — no terminator required — which is
 *  why looksLikeAbapCode does NOT use this one. Deciding "this message is a
 *  paste" needs a line that actually completes; deciding "this line is not
 *  prose" does not. */
function isStatementOpener(line) {
    const l = String(line || '');
    if (!ABAP_STMT_START_RE.test(l)) return false;
    if (_isCodeShaped(l)) return true;
    // `SELECT carrid connid fldate bookid` — the comma-less Open SQL field list,
    // which is exactly the syntax this product exists to modernise, so it must
    // read as code. Narrowed to SELECT and to UNTERMINATED lines, because those
    // two conditions are what make it safe: a comma-less field list happens
    // only after SELECT, a terminated line is isStatementLine's question
    // ("Delete unused variables." looks identical there and is not code), and
    // without the SELECT restriction "Do not use nested queries" qualified too.
    if (!/^\s*SELECT\b/i.test(l)) return false;
    if (/[.,]\s*$/.test(l)) return false;
    if (ENGLISH_FUNCTION_RE.test(l)) return false;
    return l.trim().split(/\s+/).every(t => /^[A-Za-z][A-Za-z0-9_]*$/.test(t));
}

/** Continuation of the statement above — the second line of a DATA: chain, the
 *  EXPORTING block of a CALL FUNCTION, a WHERE clause on its own line. It opens
 *  with no keyword, so isStatementLine says no, but it is still code and must
 *  not be mistaken for something the user typed. Recognised by the shapes only
 *  code has: an assignment, a trailing comma, an ABAP type or parameter
 *  keyword, or an @-escaped host variable. */
function isContinuationLine(line) {
    const l = String(line || '').trim();
    if (!l) return false;
    // The keyword list alone matched "optimize and speed up" (AND),
    // "Refactor into a class" (INTO) and "Convert from FORM to METHOD" (FROM).
    // Requiring a code mark as well is what separates a continuation from a
    // sentence that happens to use the same English word.
    if (BARE_PARAM_RE.test(l)) return true;
    // CODE_MARK, not CODE_SHAPE: the keyword half is English too, and the
    // keyword list below would then match it a second time for the same reason.
    if (!CODE_MARK_RE.test(l)) return false;
    return /,$/.test(l)
        || /^[\w-]+\s*=/.test(l)
        || /\b(TYPE|LIKE|VALUE|EXPORTING|IMPORTING|CHANGING|TABLES|EXCEPTIONS|USING|INTO|FROM|WHERE|FOR\s+ALL\s+ENTRIES|AND|OR|UP\s+TO)\b/i.test(l)
        || /@\w/.test(l);
}

/** The code with comment lines removed. The statement rules below must not
 *  read commented-out code as live code — a dead `* SELECT * FROM mara.` used
 *  to trip the SELECT rule as well as the commented-code rule, two hits, and
 *  the whole pick was thrown away as "ambiguous". */
function _liveCodeOf(text) {
    return String(text || '').split('\n').filter(l => !_isCommentLine(l)).join('\n');
}

// A line that is an ABAP STATEMENT rather than something a person typed.
// Keyed on how the line STARTS: statements open with a keyword, prose (Thai or
// English) does not. Matching a keyword anywhere in the line — the first cut of
// this — silently ate real instructions, because "unit test class" contains
// CLASS and "generate a report" contains REPORT.
const ABAP_STMT_START_RE = /^\s*(REPORT|PROGRAM|INCLUDE|TABLES|TYPES|DATA|CONSTANTS|STATICS|FIELD-SYMBOLS|PARAMETERS|SELECT-OPTIONS|CLASS|ENDCLASS|METHOD|ENDMETHOD|INTERFACE|FORM|ENDFORM|FUNCTION|ENDFUNCTION|MODULE|ENDMODULE|START-OF-SELECTION|END-OF-SELECTION|INITIALIZATION|SELECT|ENDSELECT|INSERT|UPDATE|DELETE|MODIFY|APPEND|COLLECT|READ|LOOP|ENDLOOP|DO|ENDDO|WHILE|ENDWHILE|IF|ELSEIF|ELSE|ENDIF|CASE|WHEN|ENDCASE|TRY|CATCH|CLEANUP|ENDTRY|RAISE|MESSAGE|WRITE|MOVE|CLEAR|REFRESH|FREE|CONCATENATE|SPLIT|CONDENSE|TRANSLATE|CALL|PERFORM|SUBMIT|EXPORT|IMPORT|COMMIT|ROLLBACK|CHECK|EXIT|RETURN|SORT|ASSIGN|CREATE|SET|GET|AT|WHERE|AND|OR|INTO|FROM|VALUES|BEGIN|END)\b/i;

/** True when a SELECT sits inside a LOOP/DO/WHILE block (comments ignored). */
function hasSelectInsideLoop(text) {
    let depth = 0;
    for (const raw of String(text || '').split('\n')) {
        if (_isCommentLine(raw)) continue;
        const l = raw.toUpperCase();
        if (depth > 0 && /\bSELECT\b/.test(l)) return true;
        // Anchored to the start of the line. Matching DO or WHILE anywhere meant
        // "please do this fix" opened a loop that never closed, and every SELECT
        // after it in the message counted as nested — and skillsForCode runs on
        // the whole message, prose included.
        // Anchoring alone left "Do you see the problem?" opening a loop that
        // never closed. The line has to BE a statement, which is the same test
        // the rest of this file uses — the earlier fix stopped one level short.
        if ((/^\s*LOOP\s+AT\b/.test(l) || /^\s*DO\b/.test(l) || /^\s*WHILE\b/.test(l))
            && isStatementLine(raw)) depth++;
        if (/^\s*(ENDLOOP|ENDDO|ENDWHILE)\b/.test(l)) depth = Math.max(0, depth - 1);
    }
    return false;
}

/** True when the paste carries commented-OUT ABAP: two or more comment lines
 *  that are whole, terminated statements — dead code, not explanation.
 *
 *  The threshold was 3 because the old test was loose enough that any header
 *  block reached it. Now that a line must strip to a real statement AND end in
 *  a period AND not be a `*&` header, 3 was hiding genuine two-line blocks —
 *  including the `*DATA` / `*PERFORM` pair in this project's own test program,
 *  which stopped matching once the header lines correctly stopped counting. */
function hasCommentedOutCode(text) {
    let n = 0;
    for (const raw of String(text || '').split('\n')) {
        if (!_isCommentLine(raw)) continue;
        // Strip the comment marker and judge what is left as CODE, not as text
        // containing a keyword. Every ABAP program opens with "*& Report ZTEST"
        // and "*& Function: prints a list" — three such lines were enough to
        // call a spotless file dead code and route it, with no LLM call and
        // full confidence, to the skill that deletes commented-out code.
        // `*&` is the box-header convention — "*& Report ZTEST", "*& Author",
        // the *&--- rules. Nobody disables code with it; commenting out uses a
        // plain `*`. Excluding it is what actually separates a header from dead
        // code, because prose markers do not: "*& Report ZTEST" has none.
        if (/^\s*\*&/.test(raw)) continue;
        const body = raw.replace(/^\s*[*"]\s?/, '');
        if (!body.trim()) continue;
        // Real disabled code is a whole statement and terminates. "Report ZTEST"
        // does not; "*DATA lv_legacy TYPE c." does.
        // isStatementLine already decides what terminates a statement, and it
        // deliberately allows a trailing " note. A second, stricter test here
        // contradicted it and dropped `*DATA lv TYPE c. " old` — a disabled
        // statement annotated the way people actually annotate them.
        if (isStatementLine(body) && ++n >= 2) return true;
    }
    return false;
}

// TABLES as the obsolete declaration: the keyword, table names, end of
// statement, nothing else. A CALL FUNCTION parameter section is followed by
// `it = lt`, which this cannot match.
const TABLES_DECL_RE = /^\s*TABLES\s*:?\s*[a-z_][a-z0-9_]*(\s*,\s*[a-z_][a-z0-9_]*)*\s*\.\s*$/im;

const ROUTER_CODE_RULES = [
    { id: 'select_loop_check',     test: hasSelectInsideLoop },
    { id: 'delete_commented_code', test: hasCommentedOutCode },
    // [^.\n] not [^.] — a dot inside a character class is a literal period, so
    // the old pattern crossed lines and let an unterminated DATA: chain swallow
    // a SQL `WHERE x LIKE y` three lines below it.
    { id: 'like_check',            test: t => /\bLIKE\s+'%/i.test(_liveCodeOf(t))
                                           || /^\s*(DATA|PARAMETERS|SELECT-OPTIONS)\b[^.\n]*\bLIKE\b/im.test(_liveCodeOf(t)) },
    // The obsolete DECLARATION is `TABLES mara.` or `TABLES: mara, marc.` — it
    // names tables and then ends. `TABLES` inside a CALL FUNCTION is a parameter
    // section and perfectly current; TABLES[\s:] matched both, and under /m the
    // [\s] even matched the newline after a bare TABLES on its own line.
    { id: 'obsolete_check',        test: t => TABLES_DECL_RE.test(_liveCodeOf(t))
                                           || /\bOCCURS\s+\d/i.test(_liveCodeOf(t))
                                           || /\bENDSELECT\b/i.test(_liveCodeOf(t)) },
    { id: 'select_best_practice',  test: t => /\bSELECT\s+\*/i.test(_liveCodeOf(t))
                                           || /\bFOR\s+ALL\s+ENTRIES\b/i.test(_liveCodeOf(t)) },
];

/** A skill id when EXACTLY ONE rule fires and that skill is usable. Two rules
 *  firing means the code has several problems at once — a judgement call, so
 *  it goes back to the LLM / catch-all instead of us guessing. */
function codeShapeSkillId(text) {
    const hits = ROUTER_CODE_RULES
        .filter(r => { try { return r.test(text); } catch (_) { return false; } })
        .map(r => r.id);
    return hits.length === 1 ? hits[0] : null;
}

/** True when a CALL FUNCTION block still carries commented-out parameters —
 *  the "* TABLES / * it_data =" left behind when someone disabled a parameter
 *  instead of deleting it. Scans from CALL FUNCTION to the closing period. */
function hasCommentedParamsInCall(text) {
    let inCall = false;
    for (const raw of String(text || '').split('\n')) {
        if (/\bCALL\s+FUNCTION\b/i.test(raw)) {
            // `CALL FUNCTION 'Z_FOO'.` is complete on this line. Continuing here
            // without the end-of-statement check left inCall set forever, so the
            // next ordinary note comment containing "=" was reported as a
            // disabled parameter that does not exist.
            inCall = !/\.\s*$/.test(raw.replace(/\s+$/, ''));
            continue;
        }
        if (!inCall) continue;
        if (_isCommentLine(raw)) {
            // a disabled parameter, not a note: "* name = x" or "* TABLES"
            if (/=/.test(raw) || /^\s*[*"]\s*(TABLES|EXPORTING|IMPORTING|CHANGING|EXCEPTIONS)\b/i.test(raw)) return true;
            continue;
        }
        if (/\.\s*$/.test(raw)) inCall = false;
    }
    return false;
}

// Phase 45: rules used ONLY to gather supporting knowledge, deliberately kept
// out of ROUTER_CODE_RULES. That list drives the primary pick through
// pickSkillFromCodeShape, which fires only when exactly one rule matches —
// adding an overlapping rule there (FOR ALL ENTRIES already belongs to
// select_best_practice) would turn a confident single hit into no hit at all.
const ORCHESTRATION_EXTRA_RULES = [
    { id: 'FAE_CHECK_01',               test: t => /\bFOR\s+ALL\s+ENTRIES\b/i.test(_liveCodeOf(t)) },
    { id: 'COMMENT_IN_FUNCTION_SYNTAX', test: hasCommentedParamsInCall },
];

/** Every skill whose check the pasted code trips — not just one. This is the
 *  measured gap: a router that picks one skill missed the commented-out dead
 *  code and the disabled CALL FUNCTION parameters on a file that tripped five
 *  rules at once, because only the chosen skill's knowledge ever arrived. */
function matchingSkillIds(text) {
    const ids = [...ORCHESTRATION_EXTRA_RULES, ...ROUTER_CODE_RULES]
        .filter(r => { try { return r.test(text); } catch (_) { return false; } })
        .map(r => r.id);
    return [...new Set(ids)];
}

/** The first line of the message that is a person talking, not code. Used to
 *  seed the document search from what the user actually asked. */
function firstProseLine(text) {
    return String(text || '').split('\n').map(l => l.trim())
        .find(l => l && !_isCommentLine(l) && !isStatementOpener(l) && !isContinuationLine(l)) || '';
}

/** The user's own words, with ABAP statement lines stripped — used to tell a
 *  bare code paste apart from a real instruction. */
function proseOf(text) {
    return String(text || '').split('\n')
        .filter(l => l.trim() && !_isCommentLine(l)
                     && !isStatementOpener(l) && !isContinuationLine(l))
        .join(' ').trim();
}


function checkAbapSyntax(code) {
    const issues = [];
    const lines  = String(code || '').split('\n');

    // Per-line rules. Every one of these is answerable from a single line.
    const LINE_RULES = [
        { pattern: TABLES_DECL_RE,           severity: 'error',   msg: 'Obsolete: TABLES statement — ใช้ DATA declaration แทน' },
        { pattern: /\bMOVE\s+.+\s+TO\s+/i,  severity: 'warning', msg: 'Obsolete: MOVE...TO — ใช้ = assignment แทน' },
        { pattern: /\bSELECT\s+\*/i,         severity: 'warning', msg: 'SELECT * ควร select เฉพาะ fields ที่ใช้จริงเพื่อ performance' },
        { pattern: /\bWRITE\s*:/i,            severity: 'info',    msg: 'WRITE: ใช้ได้สำหรับ classic report แต่ไม่รองรับ Fiori/ALV' },
        // AND RETURN is an addition to CALL TRANSACTION / LEAVE TO TRANSACTION.
        // The old text told the model to use CALL METHOD, which replaces a
        // different obsolete form and has nothing to do with this one — and the
        // model receives these messages as established findings, not guesses.
        { pattern: /\bAND\s+RETURN\b/i,       severity: 'warning', msg: 'AND RETURN เป็น obsolete — ใช้ CALL TRANSACTION โดยไม่มี AND RETURN หรือ SUBMIT ... AND RETURN แทน' },
    ];

    // Rules that span lines. These were in the same list and run per line, so
    // they could never match — including SELECT...ENDSELECT, which is one of
    // only two `error` rules and therefore half of what `valid` means. The
    // pre-analysis block was telling the model "no errors found" on a file
    // built around a SELECT...ENDSELECT loop.
// Walked line by line rather than matched with a regex. A regex finds the
// LEFTMOST match, so `/SELECT[\s\S]*?ENDSELECT/` opened at the first SELECT in
// the file even when a correct `SELECT SINGLE ... .` sat above the real loop —
// and the finding was reported against that correct statement. Lazy matching
// shortens the match; it does not move where it starts.
function _findSelectEndselect(live) {
    const out = [];
    let openAt = -1;
    live.forEach((l, i) => {
        if (/^\s*ENDSELECT\b/i.test(l)) {
            if (openAt >= 0) out.push(openAt);
            openAt = -1;
            return;
        }
        // The loop head is simply the LAST SELECT before the ENDSELECT. A
        // trailing period does not distinguish it — a SELECT...ENDSELECT loop
        // ends its SELECT with a period exactly like a single-row read does.
        // What separates them is whether an ENDSELECT ever arrives.
        if (/^\s*SELECT\b/i.test(l)) openAt = i;
    });
    return out;
}

function _findClearRefresh(live) {
    const out = [];
    live.forEach((l, i) => {
        const m = /^\s*CLEAR\s+(\w+)\s*\.\s*$/i.exec(l);
        if (!m) return;
        const next = live[i + 1] || '';
        if (new RegExp('^\\s*REFRESH\\s+' + m[1] + '\\s*\\.\\s*$', 'i').test(next)) out.push(i);
    });
    return out;
}

    const BLOCK_RULES = [
        { find: _findSelectEndselect, severity: 'error', msg: 'SELECT...ENDSELECT loop — ใช้ SELECT...INTO TABLE แทน' },
        { find: _findClearRefresh,    severity: 'info',  msg: 'ใช้ FREE แทน CLEAR+REFRESH เพื่อคืน memory' },
    ];

    // Comments are not code. Every router rule in this file strips them with
    // _liveCodeOf before matching; this one did not, so dead `* MOVE a TO b.`
    // lines were handed to the model under the heading "detected by a static
    // scan, line numbers are exact, treat them as given" — instructing it to
    // fix statements that do not run.
    const live = lines.map(l => (_isCommentLine(l) ? '' : l));

    live.forEach((line, i) => {
        if (!line.trim()) return;
        LINE_RULES.forEach(rule => {
            if (rule.pattern.test(line)) {
                issues.push({ line: i + 1, severity: rule.severity, message: rule.msg, code: line.trim() });
            }
        });
    });

    // Every occurrence, each pinned to the line its own block opens on —
    // buildPreAnalysis tells the model the line numbers are exact.
    BLOCK_RULES.forEach(rule => {
        rule.find(live).forEach(at => {
            issues.push({
                line: at + 1, severity: rule.severity, message: rule.msg,
                code: (live[at] || '').trim(),
            });
        });
    });

    issues.sort((a, b) => a.line - b.line);

    return {
        valid:      issues.filter(x => x.severity === 'error').length === 0,
        issueCount: issues.length,
        issues:     issues.slice(0, 10),
        summary:    issues.length === 0
            ? '✅ ไม่พบปัญหา syntax'
            : `พบ ${issues.length} ปัญหา (${issues.filter(x => x.severity === 'error').length} error, ${issues.filter(x => x.severity === 'warning').length} warning)`,
    };
}


module.exports = {
    // ABAP_CODE_RE and ABAP_STMT_START_RE are deliberately NOT exported. The
    // first is unused since isStatementLine replaced it; the second was
    // exported only for the hand-copied predicate in server.js that
    // firstProseLine now serves. A published regex nothing answers to reads
    // like a contract.
    looksLikeAbapCode, proseOf, firstProseLine, isStatementLine,
    isCommentLine: _isCommentLine,
    hasSelectInsideLoop, hasCommentedOutCode, hasCommentedParamsInCall,
    ROUTER_CODE_RULES, ORCHESTRATION_EXTRA_RULES,
    codeShapeSkillId, matchingSkillIds,
    checkAbapSyntax,
};
