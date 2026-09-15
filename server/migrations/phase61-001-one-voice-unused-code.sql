-- Phase 61: one voice on unused and commented-out code (wayfinder ticket 03, senior's decision 2026-09-15).
-- Unused local variable the file proves unreferenced: delete. Unused FORM/METHOD: never delete
-- or comment out, ask under "Needs your decision". Commented-out block of 2+ disabled statements
-- with no explanatory note: delete; with a note: ask. The catch-all used to say "comment out",
-- delete_commented_code used to delete subroutines/methods outright — answers differed by skill.
-- Targeted replace() so a trainer's other edits survive; a no-op where the sentence is already gone.

INSERT INTO tbl_prompt_history (prompt_id, action, label, description, content, changed_by)
SELECT id, 'update', label, description, content, 'phase61-001'
  FROM tbl_prompt
 WHERE id IN ('abap_best_practice', 'delete_commented_code')
   AND (content LIKE '%Comment out old and unused variables%' OR content LIKE '%Delete out unused subroutines%');

UPDATE tbl_prompt SET content = replace(content, $q$Comment out old and unused variables, methods, and subroutines. Ensure that no other part of the code is impacted when commenting out unused code.$q$, $q$Delete unused local variables that this file proves nothing references. Never delete or comment out an unused FORM or METHOD — another program may call it; list it under "⚠️ Needs your decision" instead.$q$), updated_at = NOW(), updated_by = 'phase61-001'
 WHERE id = 'abap_best_practice' AND content LIKE '%' || $q$Comment out old and unused variables, methods, and subroutines. Ensure that no other part of the code is impacted when commenting out unused code.$q$ || '%';

UPDATE tbl_prompt SET content = replace(content, $q$Permanently delete old, commented-out code blocks that are no longer referenced. Ensure the remaining code is unaffected.$q$, $q$Delete a commented-out code block when it is two or more disabled statements in a row with no note explaining why it is kept. A block that carries such a note goes under "⚠️ Needs your decision" instead of being deleted.$q$), updated_at = NOW(), updated_by = 'phase61-001'
 WHERE id = 'abap_best_practice' AND content LIKE '%' || $q$Permanently delete old, commented-out code blocks that are no longer referenced. Ensure the remaining code is unaffected.$q$ || '%';

UPDATE tbl_prompt SET content = replace(content, $q$Delete out old and unused code especially when they are no longer being referenced or used in other parts of the code. Best to make sure that no other part of the code is impacted when deleting out unused code.$q$, $q$Delete a commented-out code block when it is two or more disabled statements in a row with no note explaining why it is kept. A block that carries such a note goes under "⚠️ Needs your decision" instead of being deleted.$q$), updated_at = NOW(), updated_by = 'phase61-001'
 WHERE id = 'delete_commented_code' AND content LIKE '%' || $q$Delete out old and unused code especially when they are no longer being referenced or used in other parts of the code. Best to make sure that no other part of the code is impacted when deleting out unused code.$q$ || '%';

UPDATE tbl_prompt SET content = replace(content, $q$Delete out unused subroutines$q$, $q$Unused subroutines: ask, never delete$q$), updated_at = NOW(), updated_by = 'phase61-001'
 WHERE id = 'delete_commented_code' AND content LIKE '%' || $q$Delete out unused subroutines$q$ || '%';

UPDATE tbl_prompt SET content = replace(content, $q$Delete out old and unused subroutines especially when they are no longer being referenced or used in other parts of the code. Best to make sure that no other part of the code is impacted when Deleting out unused code.$q$, $q$Do not delete or comment out an unused FORM — this file alone cannot prove that no other program calls it. List it under "⚠️ Needs your decision".$q$), updated_at = NOW(), updated_by = 'phase61-001'
 WHERE id = 'delete_commented_code' AND content LIKE '%' || $q$Delete out old and unused subroutines especially when they are no longer being referenced or used in other parts of the code. Best to make sure that no other part of the code is impacted when Deleting out unused code.$q$ || '%';

UPDATE tbl_prompt SET content = replace(content, $q$Delete out unused methods$q$, $q$Unused methods: ask, never delete$q$), updated_at = NOW(), updated_by = 'phase61-001'
 WHERE id = 'delete_commented_code' AND content LIKE '%' || $q$Delete out unused methods$q$ || '%';

UPDATE tbl_prompt SET content = replace(content, $q$Delete out old and unused methods especially when they are no longer being referenced or used in other parts of the code. Best to make sure that no other part of the code is impacted when Deleting out unused code.$q$, $q$Do not delete or comment out an unused METHOD — this file alone cannot prove that no other program calls it. List it under "⚠️ Needs your decision".$q$), updated_at = NOW(), updated_by = 'phase61-001'
 WHERE id = 'delete_commented_code' AND content LIKE '%' || $q$Delete out old and unused methods especially when they are no longer being referenced or used in other parts of the code. Best to make sure that no other part of the code is impacted when Deleting out unused code.$q$ || '%';
