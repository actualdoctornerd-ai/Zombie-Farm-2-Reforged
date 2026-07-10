import { defineConfig } from "vite";

export default defineConfig({
  // Relative base so the built app works both at a domain root and under a
  // GitHub Pages project subpath (username.github.io/repo/). All runtime asset
  // URLs are prefixed with import.meta.env.BASE_URL (see src/base.ts).
  base: "./",
  server: { port: 5173, host: true },
  clearScreen: false,
});
