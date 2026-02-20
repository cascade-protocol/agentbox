import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  envDir: "../..",
  plugins: [tailwindcss(), TanStackRouterVite({ autoCodeSplitting: true }), react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      sonner: path.resolve(__dirname, "./src/lib/sonner-shim.tsx"),
      "@fontsource-variable/dm-sans": path.resolve(__dirname, "./src/styles/dm-sans.css"),
    },
  },
  server: {
    proxy: {
      "/api": "http://localhost:8080",
      "/health": "http://localhost:8080",
    },
  },
});
