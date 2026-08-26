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

const ABAP_CODE_RE = /\b(REPORT|FORM|ENDFORM|DATA|TYPES|SELECT|ENDSELECT|LOOP|ENDLOOP|MOVE|PERFORM|APPEND|MODIFY|CLASS|ENDCLASS|METHOD|ENDMETHOD|FUNCTION|ENDFUNCTION|CALL FUNCTION|FIELD-SYMBOLS)\b/i;
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
// No `a` or `an`: both are legal ABAP identifiers, and `DATA a TYPE c.` was
// being read as English. Every word below is one no ABAP statement contains.
const PROSE_MARKER_RE = /\b(the|this|these|those|please|my|your|you|what|how|why|should|would|could|need|want|help|tell|wrong|through|about|me)\b/i;

function isStatementLine(line) {
    const l = String(line || '');
    if (!ABAP_STMT_START_RE.test(l)) return false;
    // Two gates, and both are needed.
    //
    // Prose words alone are not enough: "data type for a currency" — the middle
    // line of a soft-wrapped English question — contains none of them.
    // A terminator alone is not enough either: "Create a unit test for this
    // class." ends in a period. A statement both ends somewhere (a period, or a
    // comma continuing a chain) AND carries no word an ABAP statement never has.
    if (PROSE_MARKER_RE.test(l)) return false;
    return /[.,]\s*(?:"[^"]*)?$/.test(l.replace(/\s+$/, ''));
}

/** Continuation of the statement above — the second line of a DATA: chain, the
 *  EXPORTING block of a CALL FUNCTION, a WHERE clause on its own line. It opens
 *  with no keyword, so isStatementLine says no, but it is still code and must
 *  not be mistaken for something the user typed. Recognised by the shapes only
 *  code has: an assignment, a trailing comma, an ABAP type or parameter
 *  keyword, or an @-escaped host variable. */
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
    return ABAP_STMT_START_RE.test(l) && !PROSE_MARKER_RE.test(l);
}

function isContinuationLine(line) {
    const l = String(line || '').trim();
    if (!l) return false;
    // The keyword list below includes AND and OR, which are also English words —
    // "Read through this and tell me what is wrong." tripped it. Same rule as
    // isStatementLine: prose disqualifies a line no matter what it contains.
    if (PROSE_MARKER_RE.test(l)) return false;
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
        if (/^\s*LOOP\s+AT\b/.test(l) || /^\s*DO\b/.test(l) || /^\s*WHILE\b/.test(l)) depth++;
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
        if (isStatementLine(body) && /\.\s*$/.test(body.replace(/\s+$/, '')) && ++n >= 2) return true;
    }
    return false;
}

const ROUTER_CODE_RULES = [
    { id: 'select_loop_check',     test: hasSelectInsideLoop },
    { id: 'delete_commented_code', test: hasCommentedOutCode },
    // [^.\n] not [^.] — a dot inside a character class is a literal period, so
    // the old pattern crossed lines and let an unterminated DATA: chain swallow
    // a SQL `WHERE x LIKE y` three lines below it.
    { id: 'like_check',            test: t => /\bLIKE\s+'%/i.test(_liveCodeOf(t))
                                           || /^\s*(DATA|PARAMETERS|SELECT-OPTIONS)\b[^.\n]*\bLIKE\b/im.test(_liveCodeOf(t)) },
    // TABLES[\s:] to match checkAbapSyntax in this same file — it called
    // `TABLES mara.` an error while this rule ignored it, so the model was told
    // the file had a TABLES problem but never given the skill that explains it.
    { id: 'obsolete_check',        test: t => /^\s*TABLES[\s:]/im.test(_liveCodeOf(t))
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

/** The user's own words, with ABAP statement lines stripped — used to tell a
 *  bare code paste apart from a real instruction. */
/** The first line of the message that is a person talking, not code. Used to
 *  seed the document search from what the user actually asked. */
function firstProseLine(text) {
    return String(text || '').split('\n').map(l => l.trim())
        .find(l => l && !_isCommentLine(l) && !isStatementOpener(l) && !isContinuationLine(l)) || '';
}

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
        { pattern: /^\s*TABLES[\s:]/i,       severity: 'error',   msg: 'Obsolete: TABLES statement — ใช้ DATA declaration แทน' },
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
    const BLOCK_RULES = [
        { pattern: /^\s*SELECT\b[\s\S]*?^\s*ENDSELECT/im, severity: 'error', msg: 'SELECT...ENDSELECT loop — ใช้ SELECT...INTO TABLE แทน', anchor: /^\s*SELECT\b/i },
        { pattern: /^\s*CLEAR\s+(\w+)\s*\.[\s\S]{0,80}?^\s*REFRESH\s+\1\s*\./im, severity: 'info', msg: 'ใช้ FREE แทน CLEAR+REFRESH เพื่อคืน memory', anchor: /^\s*CLEAR\b/i },
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

    const liveText = live.join('\n');
    BLOCK_RULES.forEach(rule => {
        if (!rule.pattern.test(liveText)) return;
        const at = live.findIndex(l => rule.anchor.test(l));
        issues.push({
            line: at + 1, severity: rule.severity, message: rule.msg,
            code: (live[at] || '').trim(),
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
    ABAP_CODE_RE, ABAP_STMT_START_RE,
    looksLikeAbapCode, proseOf, firstProseLine, isStatementLine,
    isCommentLine: _isCommentLine,
    hasSelectInsideLoop, hasCommentedOutCode, hasCommentedParamsInCall,
    ROUTER_CODE_RULES, ORCHESTRATION_EXTRA_RULES,
    codeShapeSkillId, matchingSkillIds,
    checkAbapSyntax,
};
