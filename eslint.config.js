const js = require('@eslint/js');
const globals = require('globals');

// Globals the HTML pages and the js/ files share across <script> tags.
// no-undef only earns its keep if this list is right — see js/config.js,
// js/auth.js, js/admin.js, js/i18n.js.
const SHARED_BROWSER_GLOBALS = {
    AppConfig: 'readonly',
    BASE: 'readonly',
    Auth: 'readonly',
    I18N: 'readonly',
    // js/i18n.js assigns these onto window from inside an IIFE, so no static
    // analysis can find them.
    t: 'readonly',
    tf: 'readonly',
    AIClient: 'readonly',
    PRICING: 'readonly',
    MockAI: 'readonly',
    MD: 'readonly',
    admin: 'writable',
    marked: 'readonly',
    DOMPurify: 'readonly',
    hljs: 'readonly',
};

module.exports = [
    {
        ignores: [
            '**/node_modules/**',
            '.claude/**',
            'server/logs/**',
            'server/knowledge/**',
            'backups/**',
            '_archive/**',
            '_ux-mockup/**',
            'dist/**',
            'js/vendor/**',
            'css/vendor/**',
        ],
    },

    js.configs.recommended,

    // Backend + repo-root scripts: CommonJS on Node.
    {
        files: ['server/**/*.js', 'start.js', 'eslint.config.js'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'commonjs',
            globals: { ...globals.node },
        },
    },

    // Frontend: classic scripts sharing globals, not modules.
    {
        files: ['js/**/*.js'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'script',
            globals: { ...globals.browser, ...SHARED_BROWSER_GLOBALS },
        },
    },

    {
        rules: {
            // Empty catch is the repo's idiom for optional browser APIs.
            'no-empty': ['error', { allowEmptyCatch: true }],

            // Pre-existing debt: warn so it stays visible, but let CI gate on
            // errors only. Phase 47 does not rewrite running code.
            'no-unused-vars': [
                'warn',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
            ],
            'no-useless-escape': 'warn',
            'no-useless-assignment': 'warn',
            // builtinGlobals:false — the file that DEFINES a shared global is
            // not redeclaring it. Real in-file redeclares still warn.
            'no-redeclare': ['warn', { builtinGlobals: false }],
        },
    },
];
