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
    return t.split('\n').length >= 3 && ABAP_CODE_RE.test(t);
}

function _isCommentLine(line) { return /^\s*[*"]/.test(line); }

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
        if (/\bLOOP\s+AT\b/.test(l) || /\bDO\b/.test(l) || /\bWHILE\b/.test(l)) depth++;
        if (/\b(ENDLOOP|ENDDO|ENDWHILE)\b/.test(l)) depth = Math.max(0, depth - 1);
    }
    return false;
}

/** True when the paste carries commented-OUT ABAP — 3+ comment lines that
 *  still contain real statements, i.e. dead code rather than explanation. */
function hasCommentedOutCode(text) {
    let n = 0;
    for (const raw of String(text || '').split('\n')) {
        if (_isCommentLine(raw) && ABAP_CODE_RE.test(raw) && ++n >= 3) return true;
    }
    return false;
}

const ROUTER_CODE_RULES = [
    { id: 'select_loop_check',     test: hasSelectInsideLoop },
    { id: 'delete_commented_code', test: hasCommentedOutCode },
    { id: 'like_check',            test: t => /\bLIKE\s+'%/i.test(_liveCodeOf(t))
                                           || /^\s*(DATA|PARAMETERS|SELECT-OPTIONS)\b[^.]*\bLIKE\b/im.test(_liveCodeOf(t)) },
    { id: 'obsolete_check',        test: t => /^\s*TABLES\s*:/im.test(_liveCodeOf(t))
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
        if (/\bCALL\s+FUNCTION\b/i.test(raw)) { inCall = true; continue; }
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
function proseOf(text) {
    return String(text || '').split('\n')
        .filter(l => l.trim() && !_isCommentLine(l) && !ABAP_STMT_START_RE.test(l))
        .join(' ').trim();
}


function checkAbapSyntax(code) {
    const issues = [];
    const lines  = code.split('\n');

    const RULES = [
        { pattern: /^\s*TABLES[\s:]/i,       severity: 'error',   msg: 'Obsolete: TABLES statement — ใช้ DATA declaration แทน' },
        { pattern: /\bMOVE\s+.+\s+TO\s+/i,  severity: 'warning', msg: 'Obsolete: MOVE...TO — ใช้ = assignment แทน' },
        { pattern: /\bSELECT\s+\*/i,         severity: 'warning', msg: 'SELECT * ควร select เฉพาะ fields ที่ใช้จริงเพื่อ performance' },
        { pattern: /\bWRITE\s*:/i,            severity: 'info',    msg: 'WRITE: ใช้ได้สำหรับ classic report แต่ไม่รองรับ Fiori/ALV' },
        { pattern: /\bSELECT\b[\s\S]+?ENDSELECT/im, severity: 'error', msg: 'SELECT...ENDSELECT loop — ใช้ SELECT...INTO TABLE แทน' },
        { pattern: /\bCLEAR\s+\w+\.\s*REFRESH\s+\w+/i, severity: 'info', msg: 'ใช้ FREE แทน CLEAR+REFRESH เพื่อคืน memory' },
        { pattern: /\bAND\s+RETURN\b/i,       severity: 'warning', msg: 'AND RETURN เป็น obsolete — ใช้ CALL METHOD แทน' },
    ];

    lines.forEach((line, i) => {
        RULES.forEach(rule => {
            if (rule.pattern.test(line)) {
                issues.push({ line: i + 1, severity: rule.severity, message: rule.msg, code: line.trim() });
            }
        });
    });

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
    looksLikeAbapCode, proseOf,
    isCommentLine: _isCommentLine,
    hasSelectInsideLoop, hasCommentedOutCode, hasCommentedParamsInCall,
    ROUTER_CODE_RULES, ORCHESTRATION_EXTRA_RULES,
    codeShapeSkillId, matchingSkillIds,
    checkAbapSyntax,
};
