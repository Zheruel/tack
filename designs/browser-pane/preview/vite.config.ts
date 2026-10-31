import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
const here=fileURLToPath(new URL('.', import.meta.url));
const root=fileURLToPath(new URL('../../../', import.meta.url));
export default defineConfig({root:here, plugins:[{
  name:'concept-rpc', enforce:'pre', resolveId(id,importer){if(importer?.startsWith(root+'web/src/') && /(^|\/)rpc$/.test(id)) return here+'rpc.ts';}
},react(),tailwind()],server:{host:'127.0.0.1',port:1421,strictPort:true,fs:{allow:[root]}},preview:{host:'127.0.0.1',port:1421,strictPort:true},build:{outDir:'../app',emptyOutDir:true}});
