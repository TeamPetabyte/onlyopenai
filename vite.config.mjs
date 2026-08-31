import { defineConfig } from 'vite';
import { resolve } from 'path';
import { execSync } from 'child_process';

export default defineConfig({
    build: {
        outDir: 'dist',
        // ห้ามใช้ 'assets' — ชนกับโฟลเดอร์ /assets (รูป/โลโก้) ที่ express เสิร์ฟจาก source tree
        assetsDir: 'static',
        rollupOptions: {
            input: {
                index: resolve(__dirname, 'index.html'),
                admin: resolve(__dirname, 'admin.html'),
                login: resolve(__dirname, 'login.html'),
                'change-password': resolve(__dirname, 'change-password.html'),
            },
        },
    },
    server: {
        // dev: proxy API (:3001) เป็น same-origin ไม่งั้น cookie SameSite=Strict ไม่วิ่งแล้ว login ไม่ติด
        proxy: { '/api': 'http://localhost:3001' },
    },
    plugins: [
        {
            // vite ต่อ CSS รวมไว้หลัง <style> inline ที่ตั้งใจ override มัน — ย้าย <link> กลับไปก่อน <style> ให้ cascade เท่า source
            name: 'css-before-inline-style',
            apply: 'build',
            transformIndexHtml: {
                order: 'post',
                handler(html) {
                    const links = [];
                    html = html.replace(/[ \t]*<link rel="stylesheet"[^>]*>\r?\n?/g, (m) => { links.push(m.trim()); return ''; });
                    if (!links.length) return html;
                    return html.replace(/<style[\s>]/, (m) => links.join('\n    ') + '\n    ' + m);
                },
            },
        },
        {
            // เขียน commit ที่ build ลง dist ให้ server เทียบกับ HEAD ตอน boot (dist รอด git reset มาได้)
            name: 'build-meta',
            apply: 'build',
            generateBundle() {
                let commit = null;
                try { commit = execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch (_) { /* build ได้แม้ไม่มี git */ }
                this.emitFile({ type: 'asset', fileName: 'build-meta.json', source: JSON.stringify({ commit, builtAt: new Date().toISOString() }) });
            },
        },
        {
            // dev เท่านั้น: ชี้ API_BASE มาที่ origin ของ vite เพื่อให้วิ่งผ่าน proxy ข้างบน
            name: 'dev-api-base',
            apply: 'serve',
            transformIndexHtml() {
                return [{
                    tag: 'script',
                    children: 'window.__API_BASE__ = location.origin;',
                    injectTo: 'head-prepend',
                }];
            },
        },
    ],
});
