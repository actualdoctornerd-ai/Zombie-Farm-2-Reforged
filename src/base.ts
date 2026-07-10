// The URL prefix the app is served from. Vite injects this at build time:
// "/" during local dev, and (with base:"./" in vite.config) "./" for a static
// deploy, so the same bundle works whether it's served from a domain root or a
// GitHub Pages project subpath (username.github.io/repo/). Every runtime asset
// URL is built from this so nothing is hardcoded to the site root.
export const BASE = import.meta.env.BASE_URL;
