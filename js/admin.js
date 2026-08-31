/**
 * admin.js — ประกอบหน้า admin จากโมดูลตามแท็บใน js/admin/
 * แต่ละ slice เป็น object ของ method; spread รวมเป็นก้อนเดียว this จึงทำงานเหมือนเดิม
 */
import { flash, hideModal } from './admin/helpers.js';
import core from './admin/core.js';
import overview from './admin/overview.js';
import sync from './admin/sync.js';
import skillsLab from './admin/skills-lab.js';
import credits from './admin/credits.js';
import users from './admin/users.js';
import projects from './admin/projects.js';
import activity from './admin/activity.js';
import usage from './admin/usage.js';

var admin = Object.assign({}, core, overview, sync, skillsLab, credits, users, projects, activity, usage);
export { admin };

document.addEventListener('DOMContentLoaded', function () {
  if (!Auth.check(['admin', 'trainer'])) return;
  var session = Auth.getSession();
  var el = document.getElementById('admin-display-name');
  if (el) el.textContent = session.displayName || session.username;
  // Phase 30: role badge + tab visibility. Admin manages people/money only —
  // the training tabs (Skill Prompts / Prompt Lab / Evals) are trainer-only.
  // Hiding is UX; the real gate is requireTrainer (403) on the backend.
  var badge = document.getElementById('admin-role-badge');
  if (badge && session.role === 'trainer') {
    badge.textContent = 'TRAINER';
    badge.style.background = 'rgba(55,179,74,0.12)';
    badge.style.color = '#3fa64d';
    badge.style.borderColor = 'rgba(55,179,74,0.35)';
  }
  if (session.role !== 'trainer') {
    ['nav-skills', 'nav-lab', 'nav-evals'].forEach(function (id) {
      var n = document.getElementById(id);
      if (n) n.style.display = 'none';
    });
  }
  admin.init();
});

// onclick ใน admin.html และ HTML ที่ JS สร้าง เรียกผ่าน window
window.admin = admin;
window.hideModal = hideModal;
window.flash = flash;
