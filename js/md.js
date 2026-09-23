// Markdown rendering for chat: marked → DOMPurify → hljs, plus copy/download buttons.
const ICON_COPY = '<svg class="ic sm" aria-hidden="true" viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
const ICON_DOWNLOAD = '<svg class="ic sm" aria-hidden="true" viewBox="0 0 24 24"><path d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v3h16v-3"/></svg>';
// Exposes global MD: render(text), postProcess(el), attachMessageCopy(el, rawText).
// While streaming, callers render escaped plain text and swap to markdown at the end.

(function () {
    'use strict';

    // libs load via <script> in <head>; marked, DOMPurify and hljs are globals.
    function libsReady() {
        return typeof window.marked !== 'undefined'
            && typeof window.DOMPurify !== 'undefined'
            && typeof window.hljs !== 'undefined';
    }

    // marked options
    if (typeof window.marked !== 'undefined') {
        window.marked.setOptions({
            gfm:         true,   // GitHub Flavored Markdown (tables, task lists)
            breaks:      true,   // treat single \n as <br>
            pedantic:    false,
            smartLists:  true,
        });

        // GFM strikethrough off: in ABAP `~` joins alias to field (stock~matnr) and GFM would swallow it.
        try {
            window.marked.use({ tokenizer: { del: () => false } });
        } catch (e) {
            console.warn('[md] could not disable strikethrough:', e.message);
        }
    }

    // Rewrite the model's <analysis> / <code> wrappers into markdown before parsing, so the
    // ABAP is fenced (highlight + copy button). Unclosed tags are handled too.
    function normalizeModelBlocks(text) {
        let t = String(text);
        t = t.replace(/<analysis>\s*([\s\S]*?)\s*<\/analysis>/gi, '\n\n$1\n\n');
        t = t.replace(/<(?:modified\s+)?code>\s*([\s\S]*?)\s*<\/(?:modified\s+)?code>/gi,
                      '\n\n```abap\n$1\n```\n\n');
        // opened but never closed → treat the remainder as the code block
        t = t.replace(/<(?:modified\s+)?code>\s*([\s\S]*)$/i, '\n\n```abap\n$1\n```\n');
        t = t.replace(/<\/?analysis>/gi, '');
        return t;
    }

    // DOMPurify config: tight allowlist, anything else is stripped.
    const PURIFY_CONFIG = {
        ALLOWED_TAGS: [
            'h1','h2','h3','h4','h5','h6',
            'p','br','hr',
            'strong','em','b','i','u','s','del','ins','mark',
            'a','code','pre','kbd','samp','var',
            'ul','ol','li',
            'blockquote',
            'table','thead','tbody','tr','th','td',
            // no <img>: a model answer could embed a src that leaks the reader's IP
        ],
        // no id/name: model output must not shadow page ids; class is narrowed by the hook below
        ALLOWED_ATTR: ['href','title','alt','class','start','type'],
        FORBID_ATTR: ['style','onerror','onload','onclick','onmouseover'],
        ALLOW_DATA_ATTR: false,
        // http(s)/mailto/tel only; blocks javascript: and data:
        ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel):|#|\/)/i,
    };

    let purifyHooked = false;

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
            const raw = window.marked.parse(normalizeModelBlocks(text));
            if (!purifyHooked) {
                // class only as marked's `language-xxx` on <code> — else an answer could reuse page
                // classes (e.g. a full-screen overlay link)
                window.DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
                    if (data.attrName === 'class'
                        && !(node.nodeName === 'CODE' && /^language-[\w-]+$/.test(data.attrValue))) {
                        data.keepAttr = false;
                    }
                });
                purifyHooked = true;
            }
            return window.DOMPurify.sanitize(raw, PURIFY_CONFIG);
        } catch (e) {
            console.warn('[md] render failed, falling back to escape:', e.message);
            return escapeHtml(text);
        }
    }

    // Post-process: syntax highlight + copy buttons
    // highlight.js ships no ABAP grammar, and nearly every answer here is ABAP
    const ABAP_KEYWORDS = 'report program include function-pool class-pool form endform perform using changing '
        + 'tables data types constants field-symbols parameters select-options statics type ref to like value '
        + 'begin end of occurs with header line default key unique non-unique sorted hashed standard table '
        + 'class endclass definition implementation public private protected section inheriting from final '
        + 'abstract create method endmethod methods class-methods class-data interface endinterface interfaces '
        + 'importing exporting returning raising exceptions receiving optional preferred parameter '
        + 'function endfunction call function method transaction screen new cast conv corresponding '
        + 'if elseif else endif case when others endcase do enddo while endwhile loop at endloop into '
        + 'assigning reference exit continue check return try catch cleanup endtry raise exception '
        + 'select single endselect distinct up rows where and or not in is between order by group having '
        + 'as for all entries join inner left outer on appending insert update modify delete read '
        + 'append collect sort clear free refresh move move-corresponding write message start-of-selection '
        + 'end-of-selection initialization at selection-screen top-of-page authority-check commit rollback work '
        + 'concatenate split condense replace translate find shift separated respecting blanks occurrences '
        + 'binary search transporting index let base bound supplied assigned initial';
    let abapRegistered = false;
    function registerAbap() {
        if (abapRegistered || window.hljs.getLanguage('abap')) return;
        abapRegistered = true;
        window.hljs.registerLanguage('abap', () => ({
            name: 'ABAP',
            case_insensitive: true,
            keywords: {
                $pattern: /[\w-]+/,   // hyphenated words: move-corresponding, sy-subrc
                keyword: ABAP_KEYWORDS,
                literal: 'abap_true abap_false abap_undefined space',
                built_in: 'sy-subrc sy-tabix sy-index sy-datum sy-uzeit sy-uname sy-dbcnt sy-langu sy-mandt '
                    + 'lines strlen xstrlen condense_string boolc xsdbool',
            },
            contains: [
                { scope: 'comment', begin: /^\*/, end: /$/ },   // * in column 1
                { scope: 'comment', begin: /"/, end: /$/ },
                { scope: 'string', begin: /'/, end: /'/ },
                { scope: 'string', begin: /`/, end: /`/ },
                { scope: 'string', begin: /\|/, end: /\|/, contains: [{ scope: 'subst', begin: /\{/, end: /\}/ }] },
                { scope: 'number', begin: /\b\d+\b/ },
            ],
        }));
    }

    function postProcess(rootEl) {
        if (!rootEl || !libsReady()) return;
        registerAbap();

        // Force safe link attributes.
        rootEl.querySelectorAll('a[href]').forEach(a => {
            a.setAttribute('target', '_blank');
            a.setAttribute('rel', 'noopener noreferrer');
        });

        // Wrap every <table> in a scrollable container so wide tables keep their column widths.
        rootEl.querySelectorAll('table').forEach(tb => {
            if (tb.parentElement && tb.parentElement.classList.contains('md-table-wrap')) return;
            const wrap = document.createElement('div');
            wrap.className = 'md-table-wrap';
            tb.parentNode.insertBefore(wrap, tb);
            wrap.appendChild(tb);
        });

        rootEl.querySelectorAll('pre > code').forEach(codeEl => {
            // hljs decides the language from a `language-xxx` class if present.
            try { window.hljs.highlightElement(codeEl); } catch (_) {}

            const pre = codeEl.parentElement;
            if (pre.querySelector('.code-copy-btn')) return;   // idempotent

            // header row: language label + copy button
            const head = document.createElement('div');
            head.className = 'code-head';
            const lang = (codeEl.className.match(/language-([\w-]+)/) || [])[1] || 'code';
            const langEl = document.createElement('span');
            langEl.className = 'lang';
            langEl.textContent = lang;
            head.appendChild(langEl);
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'code-copy-btn';
            btn.setAttribute('aria-label', 'คัดลอกโค้ด');
            btn.innerHTML = ICON_COPY + '<span class="msg-action-label">Copy</span>';
            btn.addEventListener('click', () => copyTextTo(codeEl.innerText, btn));
            head.appendChild(btn);
            pre.appendChild(head);
        });
    }

    // Whole-message copy button
    function attachMessageCopy(bubbleEl, rawText) {
        if (!bubbleEl) return;
        if (bubbleEl.querySelector('.msg-actions')) return;

        const actions = document.createElement('div');
        actions.className = 'msg-actions';

        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'msg-action-btn';
        copyBtn.setAttribute('aria-label', 'คัดลอกคำตอบ');
        copyBtn.innerHTML = '<span class="msg-action-icon">' + ICON_COPY + '</span><span class="msg-action-label">Copy</span>';
        copyBtn.addEventListener('click', () => copyTextTo(rawText, copyBtn));

        actions.appendChild(copyBtn);
        bubbleEl.appendChild(actions);
        return actions;   // caller can append more buttons (e.g. Regenerate)
    }

    // When the answer carries a corrected source file, download the code alone so the .abap compiles.
    function downloadableBody(rawText) {
        const t = String(rawText || '');
        const blocks = [...t.matchAll(/```(?:\w+)?\r?\n([\s\S]*?)```/g)].map(m => m[1]);
        if (!blocks.length) return t;                       // prose answer — save as-is
        return blocks.reduce((a, b) => (b.length > a.length ? b : a)).replace(/\s+$/, '') + '\n';
    }

    // Download button: save the AI response as a file
    function attachMessageDownload(actionsEl, rawText, filename) {
        if (!actionsEl) return;
        if (actionsEl.querySelector('.msg-action-download')) return;   // idempotent

        const dlBtn = document.createElement('button');
        dlBtn.type = 'button';
        dlBtn.className = 'msg-action-btn msg-action-download';
        dlBtn.setAttribute('aria-label', 'ดาวน์โหลดคำตอบ');
        dlBtn.innerHTML = '<span class="msg-action-icon">' + ICON_DOWNLOAD + '</span><span class="msg-action-label">Download</span>';
        dlBtn.addEventListener('click', () =>
            downloadText(downloadableBody(rawText),
                filename ? withExtension(filename, rawText) : guessFilename(rawText)));

        actionsEl.appendChild(dlBtn);
        return dlBtn;
    }

    // Extension from the fenced block's language, so ABAP downloads as .abap not .txt.
    const LANG_EXT = {
        abap: 'abap', javascript: 'js', typescript: 'ts', python: 'py',
        java: 'java', json: 'json', sql: 'sql', xml: 'xml', html: 'html',
        css: 'css', bash: 'sh', shell: 'sh', sh: 'sh', yaml: 'yml', yml: 'yml',
        c: 'c', cpp: 'cpp', csharp: 'cs', go: 'go', ruby: 'rb', php: 'php',
        markdown: 'md', md: 'md', plaintext: 'txt', text: 'txt',
    };
    // Uploads often arrive without an extension; take it from the code block's language.
    function withExtension(name, rawText) {
        if (/\.[A-Za-z0-9]{1,6}$/.test(name)) return name;
        const m = /^```(\w+)?/m.exec(String(rawText || ''));
        return name + '.' + (LANG_EXT[(m && m[1] || '').toLowerCase()] || 'txt');
    }

    function guessFilename(rawText) {
        const m = /^```(\w+)?/m.exec(String(rawText || ''));
        const lang = m && m[1] ? m[1].toLowerCase() : '';
        const ext = LANG_EXT[lang] || 'txt';
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        return `pipekai-response-${ts}.${ext}`;
    }

    // Client-side download via Blob + <a download>
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

    // Copy helper with feedback
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

    // Public API
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
