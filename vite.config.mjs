import { defineConfig } from 'vite';
import { resolve } from 'path';

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
        // dev: หน้าอยู่ :5173 API อยู่ :3001 — proxy ให้เป็น same-origin
        // ไม่งั้น cookie SameSite=Strict ไม่วิ่งข้าม origin แล้ว login ไม่ติด
        proxy: { '/api': 'http://localhost:3001' },
    },
    plugins: [
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
