// ╔═══════════════════════════════════════════════════════════╗
// ║ Markdown + code-highlight + copy-buttons helper           ║
// ╚═══════════════════════════════════════════════════════════╝
// Exposes a single global `MD` with:
//   MD.render(text)         → safe HTML string
//   MD.postProcess(element) → attach copy buttons to code blocks
//   MD.attachMessageCopy(el, rawText) → put a ⧉ Copy button on a message
//
// Pipeline: raw markdown
//   → marked.parse() → HTML
//   → DOMPurify.sanitize() → safe HTML (strips <script>, on* handlers, etc.)
//   → insert into DOM
//   → hljs.highlightElement() on each <pre><code>
//   → add "Copy" button to each <pre>
//
// XSS hardening notes:
//   - DOMPurify removes all javascript: URIs and inline handlers by default.
//   - We also strip `target` / `onload` / `onerror` attributes explicitly.
//   - We block data: URIs on <img> to prevent giant embedded payloads from
//     blowing up the browser (AI sometimes hallucinates base64 images).
//   - Links are forced to rel="noopener noreferrer" and target="_blank".
//
// Streaming strategy:
//   During streaming, we use plain-text rendering (escape only) because
//   markdown is not parseable mid-sentence. When streaming ends, we swap
//   to rendered markdown + syntax highlight in one pass.

(function () {
    'use strict';

    // ─── Wait-until-ready guard (libs load via <script> in <head>) ──
    // marked and DOMPurify export global objects of the same name; hljs
    // is available as window.hljs.
    function libsReady() {
        return typeof window.marked !== 'undefined'
            && typeof window.DOMPurify !== 'undefined'
            && typeof window.hljs !== 'undefined';
    }

    // ─── marked options ─────────────────────────────────────
    if (typeof window.marked !== 'undefined') {
        window.marked.setOptions({
            gfm:         true,   // GitHub Flavored Markdown (tables, strikethrough, task lists)
            breaks:      true,   // treat single \n as <br>  — AI output prefers this
            pedantic:    false,
            smartLists:  true,
        });
    }

    // ─── DOMPurify config ───────────────────────────────────
    // Tight allowlist. Anything AI outputs outside of this is stripped.
    const PURIFY_CONFIG = {
        ALLOWED_TAGS: [
            'h1','h2','h3','h4','h5','h6',
            'p','br','hr',
            'strong','em','b','i','u','s','del','ins','mark',
            'a','code','pre','kbd','samp','var',
            'ul','ol','li',
            'blockquote',
            'table','thead','tbody','tr','th','td',
            'img',
        ],
        ALLOWED_ATTR: ['href','title','alt','src','class','name','id','start','type'],
        FORBID_ATTR: ['style','onerror','onload','onclick','onmouseover'],
        ALLOW_DATA_ATTR: false,
        // Force http(s) only — blocks javascript:, data: (except image at our discretion)
        ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel):|#|\/)/i,
    };

    function escapeHtml(t) {
        return String(t)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    function render(text) {
        if (text == null) return '';
        if (!libsReady()) return escapeHtml(text);
        try {
            const raw = window.marked.parse(String(text));
            return window.DOMPurify.sanitize(raw, PURIFY_CONFIG);
        } catch (e) {
            console.warn('[md] render failed, falling back to escape:', e.message);
            return escapeHtml(text);
        }
    }

    // ─── Post-process: apply syntax highlight + copy buttons ──
    function postProcess(rootEl) {
        if (!rootEl || !libsReady()) return;

        // After DOMPurify we trust the subtree. Force-link safety.
        rootEl.querySelectorAll('a[href]').forEach(a => {
            a.setAttribute('target', '_blank');
            a.setAttribute('rel', 'noopener noreferrer');
        });

        // Syntax highlight every <pre><code>
        rootEl.querySelectorAll('pre > code').forEach(codeEl => {
            // hljs decides the language from a `language-xxx` class if present.
            try { window.hljs.highlightElement(codeEl); } catch (_) {}

            const pre = codeEl.parentElement;
            if (pre.querySelector('.code-copy-btn')) return;   // idempotent

            // ─── copy button (absolute-positioned) ──────────
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'code-copy-btn';
            btn.setAttribute('aria-label', 'คัดลอกโค้ด');
            btn.textContent = 'Copy';
            btn.addEventListener('click', () => copyTextTo(codeEl.innerText, btn));
            pre.appendChild(btn);
        });
    }

    // ─── Whole-message copy button ─────────────────────────
    function attachMessageCopy(bubbleEl, rawText) {
        if (!bubbleEl) return;
        if (bubbleEl.querySelector('.msg-actions')) return;

        const actions = document.createElement('div');
        actions.className = 'msg-actions';

        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'msg-action-btn';
        copyBtn.setAttribute('aria-label', 'คัดลอกคำตอบ');
        copyBtn.innerHTML = '<span class="msg-action-icon">⧉</span><span class="msg-action-label">Copy</span>';
        copyBtn.addEventListener('click', () => copyTextTo(rawText, copyBtn));

        actions.appendChild(copyBtn);
        bubbleEl.appendChild(actions);
        return actions;   // caller can append more buttons (e.g. Regenerate)
    }

    // ─── Download button: save the raw AI response as a file ──
    function attachMessageDownload(actionsEl, rawText, filename) {
        if (!actionsEl) return;
        if (actionsEl.querySelector('.msg-action-download')) return;   // idempotent

        const dlBtn = document.createElement('button');
        dlBtn.type = 'button';
        dlBtn.className = 'msg-action-btn msg-action-download';
        dlBtn.setAttribute('aria-label', 'ดาวน์โหลดคำตอบ');
        dlBtn.innerHTML = '<span class="msg-action-icon">⬇</span><span class="msg-action-label">Download</span>';
        dlBtn.addEventListener('click', () => downloadText(rawText, filename || guessFilename(rawText)));

        actionsEl.appendChild(dlBtn);
        return dlBtn;
    }

    // ─── Pick a sensible filename/extension from the response ──
    // If the AI response is a single fenced code block, use its language
    // for the extension so e.g. ABAP code downloads as .abap not .txt.
    const LANG_EXT = {
        abap: 'abap', javascript: 'js', typescript: 'ts', python: 'py',
        java: 'java', json: 'json', sql: 'sql', xml: 'xml', html: 'html',
        css: 'css', bash: 'sh', shell: 'sh', sh: 'sh', yaml: 'yml', yml: 'yml',
        c: 'c', cpp: 'cpp', csharp: 'cs', go: 'go', ruby: 'rb', php: 'php',
        markdown: 'md', md: 'md', plaintext: 'txt', text: 'txt',
    };
    function guessFilename(rawText) {
        const m = /^```(\w+)?/m.exec(String(rawText || ''));
        const lang = m && m[1] ? m[1].toLowerCase() : '';
        const ext = LANG_EXT[lang] || 'txt';
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        return `pipekai-response-${ts}.${ext}`;
    }

    // ─── Trigger a client-side file download via Blob + <a download> ──
    function downloadText(text, filename) {
        try {
            const blob = new Blob([String(text || '')], { type: 'text/plain;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename || 'pipekai-response.txt';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch (e) {
            console.warn('[md] download failed:', e.message);
        }
    }

    // ─── Copy helper with feedback ─────────────────────────
    function copyTextTo(text, btnEl) {
        const done = () => {
            if (!btnEl) return;
            const prev = btnEl.textContent;
            const prevLabel = btnEl.querySelector('.msg-action-label');
            if (prevLabel) prevLabel.textContent = 'Copied';
            else btnEl.textContent = 'Copied';
            btnEl.classList.add('is-copied');
            setTimeout(() => {
                btnEl.classList.remove('is-copied');
                if (prevLabel) prevLabel.textContent = 'Copy';
                else btnEl.textContent = prev;
            }, 1400);
        };
        if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(text).then(done, () => fallback(text, done));
        } else {
            fallback(text, done);
        }
    }
    function fallback(text, done) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); done(); }
        catch (_) { /* silent */ }
        document.body.removeChild(ta);
    }

    // ─── Public API ────────────────────────────────────────
    window.MD = {
        render,
        postProcess,
        attachMessageCopy,
        attachMessageDownload,
        escapeHtml,
        copyText: copyTextTo,
        get ready() { return libsReady(); },
    };
})();
