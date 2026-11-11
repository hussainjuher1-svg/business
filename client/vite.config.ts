import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// This config runs in Node, but the project deliberately does not depend on
// @types/node just to read two environment variables.
declare const process: { env: Record<string, string | undefined> };

// The browser talks ONLY to this dev server. It never calls Ollama directly —
// model access lives exclusively in the backend (server/src/ai/ollama.js), so
// the endpoint stays local to the machine running Daybook.
//
// The backend target is loopback unless DAYBOOK_API_TARGET overrides it.
const apiTarget = process.env.DAYBOOK_API_TARGET || 'http://127.0.0.1:3001';

export default defineConfig({
  plugins: [react()],
  server: {
    // 127.0.0.1 keeps the dev server on this machine. Set HOST=0.0.0.0 only if
    // you deliberately want to reach it from another device on your LAN.
    host: process.env.HOST || '127.0.0.1',
    port: 5173,
    strictPort: true,
    // No `allowedHosts: true`. Allowing arbitrary Host headers turns the dev
    // server into an open proxy; loopback use never needs it.
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
      '/health': { target: apiTarget, changeOrigin: true },
    },
  },
});
