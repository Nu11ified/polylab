import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: false
  },
  build: {
    target: "esnext",
    cssMinify: "lightningcss",
    modulePreload: {
      polyfill: false
    },
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          const [, packageName] = id.split("node_modules/");
          const name = packageName?.startsWith("@")
            ? packageName.split("/").slice(0, 2).join("-")
            : packageName?.split("/")[0];
          return name ? `vendor-${name.replace("@", "")}` : "vendor";
        }
      }
    }
  }
});
