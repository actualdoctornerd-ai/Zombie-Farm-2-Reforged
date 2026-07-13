import { defineConfig } from "vite";

export default defineConfig({
  // Relative base so the built app works both at a domain root and under a
  // GitHub Pages project subpath (username.github.io/repo/). All runtime asset
  // URLs are prefixed with import.meta.env.BASE_URL (see src/base.ts).
  base: "./",
  // Honour a harness-assigned PORT (autoPort) so multiple sessions don't collide on
  // 5173; fall back to 5173 for a plain `npm run dev`.
  server: { port: Number(process.env.PORT) || 5173, host: true },
  clearScreen: false,
});
