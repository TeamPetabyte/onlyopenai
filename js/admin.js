// admin.js — ประกอบหน้า admin จากโมดูลตามแท็บใน js/admin/
// แต่ละ slice เป็น object ของ method; spread รวมเป็นก้อนเดียว this จึงทำงานเหมือนเดิม
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
  var who = session.displayName || session.username || 'Admin';
  if (el) el.textContent = who;
  var av = document.getElementById('admin-avatar');
  if (av) av.textContent = who.charAt(0).toUpperCase();
  // Training tabs are trainer-only. Hiding is UX; the real gate is requireTrainer on the backend.
  var badge = document.getElementById('admin-role-badge');
  if (badge && session.role === 'trainer') {
    badge.textContent = 'TRAINER';
    badge.style.background = 'rgba(55,179,74,0.12)';
    badge.style.color = '#3fa64d';
    badge.style.borderColor = 'rgba(55,179,74,0.35)';
  }
  if (session.role !== 'trainer') {
    ['nav-group-trainer', 'nav-skills', 'nav-lab', 'nav-evals'].forEach(function (id) {
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
