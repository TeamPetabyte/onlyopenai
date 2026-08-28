// helpers.js — ยูทิลที่ทุกแท็บของ admin ใช้ร่วมกัน

// formatTHB kept for back-compat; new code should call
// formatMoney() for consistent thousand-separators.
export function formatTHB(n) { return '฿' + parseFloat(n || 0).toFixed(2); }
// "฿2,050.00" มี comma — ใช้ตัวนี้เว้นแต่ต้องการแบบแน่น
export function formatMoney(n) {
  return '฿' + parseFloat(n || 0)
    .toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
// "DD/MM/YYYY HH:MM" 24 ชม. locale-stable; formatDate เดิมคงไว้ให้ผู้เรียกเก่า
export function formatDateStd(iso) {
  if (!iso) return '—';
  var d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  var pad = function (n) { return String(n).padStart(2, '0'); };
  return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear()
       + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
// HTML-escape สำหรับค่าที่ user พิมพ์ — โค้ดใหม่ต้องผ่านตัวนี้เสมอ
export function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
export function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('th-TH', {
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit'
  });
}
// เดา tone จาก emoji นำหน้า — คนลืมส่ง type 'error' บ่อยจน toast แดงกลายเป็นเขียว
export function flash(msg, type) {
  var s = String(msg || '');
  if (!type) {
    if (/^\s*(❌|⚠️|🚫|🔒)/.test(s))      type = 'error';
    else if (/^\s*(✅|✓|🎉)/.test(s))     type = 'success';
  }
  type = type || '';
  var el = document.getElementById('flash');
  el.textContent = s;
  el.className = 'flash show' + (type ? ' flash-' + type : '');
  setTimeout(function () { el.classList.remove('show'); }, 2800);
}
export function showModal(id) { document.getElementById(id).classList.add('show'); }
export function hideModal(id) { document.getElementById(id).classList.remove('show'); }

