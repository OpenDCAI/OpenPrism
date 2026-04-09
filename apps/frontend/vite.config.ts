import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const proxy = {
  '/api': {
    target: 'http://localhost:8787',
    changeOrigin: true,
    ws: true,
    xfwd: true
  },
  '/texlive': {
    target: 'https://texlive.swiftlatex.com',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/texlive/, '')
  }
};

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy
  },
  // `vite preview` 默认不带 dev 的 proxy，未配置时 /api/* 会 404（与静态服务器行为一致）
  preview: {
    proxy
  }
});
