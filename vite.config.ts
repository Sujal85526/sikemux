import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
import type { PluginOption } from "vite";
import react from "@vitejs/plugin-react";

function pruneBundleOnlyPublicAssets(): PluginOption {
  return {
    name: "sikemux-prune-bundle-only-public-assets",
    closeBundle() {
      for (const rel of ["screenshots", ".DS_Store"]) {
        rmSync(resolve("dist", rel), { recursive: true, force: true });
      }
    },
  };
}

// Tauri expects a fixed dev port and ignores src-tauri so the Rust watcher
// owns backend rebuilds.
export default defineConfig({
  plugins: [react(), pruneBundleOnlyPublicAssets()],
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
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    globals: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      reportsDirectory: "coverage",
    },
  },
});
