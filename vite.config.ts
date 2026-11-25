import { build, defineConfig, type Plugin, type ResolvedConfig } from "vite";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { fileTypeIconsPlugin } from "./scripts/vite-file-type-icons";

function winUiEditorBundle(): Plugin {
  let config: ResolvedConfig;
  return {
    name: "vpaste-winui-editor-bundle",
    apply: "build",
    configResolved(resolved) { config = resolved; },
    async closeBundle() {
      // Avoid a fresh WebView2 waiting on the main application's chunk graph.
      // The editor shares the same source and styles, not a second feature.
      await build({
        configFile: false,
        root: config.root,
        mode: config.mode,
        base: config.base,
        plugins: [react()],
        build: {
          outDir: resolve(config.root, config.build.outDir),
          emptyOutDir: false,
          copyPublicDir: false,
          cssCodeSplit: false,
          rollupOptions: {
            input: fileURLToPath(new URL("./text-editor.html", import.meta.url)),
            output: { inlineDynamicImports: true },
          },
        },
      });
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), fileTypeIconsPlugin(), winUiEditorBundle()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // 3. tell vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
