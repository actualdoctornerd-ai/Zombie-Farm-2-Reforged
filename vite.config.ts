import { defineConfig, loadEnv, type Plugin } from "vite";

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
    clearScreen: false,
    plugins: [cspPlugin(env.VITE_API_URL)],
  };
});
