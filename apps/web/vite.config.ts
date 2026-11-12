import { readFileSync } from 'node:fs';
import {fileURLToPath} from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {rollupOptions: {input: {main:fileURLToPath(new URL('./index.html',import.meta.url)),admin:fileURLToPath(new URL('./admin/index.html',import.meta.url)),paymentReturn:fileURLToPath(new URL('./payment/alipay/return.html',import.meta.url))}}},
  server: {
    port: 5173, strictPort: true,
    // Development proxy preserves the browser Origin and Secure cookies.
    // Production serves dist/ and /api/v1 under one HTTPS origin via Nginx.
    proxy: { '/api/v1': { target: process.env.BB_API_PROXY_TARGET ?? 'http://127.0.0.1:3000' } },
    https: process.env.BB_WEB_TLS_CERT && process.env.BB_WEB_TLS_KEY ? {
      cert: readFileSync(process.env.BB_WEB_TLS_CERT), key: readFileSync(process.env.BB_WEB_TLS_KEY)
    } : undefined
  }
});
