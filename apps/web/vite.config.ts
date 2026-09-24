import { defineConfig } from 'vite';
export default defineConfig({
  server: {
    port: 4321,
    strictPort: true,
    proxy: { '/api/v1': { target: process.env.BB_API_PROXY ?? 'http://127.0.0.1:3100', changeOrigin: false } }
  }
});
