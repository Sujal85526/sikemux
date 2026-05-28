import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed dev port and ignores src-tauri so the Rust watcher
// owns backend rebuilds.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  build: {
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("@codemirror") || id.includes("@lezer") || id.includes("codemirror")) {
            return "codemirror";
          }
          if (id.includes("@xterm")) return "xterm";
          if (id.includes("react") || id.includes("react-dom") || id.includes("scheduler")) {
            return "react";
          }
          return "vendor";
        },
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
