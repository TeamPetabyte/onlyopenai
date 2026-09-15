// @ts-check
// Pure-string ABAP heuristics: is this message a paste, which rules does the code
// trip, which lines are the user's own words. Rule ids come back unfiltered; the
// caller checks them against the skill registry.

function looksLikeAbapCode(text) {
    const t = String(text || '');
    if (t.split('\n').length < 3) return false;
    // Keywords alone are not enough (English prose contains DATA/SELECT/CLASS);
    // require at least one line that parses as a statement.
    return t.split('\n').some(l => !_isCommentLine(l) && isStatementLine(l));
}

function _isCommentLine(line) { return /^\s*[*"]/.test(line); }

// Marks only code has. No English word is on this list, so it can be applied
// to a line that has not already declared itself ABAP.
const CODE_MARK_RE = new RegExp([
    '[=<>]',                       // assignment or comparison
    "['\u0060]",                   // a quoted or backtick literal
    '@\\w',                        // an escaped host variable
    ':\\s',                        // a chained statement
    '\\w_\\w',                     // lv_total, gt_flight — ABAP naming
    '\\w-\\w',                     // sy-subrc, wa-matnr
    '\\b\\d',                       // a numeric literal
].join('|'), 'i');

// Words that mean code only once the line has already opened with an ABAP
// keyword; alone they are ordinary English ("Refactor into a class").
const CODE_WORD_RE = new RegExp(
    ',|\\b(TYPE|LIKE|INTO|FROM|WHERE|VALUE|USING|CHANGING|EXPORTING|IMPORTING|'
    + 'EXCEPTIONS|TABLES|OCCURS|SINGLE|APPENDING|TRANSPORTING|BINARY|STANDARD|'
    + 'REF|BEGIN\\s+OF|END\\s+OF|ASSIGNING|COMPONENTS)\\b', 'i');


// English function words that are never ABAP keywords — a closed class, and
// only ever a veto applied after the unambiguous code marks.
const ENGLISH_FUNCTION_RE = /\b(a|an|the|this|that|these|those|it|its|my|your|our|their|his|her|please|what|how|why|which|who|would|should|could|can|will|must|have|has|had|been|being|was|were|are|about|than|but|very|just|also|too|again|here|there|now|me|you|we|they|he|she|more|most|each|every|because|however)\b/i;

// A parameter section header standing alone inside a CALL FUNCTION.
const BARE_PARAM_RE = /^(EXPORTING|IMPORTING|CHANGING|TABLES|EXCEPTIONS|RECEIVING)$/i;

/** Word count. `REPORT z.` and `ENDLOOP.` are whole statements with none of the marks above. */
function _wordCount(l) { return String(l).trim().split(/\s+/).filter(Boolean).length; }

/** True when a line reads as an ABAP statement rather than an English sentence:
 *  opens with a keyword, terminates, and carries a code mark. */
function isStatementLine(line) {
    const l = String(line || '');
    if (!ABAP_STMT_START_RE.test(l)) return false;
    // A statement ends somewhere — a period, or a comma continuing a chain.
    if (!/[.,]\s*(?:"[^"]*)?$/.test(l.replace(/\s+$/, ''))) return false;
    return _isCodeShaped(l);
}

/** Order matters: unambiguous marks first, then the English veto, then the
 *  ambiguous words (CODE_WORD_RE contains TYPE; "Select the right data type" is prose). */
function _isCodeShaped(l) {
    if (CODE_MARK_RE.test(l)) return true;
    if (ENGLISH_FUNCTION_RE.test(l)) return false;
    return _wordCount(l) <= 2 || CODE_WORD_RE.test(l);
}

/** Opens a statement that finishes on a later line (`SELECT carrid connid`, `CALL FUNCTION 'Z_X'`).
 *  Weaker than isStatementLine — no terminator required — so looksLikeAbapCode must not use it. */
function isStatementOpener(line) {
    const l = String(line || '');
    if (!ABAP_STMT_START_RE.test(l)) return false;
    if (_isCodeShaped(l)) return true;
    // Comma-less Open SQL field list. Only after SELECT and only unterminated —
    // a terminated line is isStatementLine's question ("Delete unused variables." is prose).
    if (!/^\s*SELECT\b/i.test(l)) return false;
    if (/[.,]\s*$/.test(l)) return false;
    if (ENGLISH_FUNCTION_RE.test(l)) return false;
    return l.trim().split(/\s+/).every(t => /^[A-Za-z][A-Za-z0-9_]*$/.test(t));
}

/** Continuation of the statement above (second line of a DATA: chain, a WHERE on
 *  its own line): no opening keyword, but a shape only code has. */
function isContinuationLine(line) {
    const l = String(line || '').trim();
    if (!l) return false;
    // A keyword alone matched "Refactor into a class" (INTO); a code mark is required too.
    if (BARE_PARAM_RE.test(l)) return true;
    // CODE_MARK, not CODE_SHAPE: the keyword half is English as well.
    if (!CODE_MARK_RE.test(l)) return false;
    return /,$/.test(l)
        || /^[\w-]+\s*=/.test(l)
        || /\b(TYPE|LIKE|VALUE|EXPORTING|IMPORTING|CHANGING|TABLES|EXCEPTIONS|USING|INTO|FROM|WHERE|FOR\s+ALL\s+ENTRIES|AND|OR|UP\s+TO)\b/i.test(l)
        || /@\w/.test(l);
}

/** The code with comment lines removed, so dead `* SELECT ...` does not trip the live-code rules. */
function _liveCodeOf(text) {
    return String(text || '').split('\n').filter(l => !_isCommentLine(l)).join('\n');
}

// Statements open with a keyword; prose does not. Anchored to the line start —
// "unit test class" contains CLASS.
const ABAP_STMT_START_RE = /^\s*(REPORT|PROGRAM|INCLUDE|TABLES|TYPES|DATA|CONSTANTS|STATICS|FIELD-SYMBOLS|PARAMETERS|SELECT-OPTIONS|CLASS|ENDCLASS|METHOD|ENDMETHOD|INTERFACE|FORM|ENDFORM|FUNCTION|ENDFUNCTION|MODULE|ENDMODULE|START-OF-SELECTION|END-OF-SELECTION|INITIALIZATION|SELECT|ENDSELECT|INSERT|UPDATE|DELETE|MODIFY|APPEND|COLLECT|READ|LOOP|ENDLOOP|DO|ENDDO|WHILE|ENDWHILE|IF|ELSEIF|ELSE|ENDIF|CASE|WHEN|ENDCASE|TRY|CATCH|CLEANUP|ENDTRY|RAISE|MESSAGE|WRITE|MOVE|CLEAR|REFRESH|FREE|CONCATENATE|SPLIT|CONDENSE|TRANSLATE|CALL|PERFORM|SUBMIT|EXPORT|IMPORT|COMMIT|ROLLBACK|CHECK|EXIT|RETURN|SORT|ASSIGN|CREATE|SET|GET|AT|WHERE|AND|OR|INTO|FROM|VALUES|BEGIN|END)\b/i;

/** True when a SELECT sits inside a LOOP/DO/WHILE block (comments ignored). */
function hasSelectInsideLoop(text) {
    let depth = 0;
    for (const raw of String(text || '').split('\n')) {
        if (_isCommentLine(raw)) continue;
        const l = raw.toUpperCase();
        if (depth > 0 && /\bSELECT\b/.test(l)) return true;
        // Anchored and required to be a statement: "please do this fix" and
        // "Do you see the problem?" must not open a loop that never closes.
        if ((/^\s*LOOP\s+AT\b/.test(l) || /^\s*DO\b/.test(l) || /^\s*WHILE\b/.test(l))
            && isStatementLine(raw)) depth++;
        if (/^\s*(ENDLOOP|ENDDO|ENDWHILE)\b/.test(l)) depth = Math.max(0, depth - 1);
    }
    return false;
}

/** True when the paste carries commented-out ABAP: two or more comment lines
 *  that are whole, terminated statements. */
function hasCommentedOutCode(text) {
    let n = 0;
    for (const raw of String(text || '').split('\n')) {
        if (!_isCommentLine(raw)) continue;
        // `*&` is the box-header convention ("*& Report ZTEST"); nobody disables code with it.
        if (/^\s*\*&/.test(raw)) continue;
        const body = raw.replace(/^\s*[*"]\s?/, '');
        if (!body.trim()) continue;
        // Disabled code is a whole, terminated statement; isStatementLine decides
        // that (and allows a trailing " note).
        if (isStatementLine(body) && ++n >= 2) return true;
    }
    return false;
}

// The obsolete declaration only: keyword, table names, period. A CALL FUNCTION
// TABLES section is followed by `it = lt` and cannot match.
const TABLES_DECL_RE = /^\s*TABLES\s*:?\s*[a-z_][a-z0-9_]*(\s*,\s*[a-z_][a-z0-9_]*)*\s*\.\s*$/im;

const ROUTER_CODE_RULES = [
    { id: 'select_loop_check',     test: hasSelectInsideLoop },
    { id: 'delete_commented_code', test: hasCommentedOutCode },
    // [^.\n] not [^.]: must not cross lines into a SQL `WHERE x LIKE y` below.
    { id: 'like_check',            test: t => /\bLIKE\s+'%/i.test(_liveCodeOf(t))
                                           || /^\s*(DATA|PARAMETERS|SELECT-OPTIONS)\b[^.\n]*\bLIKE\b/im.test(_liveCodeOf(t)) },
    // TABLES_DECL_RE, not TABLES[\s:] — TABLES inside a CALL FUNCTION is current syntax.
    { id: 'obsolete_check',        test: t => TABLES_DECL_RE.test(_liveCodeOf(t))
                                           || /\bOCCURS\s+\d/i.test(_liveCodeOf(t))
                                           || /\bENDSELECT\b/i.test(_liveCodeOf(t)) },
    { id: 'select_best_practice',  test: t => /\bSELECT\s+\*/i.test(_liveCodeOf(t))
                                           || /\bFOR\s+ALL\s+ENTRIES\b/i.test(_liveCodeOf(t)) },
];

/** A skill id when exactly one rule fires; several hits is a judgement call
 *  and goes back to the LLM / catch-all. */
function codeShapeSkillId(text) {
    const hits = ROUTER_CODE_RULES
        .filter(r => { try { return r.test(text); } catch (_) { return false; } })
        .map(r => r.id);
    return hits.length === 1 ? hits[0] : null;
}

/** True when a CALL FUNCTION block still carries commented-out parameters
 *  ("* TABLES", "* it_data ="). Scans from CALL FUNCTION to the closing period. */
function hasCommentedParamsInCall(text) {
    let inCall = false;
    for (const raw of String(text || '').split('\n')) {
        if (/\bCALL\s+FUNCTION\b/i.test(raw)) {
            // `CALL FUNCTION 'Z_FOO'.` completes on this line; inCall must not stay set.
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

// Supporting-knowledge rules, kept out of ROUTER_CODE_RULES: that list fires only
// on exactly one match, so an overlapping rule there would turn a hit into no hit.
const ORCHESTRATION_EXTRA_RULES = [
    { id: 'FAE_CHECK_01',               test: t => /\bFOR\s+ALL\s+ENTRIES\b/i.test(_liveCodeOf(t)) },
    { id: 'COMMENT_IN_FUNCTION_SYNTAX', test: hasCommentedParamsInCall },
];

/** Every skill whose rule the pasted code trips, not just one. */
function matchingSkillIds(text) {
    const ids = [...ORCHESTRATION_EXTRA_RULES, ...ROUTER_CODE_RULES]
        .filter(r => { try { return r.test(text); } catch (_) { return false; } })
        .map(r => r.id);
    return [...new Set(ids)];
}

/** The first line that is a person talking, not code; seeds the document search. */
function firstProseLine(text) {
    return String(text || '').split('\n').map(l => l.trim())
        .find(l => l && !_isCommentLine(l) && !isStatementOpener(l) && !isContinuationLine(l)) || '';
}

/** The user's own words with ABAP lines stripped; tells a bare paste from an instruction. */
function proseOf(text) {
    return String(text || '').split('\n')
        .filter(l => l.trim() && !_isCommentLine(l)
                     && !isStatementOpener(l) && !isContinuationLine(l))
        .join(' ').trim();
}


// abaplint is the real parser; the project's target release picks the language version
// (abaplint has no v731, v702 is the nearest older grammar). Only objects local to the
// program must resolve — there is no DDIC here, so tables and global classes are assumed to exist.
const ABAPLINT_VERSION = { v731: 'v702', v740sp08: 'v740sp08', v750: 'v750', cloud: 'Cloud' };
function _abaplintIssues(code, release, lines) {
    const version = Object.prototype.hasOwnProperty.call(ABAPLINT_VERSION, release)
        ? ABAPLINT_VERSION[release] : ABAPLINT_VERSION.v750;
    try {
        const { Registry, MemoryFile, Config } = require('@abaplint/core');
        const cfg = {
            global: { files: '/src/**/*.*' },
            syntax: { version, errorNamespace: '^(LCL_|LIF_|LTY_|TY_)' },
            rules:  { parser_error: true, check_syntax: true, unknown_types: true, check_ddic: true },
        };
        const reg = new Registry(new Config(JSON.stringify(cfg)));
        reg.addFile(new MemoryFile('zcheck.prog.abap', code));
        reg.parse();
        return reg.findIssues().map(i => {
            const row = i.getStart().getRow();
            return { line: row, severity: 'error',
                     message: `abaplint ${i.getKey()} [${version}]: ${i.getMessage()}`,
                     code: (lines[row - 1] || '').trim() };
        });
    } catch (e) {
        return [{ line: 0, severity: 'info', message: 'abaplint unavailable: ' + e.message, code: '' }];
    }
}

function checkAbapSyntax(code, release) {
    const issues = [];
    const lines  = String(code || '').split('\n');

    // Per-line rules, each answerable from a single line.
    const LINE_RULES = [
        { pattern: TABLES_DECL_RE,           severity: 'error',   msg: 'Obsolete: TABLES statement — ใช้ DATA declaration แทน' },
        // One greedy run — overlapping quantifiers were O(n²) on long lines.
        // (?!-) keeps MOVE-CORRESPONDING (valid) out.
        { pattern: /\bMOVE\b(?!-)[^\n]*\bTO\b/i,  severity: 'warning', msg: 'Obsolete: MOVE...TO — ใช้ = assignment แทน' },
        { pattern: /\bSELECT\s+\*/i,         severity: 'warning', msg: 'SELECT * ควร select เฉพาะ fields ที่ใช้จริงเพื่อ performance' },
        { pattern: /\bWRITE\s*:/i,            severity: 'info',    msg: 'WRITE: ใช้ได้สำหรับ classic report แต่ไม่รองรับ Fiori/ALV' },
        // The model receives these messages as established findings, so the fix text must be accurate.
        { pattern: /\bAND\s+RETURN\b/i,       severity: 'warning', msg: 'AND RETURN เป็น obsolete — ใช้ CALL TRANSACTION โดยไม่มี AND RETURN หรือ SUBMIT ... AND RETURN แทน' },
    ];

    // Rules that span lines. Walked, not regex-matched: a regex opens at the
    // leftmost SELECT, so a correct `SELECT SINGLE` above the real loop got the finding.
function _findSelectEndselect(live) {
    const out = [];
    let openAt = -1;
    live.forEach((l, i) => {
        if (/^\s*ENDSELECT\b/i.test(l)) {
            if (openAt >= 0) out.push(openAt);
            openAt = -1;
            return;
        }
        // The loop head is the last SELECT before the ENDSELECT; only the
        // ENDSELECT's arrival distinguishes it from a single-row read.
        if (/^\s*SELECT\b/i.test(l)) openAt = i;
    });
    return out;
}

function _findClearRefresh(live) {
    const out = [];
    live.forEach((l, i) => {
        const m = /^\s*CLEAR\s+(\w+)\s*\.\s*$/i.exec(l);
        if (!m) return;
        // ABAP names are at most 30 chars; a longer capture would make `new RegExp` throw on size.
        if (m[1].length > 30) return;
        const next = live[i + 1] || '';
        if (new RegExp('^\\s*REFRESH\\s+' + m[1] + '\\s*\\.\\s*$', 'i').test(next)) out.push(i);
    });
    return out;
}

    const BLOCK_RULES = [
        { find: _findSelectEndselect, severity: 'error', msg: 'SELECT...ENDSELECT loop — ใช้ SELECT...INTO TABLE แทน' },
        { find: _findClearRefresh,    severity: 'info',  msg: 'ใช้ FREE แทน CLEAR+REFRESH เพื่อคืน memory' },
    ];

    // Blank out comment lines: dead `* MOVE a TO b.` must not reach the model as a finding.
    const live = lines.map(l => (_isCommentLine(l) ? '' : l));

    live.forEach((line, i) => {
        if (!line.trim()) return;
        LINE_RULES.forEach(rule => {
            if (rule.pattern.test(line)) {
                issues.push({ line: i + 1, severity: rule.severity, message: rule.msg, code: line.trim() });
            }
        });
    });

    // Each occurrence pinned to the line its block opens on; the model is told the numbers are exact.
    BLOCK_RULES.forEach(rule => {
        rule.find(live).forEach(at => {
            issues.push({
                line: at + 1, severity: rule.severity, message: rule.msg,
                code: (live[at] || '').trim(),
            });
        });
    });

    issues.push(..._abaplintIssues(String(code || ''), release, lines));
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
    // ABAP_STMT_START_RE is deliberately not exported.
    looksLikeAbapCode, proseOf, firstProseLine, isStatementLine,
    isCommentLine: _isCommentLine,
    hasSelectInsideLoop, hasCommentedOutCode, hasCommentedParamsInCall,
    ROUTER_CODE_RULES, ORCHESTRATION_EXTRA_RULES,
    codeShapeSkillId, matchingSkillIds,
    checkAbapSyntax,
};
