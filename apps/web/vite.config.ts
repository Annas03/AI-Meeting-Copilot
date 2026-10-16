import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The single .env file lives at the repository root; only VITE_* variables reach the browser.
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const serverTarget = process.env.VITE_SERVER_URL || 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [react()],
  envDir: repoRoot,
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': { target: serverTarget, changeOrigin: true },
      '/ws': { target: serverTarget.replace(/^http/, 'ws'), ws: true, changeOrigin: true },
    },
  },
});
