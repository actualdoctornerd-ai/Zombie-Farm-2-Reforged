/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the game server API (Cloudflare Worker). Unset = offline-only:
   *  the whole online layer no-ops and the game runs purely on localStorage. */
  readonly VITE_API_URL?: string;
  /** Google OAuth 2.0 Web client id for Sign-in with Google. */
  readonly VITE_GOOGLE_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
