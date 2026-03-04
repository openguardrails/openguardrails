import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

export default defineConfig({
  base: "/dashboard/",
  plugins: [react()],
  resolve: {
    alias: { "@": resolve(__dirname, "src") },
  },
  build: {
    outDir: "out",
    emptyOutDir: true,
  },
  server: {
    allowedHosts: true,
    proxy: {
      "/api": "http://localhost:53667",
      "/dashboard/api": {
        target: "http://localhost:53667",
        rewrite: (path) => path.replace(/^\/dashboard/, ""),
      },
    },
  },
});
