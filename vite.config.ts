import { defineConfig } from "vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import tailwind from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: "web",
  plugins: [react(), babel({ presets: [reactCompilerPreset()] }), tailwind()],
  resolve: { alias: { "@": fileURLToPath(new URL("./web/src", import.meta.url)) } },
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { outDir: "../dist", emptyOutDir: true, target: "safari17" },
});
