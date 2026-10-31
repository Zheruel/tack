import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
const here = fileURLToPath(new URL('.', import.meta.url));
const root = fileURLToPath(new URL('../../../', import.meta.url));
export default defineConfig({
  root: here,
  plugins: [{
    name: 'next-steps-concept', enforce: 'pre',
    resolveId(id, importer) {
      if (!importer?.startsWith(root + 'web/src/')) return;
      if (/(^|\/)rpc$/.test(id)) return here + 'rpc.ts';
      if (importer.endsWith('/Transcript.tsx') && id === './ItemView') return here + 'ItemView.tsx';
      if (importer.endsWith('/App.tsx') && id === './components/Composer') return here + 'Composer.tsx';
      if (/(^|\/)Questions$/.test(id)) return here + 'HiddenQuestions.tsx';
    },
  }, react(), tailwind()],
  server: { host: '127.0.0.1', port: 1422, strictPort: true, fs: { allow: [root] } },
  preview: { host: '127.0.0.1', port: 1422, strictPort: true },
  build: { outDir: '../app', emptyOutDir: true },
});
