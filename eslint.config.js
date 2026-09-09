const js = require('@eslint/js');
const globals = require('globals');

// Globals shared across js/ files via window; no-undef depends on this list being right.
const SHARED_BROWSER_GLOBALS = {
    AppConfig: 'readonly',
    BASE: 'readonly',
    Auth: 'readonly',
    I18N: 'readonly',
    // Assigned onto window inside an IIFE in js/i18n.js, invisible to static analysis.
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

    // Frontend: ES modules, but cross-file names still ride on window.
    {
        files: ['js/**/*.js'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'module',
            globals: { ...globals.browser, ...SHARED_BROWSER_GLOBALS },
        },
    },
    // Build tooling runs in node as ESM.
    {
        files: ['vite.config.mjs', 'scripts/**/*.mjs'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'module',
            globals: { ...globals.node },
        },
    },

    {
        rules: {
            // Empty catch is the repo's idiom for optional browser APIs.
            'no-empty': ['error', { allowEmptyCatch: true }],

            // Pre-existing debt: warn so it stays visible; CI gates on errors only.
            'no-unused-vars': [
                'warn',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
            ],
            'no-useless-escape': 'warn',
            'no-useless-assignment': 'warn',
            // The file that defines a shared global is not redeclaring it.
            'no-redeclare': ['warn', { builtinGlobals: false }],
        },
    },
];
