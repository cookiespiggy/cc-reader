import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Tauri 2 + WKWebView (macOS): 目标定 safari15, 保证不用太新的 JS API
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  // 前端静态资源放在 web/ 下, sessions.json (Rust dump) 也放这儿
  publicDir: "web/public",
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // src-tauri 由 cargo 管, 别让 vite 去 watch
      ignored: ["**/src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "safari15",
    // Vite 8 默认用 oxc 压缩; 显式写 "esbuild" 需要单独装 esbuild
    sourcemap: false,
  },
});
