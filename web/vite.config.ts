import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

// 本地开发：npm run web:dev（:5185）+ 后端 npm start（:18543）。
// 登录 cookie 属于同源，因此把后端路由整段代理过去，前端代码里不出现绝对地址。
const BACKEND = process.env.AIMEMORY_BACKEND_ORIGIN || 'http://127.0.0.1:18543';
const PROXIED = ['/api', '/v1', '/v2', '/auth', '/mcp', '/healthz', '/skill'];

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5185,
    strictPort: true,
    proxy: Object.fromEntries(
      PROXIED.map((route) => [route, { target: BACKEND, changeOrigin: true }]),
    ),
  },
});
