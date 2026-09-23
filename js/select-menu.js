// select-menu.js — our own popup list for every <select>, instead of the OS one.
// The native <select> stays the trigger and the source of truth: picking sets its value and fires
// `change`, so existing onchange handlers, .value writes and show/hide keep working untouched.
// Touch screens keep the native picker (better on phones).

const CHECK = '<svg class="sm-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" '
    + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';

let cur = null;   // { sel, pop, items, active }

function enhanced(sel) {
    return sel && !sel.disabled && !sel.multiple && sel.size <= 1
        && !window.matchMedia('(pointer: coarse)').matches;
}

function setActive(i) {
    if (!cur || i < 0 || i >= cur.items.length) return;
    if (cur.items[cur.active]) cur.items[cur.active].classList.remove('sm-active');
    cur.active = i;
    cur.items[i].classList.add('sm-active');
    cur.items[i].scrollIntoView({ block: 'nearest' });
}

// next enabled item from `from` in direction `dir`, or -1
function step(from, dir) {
    for (let i = from + dir; i >= 0 && i < cur.items.length; i += dir) {
        if (cur.items[i].getAttribute('aria-disabled') !== 'true') return i;
    }
    return -1;
}

function close() {
    if (!cur) return;
    cur.pop.remove();
    cur.sel.removeAttribute('aria-expanded');
    cur = null;
}

function pick(i) {
    const { sel } = cur;
    const opt = sel.options[Number(cur.items[i].dataset.i)];
    close();
    sel.focus();
    if (!opt || opt.disabled || opt.selected) return;
    opt.selected = true;
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
}

function open(sel) {
    close();
    const pop = document.createElement('div');
    pop.className = 'sm-pop';
    pop.setAttribute('role', 'listbox');
    if (sel.getAttribute('aria-label')) pop.setAttribute('aria-label', sel.getAttribute('aria-label'));

    const items = [];
    let active = -1;
    Array.from(sel.options).forEach((o, i) => {
        if (o.hidden) return;
        const el = document.createElement('div');
        el.className = 'sm-item';
        el.setAttribute('role', 'option');
        el.dataset.i = String(i);
        if (o.disabled) el.setAttribute('aria-disabled', 'true');
        if (o.selected) { el.setAttribute('aria-selected', 'true'); active = items.length; }
        el.innerHTML = CHECK;
        el.append(o.textContent);
        pop.append(el);
        items.push(el);
    });
    if (!items.length) return;

    pop.addEventListener('mousedown', (e) => {
        e.preventDefault();   // keep focus on the select
        const el = e.target.closest('.sm-item');
        if (el && el.getAttribute('aria-disabled') !== 'true') pick(items.indexOf(el));
    });
    pop.addEventListener('mousemove', (e) => {
        const el = e.target.closest('.sm-item');
        if (el && el.getAttribute('aria-disabled') !== 'true') setActive(items.indexOf(el));
    });

    document.body.append(pop);
    cur = { sel, pop, items, active: -1 };
    sel.setAttribute('aria-expanded', 'true');

    // below the select, or above when there's more room there (the chat composer sits at the bottom)
    const r = sel.getBoundingClientRect();
    const gap = 6, margin = 8;
    pop.style.minWidth = r.width + 'px';
    const below = window.innerHeight - r.bottom - gap - margin;
    const above = r.top - gap - margin;
    const up = pop.offsetHeight > below && above > below;
    pop.style.maxHeight = Math.min(320, up ? above : below) + 'px';
    if (up) {
        pop.classList.add('sm-up');
        pop.style.bottom = (window.innerHeight - r.top + gap) + 'px';
    } else {
        pop.style.top = (r.bottom + gap) + 'px';
    }
    pop.style.left = Math.max(margin, Math.min(r.left, window.innerWidth - pop.offsetWidth - margin)) + 'px';

    setActive(active >= 0 ? active : step(-1, 1));
}

document.addEventListener('mousedown', (e) => {
    if (cur && cur.pop.contains(e.target)) return;
    const sel = e.target.closest && e.target.closest('select');
    if (e.button === 0 && enhanced(sel)) {
        e.preventDefault();   // stops the OS popup
        const wasOpen = cur && cur.sel === sel;
        close();
        sel.focus();
        if (!wasOpen) open(sel);
        return;
    }
    close();
}, true);

document.addEventListener('keydown', (e) => {
    if (cur) {
        const n = cur.items.length;
        let next;
        switch (e.key) {
            case 'ArrowDown': next = step(cur.active, 1); break;
            case 'ArrowUp':   next = step(cur.active, -1); break;
            case 'Home':      next = step(-1, 1); break;
            case 'End':       next = step(n, -1); break;
            case 'Enter': case ' ':
                e.preventDefault();
                if (cur.active >= 0) pick(cur.active); else close();
                return;
            case 'Escape':
                e.preventDefault();
                e.stopPropagation();   // don't also trigger page-level Esc (e.g. stop the chat stream)
                cur.sel.focus();
                close();
                return;
            case 'Tab': close(); return;
            default: return;
        }
        e.preventDefault();
        if (next >= 0) setActive(next);
        return;
    }
    const sel = e.target;
    if (sel.tagName !== 'SELECT' || !enhanced(sel)) return;
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'F4') {
        e.preventDefault();
        open(sel);
    }
}, true);

// the popup is positioned once; anything that moves the page closes it (scrolling inside it doesn't)
window.addEventListener('scroll', (e) => { if (cur && !cur.pop.contains(e.target)) close(); }, true);
window.addEventListener('resize', close);
window.addEventListener('blur', close);
