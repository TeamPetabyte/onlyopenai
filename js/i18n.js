/**
 * i18n.js — PetabyteAi bilingual (TH / EN) toggle.  Phase 3.
 *
 * How it works
 * ------------
 *  - Static HTML marks translatable nodes with attributes:
 *        data-i18n="key"        → sets element.textContent
 *        data-i18n-html="key"   → sets element.innerHTML (use sparingly)
 *        data-i18n-ph="key"     → sets the `placeholder` attribute
 *        data-i18n-title="key"  → sets the `title` attribute
 *  - JS code can translate on the fly with  I18N.t('key')  (falls back to the
 *    key text or a provided default if missing).
 *  - The chosen language is persisted in localStorage ('agenthub_lang') and
 *    re-applied before paint via I18N.apply().
 *  - Switching fires a window 'i18n:change' event so render code can refresh
 *    any strings it produced imperatively.
 *
 * Default language = 'th' (the UI was authored in Thai).
 */
(function (global) {
  var STORAGE_KEY = 'agenthub_lang';

  // ── Dictionary ────────────────────────────────────────────
  // Keys are dot-namespaced by area. th = original wording, en = translation.
  var DICT = {
    th: {
      // sidebar / chrome
      'nav.dashboard': 'Dashboard',
      'nav.userManagement': 'User Management',
      'nav.project': 'Project',
      'nav.user': 'User',
      'nav.activityLog': 'Activity Log',
      'nav.capUsage': 'Cap & Usage',
      'nav.loginHistory': 'Login History',
      'nav.balance': 'Balance',
      'nav.skillPrompts': 'Skill Prompts',
      'nav.syncStatus': 'Sync Status',
      'btn.logout': 'ออกจากระบบ',
      'theme.light': 'Light Mode',
      'theme.dark': 'Dark Mode',
      'lang.toggle': 'EN',
      'lang.label': 'ภาษา',

      // page headers
      'page.overview.title': 'Overview',
      'page.overview.sub': 'ภาพรวมระบบทั้งหมด',
      'page.users.title': 'User Management',
      'page.users.sub': 'เพิ่ม ลบ แก้ไข credit และ project ของ user',
      'page.projects.title': 'Projects',
      'page.projects.sub': 'จัดการ Project และ rate ของแต่ละ project',
      'page.activity.title': 'Activity Log',
      'page.activity.sub': 'ประวัติการใช้งานของผู้ใช้ · chat / admin actions',
      'page.loginHistory.title': 'Login History',
      'page.loginHistory.sub': 'ประวัติการเข้า/ออกระบบของผู้ใช้ทั้งหมด',
      'tx.subDay': 'ประวัติการเติม credit และการใช้งาน',
      'tx.subMonth': 'สรุปรายเดือนต่อ user',
      'page.cap.title': 'Cap & Usage',
      'page.cap.sub': 'ตั้งโควต้าการใช้ต่อวันของแต่ละ user · ติดตามการใช้งานแบบ real-time',
      'page.balance.title': 'Balance & Top-up',
      'page.balance.sub': 'ดูยอด credit ของแต่ละ project และเติมเงิน',

      // tabs
      'tab.capManagement': '🎯 Cap Management',
      'tab.usageAnalytics': '📊 Usage Analytics',
      'tab.chatHistory': '💬 Chat History',
      'tab.adminActions': '⚙️ Admin Actions',

      // common buttons / actions
      'btn.refresh': '🔄 รีเฟรช',
      'btn.save': '💾 บันทึก',
      'btn.edit': 'แก้ไข',
      'skills.add': 'เพิ่ม Skill',
      'btn.cancel': 'Cancel',
      'btn.addUser': '+ Add User',
      'btn.topupProject': '+ เติมเงิน Project',
      'btn.export': '⬇ Export',

      // dashboard cards / labels
      'dash.users': 'Users',
      'dash.totalTokens': 'Total Tokens',
      'dash.totalSpend': 'Total Spend',
      'dash.lifetimeTopup': 'Lifetime Top-up',
      'dash.projectBalance': 'Project Balance',
      'dash.members': 'Members',
      'proj.poolLeft': 'Pool คงเหลือ',
      'proj.usableLeft': 'คงเหลือใช้ได้',
      'proj.usedOfPool': 'ใช้ไป',
      'proj.noCredit': 'ยังไม่มีเครดิต',
      'proj.topupHint': 'กด "+ เติมเงิน Project" เพื่อเริ่มใช้งาน',
      'proj.depleted': 'เครดิตหมด',
      'proj.depletedHint': 'เติมเงินเพื่อให้ user ใช้งานต่อได้',
      'proj.lifetimeTopup': 'Lifetime Top-up',
      'proj.spendCumulative': 'ใช้จ่ายสะสม',
      'proj.topupSub': 'ยอดเติมสะสม',
      'proj.ofTopup': 'ของยอดเติม',
      'proj.memberOne': 'member',
      'proj.memberMany': 'members',
      'unit.perDay': '/วัน',
      'lbl.used': 'ใช้แล้ว',
      'dash.tokensSub': 'สะสมทุก user',
      'dash.spendSub': 'ใช้จ่ายสะสมทุก user',
      'dash.topupSub': 'ยอดสะสมที่ลูกค้าเคยเติม',
      'dash.balanceSub': 'ยอดคงเหลือกองกลางตอนนี้',
      'col.tokens': 'Tokens',
      'col.spendCumulative': 'ใช้จ่ายสะสม',
      'col.dailyCap': 'Daily Cap',
      'col.usedToday': 'ใช้วันนี้',
      'col.username': 'Username',
      'col.project': 'Project',
      'col.projectPool': 'Project Pool',
      'col.usedTodayCap': 'ใช้วันนี้ / Cap',
      'val.unlimited': 'ไม่จำกัด',

      // quota requests
      'qr.title': 'Quota Requests',
      'qr.sub': 'คำขอเพิ่มโควต้ารายวันจาก user',
      'qr.approveTitle': '✓ อนุมัติคำขอเพิ่มโควต้า',
      'qr.denyTitle': '✗ ปฏิเสธคำขอเพิ่มโควต้า',
      'qr.btnApprove': '✓ อนุมัติ',
      'qr.btnDeny': '✗ ปฏิเสธ',
      'qr.noteOptional': 'หมายเหตุ (ไม่บังคับ)',
      'qr.reqAmount': 'ขอเพิ่ม',
      'qr.reason': 'เหตุผล',

      // common
      'btn.clearChatLog': 'ล้าง Chat Log',
      'btn.cancelTh': 'ยกเลิก',
      'btn.create': 'สร้าง',
      'common.loading': '⏳ กำลังโหลด...',
      'common.understood': 'เข้าใจแล้ว',
      'common.optional': '(ไม่บังคับ)',

      // login history table
      'col.login': 'เข้าสู่ระบบ',
      'col.logout': 'ออกจากระบบ',
      'col.duration': 'ระยะเวลา',
      // action log
      'filter.allAction': '🔎 ทุก Action',
      'filter.allTarget': 'ทุก Target',
      'col.detail': 'รายละเอียด (before → after)',
      'col.datetime': 'วันที่/เวลา',
      // usage analytics
      'filter.allProject': '— ทุก Project —',
      'usage.perUser': 'การใช้งานรายผู้ใช้',
      // page subtitles (skills/sync)
      'page.skills.sub': 'รายการ prompt ที่ AI router เลือกใช้อัตโนมัติตามคำถามของผู้ใช้',
      'page.sync.sub': 'สถานะการ sync ข้อมูล usage จาก OpenAI (ทุก 15 นาที)',
      'sync.perProject': 'การ Sync รายโปรเจค (7 วันล่าสุด)',
      'tx.sub': 'ประวัติการเติม credit และการใช้งาน',

      // modal: add project
      'm.addProject.title': '📂 สร้าง Project ใหม่',
      'm.field.projectName': 'ชื่อ Project',
      'm.field.description': 'คำอธิบาย',
      'm.ph.projectName': 'เช่น SAP S/4HANA Migration',
      'm.ph.projectDesc': 'รายละเอียด project...',
      'm.btn.createProject': 'สร้าง Project',
      // modal: edit project
      'm.editProject.title': '✏️ แก้ไข Project',
      'm.field.creditLimitPerUser': 'Credit Limit ต่อ User (฿, 0 = ไม่จำกัด)',
      // modal: add user
      'm.field.name': 'ชื่อ (Name)',
      'm.field.surname': 'นามสกุล (Surname)',
      'm.ph.name': 'กรอกชื่อ',
      'm.ph.surname': 'กรอกนามสกุล',
      'm.field.startCredit': 'Credit เริ่มต้น (฿)',
      'm.btn.resetPw': '🔑 รีเซ็ต PW',
      'm.btn.deleteUser': '🗑 ลบ User',
      // modal: daily cap
      'm.cap.title': '🎯 ตั้งโควต้ารายวัน (Daily Cap)',
      'm.cap.field': 'Daily Cap (฿ ต่อวัน)',
      'm.cap.ph': 'เว้นว่าง = ไม่จำกัด',
      'm.cap.nolimit': 'ไม่จำกัด (ลบ cap — user ใช้ได้เท่าที่ project pool มี)',
      'm.cap.hint': 'จำกัดยอดใช้ต่อวันของ user คนนี้ · เมื่อใช้ครบจะถูกบล็อกจนถึงเที่ยงคืน (หรือ admin อนุมัติคำขอเพิ่ม) · reset อัตโนมัติทุกวัน',
      // modal: insufficient pool
      'm.pool.title': '⚠️ Project pool ไม่พอ',
      'm.pool.have': 'Pool ที่มี',
      'm.pool.need': 'ต้องการเพิ่ม',
      // modal: topup
      'm.field.note': 'หมายเหตุ',
      'm.ph.amount': 'เช่น 500.00',
      'm.ph.topupNote': 'เช่น invoice #1234, เติมเงินรายเดือน',
      // modal: status toggle
      'm.status.title': '⚙️ เปลี่ยนสถานะ',
      'm.status.name': 'ชื่อ:',
      'm.status.current': 'สถานะ:',

      'btn.confirm': 'ยืนยัน',
      'btn.deletePermanent': 'ลบถาวร',
      'lbl.role': 'บทบาท:',
      'lbl.balanceLeft': 'Balance คงเหลือ:',
      'lbl.creditsLeft': 'Credits คงเหลือ:',
      'lbl.membersInProject': 'สมาชิกใน project:',
      'lbl.currentProject': 'Project ปัจจุบัน:',
      'm.apikey.ph': 'sk-svcacct-… หรือ sk-proj-… (เว้นว่าง = ไม่เปลี่ยน)',
      'm.pool.body': 'Project pool ไม่พอจัดสรร credit ได้ตามที่ขอ<br>กรุณาไปหน้า <b>Balance</b> เพื่อ top-up project ก่อน หรือลดจำนวน user credit ที่จะตั้ง',
      // delete user
      'm.delUser.title': '⚠️ ยืนยันการลบ User',
      'm.delUser.pre': 'คุณกำลังจะลบ',
      'm.delUser.warn': 'การลบเป็นแบบ soft-delete — user จะไม่สามารถ login ได้อีก และ session ที่กำลังเปิดอยู่ทั้งหมดจะถูกตัดทันที',
      // delete project
      'm.delProj.title': '⚠️ ยืนยันการลบ Project',
      'm.delProj.pre': 'คุณกำลังจะลบ',
      'm.delProj.warn': 'Project จะถูก soft-delete — สมาชิกทั้งหมดจะถูกย้ายออกจาก project และ balance ของ project จะถูกล้าง',
      // remove from project
      'm.removeUser.title': '🚪 ย้าย User ออกจาก Project',
      'm.removeUser.pre': 'ย้าย',
      'm.removeUser.post': 'ออกจาก project',
      'm.removeUser.note': 'User จะยังคงอยู่ในระบบ (ไม่ได้ถูกลบ) — แค่ไม่ได้สังกัด project ไหน สามารถย้ายกลับเข้าได้ทีหลัง',
      'm.removeUser.confirm': 'ยืนยันย้ายออก',
      'btn.savePlain': 'บันทึก',
      'm.apikey.hint': '💡 สร้าง key ที่ <a href="https://platform.openai.com/api-keys" target="_blank" style="color:var(--accent);text-decoration:underline">platform.openai.com</a> ใน project นั้น แล้ว copy ค่าเต็ม (โผล่ครั้งเดียว!) มาวางที่นี่',
      // reset password modal
      'm.resetPw.title': '🔑 รีเซ็ตรหัสผ่าน',
      'm.resetPw.newPw': 'รหัสผ่านใหม่',
      'm.resetPw.ph': '8+ ตัว, มีตัวอักษรและตัวเลข',
      'm.resetPw.hint': 'ต้องมีอย่างน้อย 8 ตัวอักษร พร้อมตัวเลขและตัวอักษร',
      // clear api key modal
      'm.clearKey.title': '🔐 ลบ API key',
      'm.clearKey.body': 'หลังลบ → chat router ของ project นี้จะ fallback ไปใช้ global API key ของระบบแทน<br>ผู้ใช้ใน project ยังใช้งานต่อได้ตามปกติ',
      'm.clearKey.btn': 'ลบ API key',
      // clear activity log modal
      'm.clearHist.title': '🗑 ล้าง Activity Log ทั้งหมด',
      'm.clearHist.warn': '<b>คำเตือน:</b> การกระทำนี้จะลบ Activity Log ของ <b>ผู้ใช้ทุกคน</b> ออกจาก DB ถาวร<br>การกู้คืนทำได้เฉพาะจาก backup เท่านั้น',
      'm.clearHist.type': 'พิมพ์คำว่า <code style="background:var(--surface-3);padding:1px 6px;border-radius:4px">DELETE</code> เพื่อยืนยัน',
      'm.clearHist.btn': 'ลบทั้งหมด',
      // sync now modal
      'm.syncNow.title': '🔄 เริ่ม Usage Sync',
      'm.syncNow.body': 'เรียก OpenAI Usage API เพื่อ sync ข้อมูลการใช้งานล่าสุดเข้า DB<br>ใช้เวลาประมาณ 5-15 วินาที — กรุณาอย่าปิดหน้านี้ระหว่างทำงาน',
      'm.syncNow.btn': 'เริ่ม sync',
    },
    en: {
      'nav.dashboard': 'Dashboard',
      'nav.userManagement': 'User Management',
      'nav.project': 'Project',
      'nav.user': 'User',
      'nav.activityLog': 'Activity Log',
      'nav.capUsage': 'Cap & Usage',
      'nav.loginHistory': 'Login History',
      'nav.balance': 'Balance',
      'nav.skillPrompts': 'Skill Prompts',
      'nav.syncStatus': 'Sync Status',
      'btn.logout': 'Log out',
      'theme.light': 'Light Mode',
      'theme.dark': 'Dark Mode',
      'lang.toggle': 'TH',
      'lang.label': 'Language',

      'page.overview.title': 'Overview',
      'page.overview.sub': 'System-wide overview',
      'page.users.title': 'User Management',
      'page.users.sub': "Add, remove, edit users' credit and project",
      'page.projects.title': 'Projects',
      'page.projects.sub': 'Manage projects and per-project rates',
      'page.activity.title': 'Activity Log',
      'page.activity.sub': 'User activity history · chat / admin actions',
      'page.loginHistory.title': 'Login History',
      'page.loginHistory.sub': 'Login / logout history of all users',
      'tx.subDay': 'Credit top-up and usage history',
      'tx.subMonth': 'Monthly summary per user',
      'page.cap.title': 'Cap & Usage',
      'page.cap.sub': 'Set each user’s daily quota · track usage in real-time',
      'page.balance.title': 'Balance & Top-up',
      'page.balance.sub': 'View each project’s credit and top up',

      'tab.capManagement': '🎯 Cap Management',
      'tab.usageAnalytics': '📊 Usage Analytics',
      'tab.chatHistory': '💬 Chat History',
      'tab.adminActions': '⚙️ Admin Actions',

      'btn.refresh': '🔄 Refresh',
      'btn.save': '💾 Save',
      'btn.edit': 'Edit',
      'skills.add': 'Add Skill',
      'btn.cancel': 'Cancel',
      'btn.addUser': '+ Add User',
      'btn.topupProject': '+ Top up Project',
      'btn.export': '⬇ Export',

      'dash.users': 'Users',
      'dash.totalTokens': 'Total Tokens',
      'dash.totalSpend': 'Total Spend',
      'dash.lifetimeTopup': 'Lifetime Top-up',
      'dash.projectBalance': 'Project Balance',
      'dash.members': 'Members',
      'proj.poolLeft': 'Pool left',
      'proj.usableLeft': 'Usable left',
      'proj.usedOfPool': 'Used',
      'proj.noCredit': 'No credit yet',
      'proj.topupHint': 'Click "+ Top up Project" to start',
      'proj.depleted': 'Credit depleted',
      'proj.depletedHint': 'Top up so users can keep working',
      'proj.lifetimeTopup': 'Lifetime Top-up',
      'proj.spendCumulative': 'Total spend',
      'proj.topupSub': 'lifetime top-up',
      'proj.ofTopup': 'of top-up',
      'proj.memberOne': 'member',
      'proj.memberMany': 'members',
      'unit.perDay': '/day',
      'lbl.used': 'used',
      'dash.tokensSub': 'across all users',
      'dash.spendSub': 'total spend, all users',
      'dash.topupSub': 'lifetime customer top-ups',
      'dash.balanceSub': 'current pool balance',
      'col.tokens': 'Tokens',
      'col.spendCumulative': 'Total Spend',
      'col.dailyCap': 'Daily Cap',
      'col.usedToday': 'Used today',
      'col.username': 'Username',
      'col.project': 'Project',
      'col.projectPool': 'Project Pool',
      'col.usedTodayCap': 'Used today / Cap',
      'val.unlimited': 'Unlimited',

      'qr.title': 'Quota Requests',
      'qr.sub': 'Daily quota-increase requests from users',
      'qr.approveTitle': '✓ Approve quota request',
      'qr.denyTitle': '✗ Deny quota request',
      'qr.btnApprove': '✓ Approve',
      'qr.btnDeny': '✗ Deny',
      'qr.noteOptional': 'Note (optional)',
      'qr.reqAmount': 'Requested',
      'qr.reason': 'Reason',

      'btn.clearChatLog': 'Clear Chat Log',
      'btn.cancelTh': 'Cancel',
      'btn.create': 'Create',
      'common.loading': '⏳ Loading...',
      'common.understood': 'Got it',
      'common.optional': '(optional)',

      'col.login': 'Login',
      'col.logout': 'Logout',
      'col.duration': 'Duration',
      'filter.allAction': '🔎 All Actions',
      'filter.allTarget': 'All Targets',
      'col.detail': 'Details (before → after)',
      'col.datetime': 'Date / Time',
      'filter.allProject': '— All Projects —',
      'usage.perUser': 'Usage by user',
      'page.skills.sub': 'Prompts the AI router auto-selects based on user questions',
      'page.sync.sub': 'Status of usage sync from OpenAI (every 15 min)',
      'sync.perProject': 'Sync by project (last 7 days)',
      'tx.sub': 'Credit top-up and usage history',

      'm.addProject.title': '📂 New Project',
      'm.field.projectName': 'Project Name',
      'm.field.description': 'Description',
      'm.ph.projectName': 'e.g. SAP S/4HANA Migration',
      'm.ph.projectDesc': 'Project details...',
      'm.btn.createProject': 'Create Project',
      'm.editProject.title': '✏️ Edit Project',
      'm.field.creditLimitPerUser': 'Credit Limit per User (฿, 0 = unlimited)',
      'm.field.name': 'Name',
      'm.field.surname': 'Surname',
      'm.ph.name': 'Enter name',
      'm.ph.surname': 'Enter surname',
      'm.field.startCredit': 'Initial Credit (฿)',
      'm.btn.resetPw': '🔑 Reset PW',
      'm.btn.deleteUser': '🗑 Delete User',
      'm.cap.title': '🎯 Set Daily Cap',
      'm.cap.field': 'Daily Cap (฿ per day)',
      'm.cap.ph': 'empty = unlimited',
      'm.cap.nolimit': 'Unlimited (remove cap — user spends up to project pool)',
      'm.cap.hint': "Limits this user's daily spend · when reached they are blocked until midnight (or admin approves a request) · resets automatically each day",
      'm.pool.title': '⚠️ Insufficient project pool',
      'm.pool.have': 'Pool available',
      'm.pool.need': 'Requested',
      'm.field.note': 'Note',
      'm.ph.amount': 'e.g. 500.00',
      'm.ph.topupNote': 'e.g. invoice #1234, monthly top-up',
      'm.status.title': '⚙️ Change Status',
      'm.status.name': 'Name:',
      'm.status.current': 'Status:',

      'btn.confirm': 'Confirm',
      'btn.deletePermanent': 'Delete permanently',
      'lbl.role': 'Role:',
      'lbl.balanceLeft': 'Balance left:',
      'lbl.creditsLeft': 'Credits left:',
      'lbl.membersInProject': 'Members in project:',
      'lbl.currentProject': 'Current project:',
      'm.apikey.ph': 'sk-svcacct-… or sk-proj-… (empty = unchanged)',
      'm.pool.body': 'The project pool is not enough to allocate the requested credit.<br>Go to <b>Balance</b> to top up the project first, or lower the user credit you are setting.',
      'm.delUser.title': '⚠️ Confirm Delete User',
      'm.delUser.pre': 'You are about to delete',
      'm.delUser.warn': 'This is a soft delete — the user can no longer log in and all active sessions are terminated immediately.',
      'm.delProj.title': '⚠️ Confirm Delete Project',
      'm.delProj.pre': 'You are about to delete',
      'm.delProj.warn': 'The project will be soft-deleted — all members are removed from it and the project balance is cleared.',
      'm.removeUser.title': '🚪 Remove User from Project',
      'm.removeUser.pre': 'Remove',
      'm.removeUser.post': 'from the project',
      'm.removeUser.note': 'The user stays in the system (not deleted) — just unassigned from any project, and can be re-assigned later.',
      'm.removeUser.confirm': 'Confirm removal',
      'btn.savePlain': 'Save',
      'm.apikey.hint': '💡 Create a key at <a href="https://platform.openai.com/api-keys" target="_blank" style="color:var(--accent);text-decoration:underline">platform.openai.com</a> in that project, then copy the full value (shown once!) and paste it here',
      'm.resetPw.title': '🔑 Reset Password',
      'm.resetPw.newPw': 'New password',
      'm.resetPw.ph': '8+ chars, letters and numbers',
      'm.resetPw.hint': 'At least 8 characters with both letters and numbers',
      'm.clearKey.title': '🔐 Delete API key',
      'm.clearKey.body': "After deleting → this project's chat router falls back to the system global API key.<br>Users in the project keep working as usual.",
      'm.clearKey.btn': 'Delete API key',
      'm.clearHist.title': '🗑 Clear all Activity Log',
      'm.clearHist.warn': '<b>Warning:</b> this permanently deletes the Activity Log of <b>all users</b> from the DB.<br>Recovery is only possible from a backup.',
      'm.clearHist.type': 'Type <code style="background:var(--surface-3);padding:1px 6px;border-radius:4px">DELETE</code> to confirm',
      'm.clearHist.btn': 'Delete all',
      'm.syncNow.title': '🔄 Start Usage Sync',
      'm.syncNow.body': 'Calls the OpenAI Usage API to sync the latest usage into the DB.<br>Takes about 5-15 seconds — please don’t close this page meanwhile.',
      'm.syncNow.btn': 'Start sync',
    },
  };

  var I18N = {
    lang: 'th',

    init: function () {
      var saved = null;
      try { saved = localStorage.getItem(STORAGE_KEY); } catch (_) {}
      this.lang = (saved === 'en' || saved === 'th') ? saved : 'th';
      return this.lang;
    },

    t: function (key, fallback) {
      var table = DICT[this.lang] || {};
      if (Object.prototype.hasOwnProperty.call(table, key)) return table[key];
      // fall back to TH, then provided default, then the key itself
      if (DICT.th && Object.prototype.hasOwnProperty.call(DICT.th, key)) return DICT.th[key];
      return (fallback !== undefined) ? fallback : key;
    },

    apply: function (root) {
      var scope = root || document;
      var self = this;
      scope.querySelectorAll('[data-i18n]').forEach(function (el) {
        el.textContent = self.t(el.getAttribute('data-i18n'));
      });
      scope.querySelectorAll('[data-i18n-html]').forEach(function (el) {
        el.innerHTML = self.t(el.getAttribute('data-i18n-html'));
      });
      scope.querySelectorAll('[data-i18n-ph]').forEach(function (el) {
        el.setAttribute('placeholder', self.t(el.getAttribute('data-i18n-ph')));
      });
      scope.querySelectorAll('[data-i18n-title]').forEach(function (el) {
        el.setAttribute('title', self.t(el.getAttribute('data-i18n-title')));
      });
      // reflect on <html lang="">
      try { document.documentElement.setAttribute('lang', this.lang); } catch (_) {}
    },

    setLang: function (lang) {
      if (lang !== 'en' && lang !== 'th') return;
      this.lang = lang;
      try { localStorage.setItem(STORAGE_KEY, lang); } catch (_) {}
      this.apply();
      this._refreshToggleLabel();
      // let imperative renderers re-run with the new language
      try { window.dispatchEvent(new CustomEvent('i18n:change', { detail: { lang: lang } })); } catch (_) {}
    },

    toggle: function () {
      this.setLang(this.lang === 'th' ? 'en' : 'th');
    },

    _refreshToggleLabel: function () {
      var el = document.getElementById('lang-toggle-label');
      if (el) el.textContent = this.t('lang.toggle');
    },
  };

  I18N.init();
  global.I18N = I18N;
  // Convenience global for terse use in render code.
  global.t = function (k, f) { return I18N.t(k, f); };

  // Apply as soon as the DOM is parsed (covers static markup before app JS runs).
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      I18N.apply();
      I18N._refreshToggleLabel();
    });
  } else {
    I18N.apply();
    I18N._refreshToggleLabel();
  }
})(window);
