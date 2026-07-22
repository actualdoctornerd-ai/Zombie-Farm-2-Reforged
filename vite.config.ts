import { defineConfig, loadEnv, type Plugin } from "vite";
import { VitePWA } from "vite-plugin-pwa";

/** Inject a restrictive Content-Security-Policy <meta> into the built index.html.
 *  BUILD ONLY: applied via `apply: "build"` so it never touches the dev server,
 *  where Vite's HMR client needs inline scripts/eval that a strict CSP would block.
 *
 *  GitHub Pages can't send HTTP headers, so the policy rides in a <meta> tag. It
 *  allowlists only what the app actually needs: same-origin code/assets plus the
 *  Google Sign-In origins and the configured Worker API (connect-src). The boot
 *  script is external (public/boot.js) and the app sets DOM .onclick handlers (not
 *  inline HTML handlers), so no 'unsafe-inline' is needed for scripts. Styles keep
 *  'unsafe-inline' (the app and GIS inject <style>/inline styles — low risk). */
function cspPlugin(apiUrl: string): Plugin {
  const api = apiUrl?.replace(/\/$/, "") ?? "";
  const csp = [
    `default-src 'self'`,
    `base-uri 'self'`,
    `object-src 'none'`,
    `script-src 'self' https://accounts.google.com https://www.gstatic.com`,
    `style-src 'self' 'unsafe-inline' https://accounts.google.com`,
    `img-src 'self' data: https:`,
    `font-src 'self' data:`,
    `connect-src 'self' https://accounts.google.com${api ? ` ${api}` : ""}`,
    `frame-src https://accounts.google.com`,
    `worker-src 'self' blob:`,
    `form-action 'self'`,
  ].join("; ");
  return {
    name: "inject-csp",
    apply: "build",
    transformIndexHtml(html) {
      return html.replace(
        /<head>/,
        `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`
      );
    },
  };
}

export default defineConfig(({ mode }) => {
  // Read VITE_* so the CSP's connect-src can allowlist the exact API origin.
  const env = loadEnv(mode, process.cwd(), "");
  return {
    // Relative base so the built app works both at a domain root and under a
    // GitHub Pages project subpath (username.github.io/repo/). All runtime asset
    // URLs are prefixed with import.meta.env.BASE_URL (see src/base.ts).
    base: "./",
    // Honour a harness-assigned PORT (autoPort) so multiple sessions don't collide on
    // 5173; fall back to 5173 for a plain `npm run dev`.
    server: { port: Number(process.env.PORT) || 5173, host: true },
    // `vite preview` (serves the built dist, incl. the PWA service worker which is
    // disabled in dev) — honour the harness-assigned PORT like the dev server.
    preview: { port: Number(process.env.PORT) || 4173, host: true },
    clearScreen: false,
    plugins: [
      cspPlugin(env.VITE_API_URL),
      // PWA service worker (build-only) for offline-tolerant caching + auto-update.
      // Deliberately NOT a full-offline precache: the dist is ~88MB (64MB of it is
      // epic-boss art), so precaching everything would be a brutal install. Instead
      // we precache only the app shell (JS/CSS/HTML + boot + icons + boot art) and
      // runtime cache-first the big art/audio so each asset caches on first view.
      VitePWA({
        registerType: "prompt", // show a "new version" toast; never auto-reload (bad mid-raid)
        injectRegister: false, // we register manually in src/pwa.ts — the CSP forbids inline scripts
        manifest: false, // we already ship public/manifest.webmanifest + <head> tags
        includeAssets: [],
        // Inline the Workbox runtime into sw.js (one same-origin file, no importScripts)
        // so nothing trips the strict CSP under the GitHub Pages subpath.
        workbox: {
          inlineWorkboxRuntime: true,
          globPatterns: [
            "**/*.{js,css,html}",
            "boot.js",
            "manifest.webmanifest",
            "icons/*.png",
            "assets/title/*.png", // boot/splash art so the first offline launch still paints
          ],
          maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
          navigateFallback: "index.html",
          cleanupOutdatedCaches: true,
          runtimeCaching: [
            {
              // Game art (crops, zombies, objects, raids, the 64MB of epic bosses):
              // stable filenames, rarely change -> CacheFirst for instant offline loads.
              urlPattern: ({ url, sameOrigin }) =>
                sameOrigin && /\/assets\/.*\.(png|jpe?g|webp|gif|svg|json)$/i.test(url.pathname),
              handler: "CacheFirst",
              options: {
                cacheName: "zf-art",
                expiration: { maxEntries: 2000, maxAgeSeconds: 60 * 60 * 24 * 60 },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
            {
              urlPattern: ({ url, sameOrigin }) =>
                sameOrigin && /\/assets\/.*\.(mp3|ogg|wav|m4a)$/i.test(url.pathname),
              handler: "CacheFirst",
              options: {
                cacheName: "zf-audio",
                rangeRequests: true,
                expiration: { maxEntries: 100, maxAgeSeconds: 60 * 60 * 24 * 60 },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
          ],
          // The Worker API and Google Sign-In are cross-origin, so the same-origin
          // runtime rules above never touch them — they always hit the network.
        },
        devOptions: { enabled: false }, // no SW in dev (matches the build-only CSP)
      }),
    ],
  };
});
