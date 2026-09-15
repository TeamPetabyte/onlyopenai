-- Phase 59: which ABAP release a project's generated code must run on.
-- Values are abaplint's version names so the same string can drive a syntax
-- checker later: v731 (ECC, no inline declarations), v740sp08 (ECC EHP7+),
-- v750 (S/4HANA on-prem, default), cloud (ABAP Cloud / BTP, released APIs only).

ALTER TABLE tbl_project
    ADD COLUMN IF NOT EXISTS target_release VARCHAR(16) NOT NULL DEFAULT 'v750';

ALTER TABLE tbl_project DROP CONSTRAINT IF EXISTS ck_project_target_release;
ALTER TABLE tbl_project ADD CONSTRAINT ck_project_target_release
    CHECK (target_release IN ('v731', 'v740sp08', 'v750', 'cloud'));
