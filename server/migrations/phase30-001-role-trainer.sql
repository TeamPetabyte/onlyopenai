-- Phase 30: role "trainer" (superadmin) — separates AI-training rights from
-- people/money admin so an admin can't accidentally corrupt the golden
-- dataset (verdicts, corrected answers, eval runs).
--
--   trainer (role_id 3) : everything — admin pages AND training pages
--   admin   (role_id 1) : user/credit management only; training endpoints 403
--   user    (role_id 2) : chat, unchanged
--
-- NOTE: sessions snapshot the role at login (tbl_session.role) — everyone
-- must log in again after this deploys to pick up their new role.

INSERT INTO tbl_user_role (role_id, role_des) VALUES (3, 'trainer')
ON CONFLICT (role_id) DO NOTHING;

-- Bootstrap: promote the original seeded admin account to trainer so a
-- superadmin exists immediately (only trainers can grant the trainer role,
-- so without this nobody could create the first one).
UPDATE tbl_user SET role_id = 3 WHERE username = 'admin' AND role_id = 1;
