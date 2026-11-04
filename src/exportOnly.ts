import { html as trHtml, msg as trMsg, t as tr } from "./i18n";
// The closedown screen: what an Online Farm player sees while the service is in
// `export_only`, after their farm has loaded read-only from the server.
//
// It replaces entering the game. The farm is already hydrated behind it — that is
// exactly what makes the export possible, since an Online Farm keeps no full save
// blob on the device — but no gameplay runs and nothing is written back, because
// every mutation route is refused server-side in this mode.
//
// The screen never resolves. Each button ends in a download or a reload, so main()
// stops here by design rather than falling through into the game loop.

export interface ExportOnlyActions {
  /** Operator-authored line from the server, if any. */
  notice: string | null;
  /** When the farm on screen came from this device's cached snapshot rather than the
   *  server (bootstrap failed), the timestamp it was cached at. Null on a live load. */
  cachedFrom?: number | null;
  /** Re-attempt an authoritative load. True once the server's own farm is in hand. */
  retryAuthoritative?: () => Promise<boolean>;
  /** Serialise the loaded farm; null when it could not be produced. */
  exportRaw: () => Promise<string | null>;
  /** Save the blob to the player's downloads — the same plain SaveGame file Local
   *  Farm's own Export writes, and the only thing Local Farm's Import reads. */
  download: (raw: string) => void;
  /** Leave for Local Farm. */
  openLocal: () => void;
}

const STYLE = `
.zf-export-gate { position: fixed; inset: 0; z-index: 100000; display: flex;
  align-items: center; justify-content: center; padding: 24px; overflow: auto;
  background: radial-gradient(120% 120% at 50% 0%, #234012 0%, #12220a 60%, #0a1406 100%);
  font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
.zf-export-card { width: min(480px, 94vw); color: #eaffd8; text-align: center;
  background: linear-gradient(#2a3f14, #1c2c0d); border: 2px solid #0c1505;
  border-radius: 18px; padding: 28px 26px; box-shadow: 0 18px 50px rgba(0,0,0,.5); }
.zf-export-card h1 { font-size: 26px; font-weight: 900; margin: 0 0 8px;
  color: #b6f36a; text-shadow: 0 2px 0 #14240a; }
.zf-export-card p { font-size: 14px; line-height: 1.55; color: #c9e6a8; margin: 0 0 18px; }
.zf-export-action { width: 100%; padding: 13px; margin-bottom: 10px; border-radius: 10px;
  border: 2px solid #14240a; cursor: pointer; color: #12240a;
  font: 800 15px system-ui, sans-serif; background: linear-gradient(#9be25a, #6fb030); }
.zf-export-action.secondary { color: #eaffd8; background: #1b2b0c; border-color: #3d5a20; }
.zf-export-action:hover:not(:disabled) { filter: brightness(1.08); }
.zf-export-action:disabled { opacity: .5; cursor: default; filter: none; }
.zf-export-hint { font-size: 12px; color: #90ad6e; margin: 14px 0 0; }
.zf-export-stale { margin: 0 0 16px; padding: 12px 14px; border-radius: 10px;
  border: 1px solid #6d5a1e; background: #2c2a10; text-align: left; }
.zf-export-stale-text { font-size: 13px; line-height: 1.5; color: #ffe6a0; margin: 0 0 10px; }
.zf-export-stale .zf-export-action { margin-bottom: 0; }
.zf-export-status { min-height: 18px; margin-top: 12px; font-size: 13px; color: #ffe6a0; }
.zf-export-status.bad { color: #ffb0a0; }
`;

let styled = false;
function injectStyle() {
  if (styled) return;
  const s = document.createElement("style");
  s.textContent = tr(STYLE);
  document.head.appendChild(s);
  styled = true;
}

export function showExportOnly(actions: ExportOnlyActions): Promise<never> {
  injectStyle();
  const root = document.createElement("div");
  root.className = "zf-export-gate";
  root.innerHTML = trHtml`
    <main class="zf-export-card" aria-labelledby="zf-export-title">
      <h1 id="zf-export-title">Export Your Online Farm</h1>
      <p class="zf-export-intro"></p>
      <div class="zf-export-stale" hidden>
        <p class="zf-export-stale-text"></p>
        <button class="zf-export-action secondary" data-action="retry">Try Again</button>
      </div>
      <button class="zf-export-action" data-action="download">Export My Farm</button>
      <button class="zf-export-action secondary" data-action="local">Open Local Farm</button>
      <div class="zf-export-status" role="status"></div>
      <p class="zf-export-hint">Your online farm stays on your account. The file downloads to
        this device — open Local Farm, then Settings → Import to play it offline and keep
        getting game updates.</p>
    </main>`;
  document.body.appendChild(root);

  const intro = root.querySelector<HTMLElement>(".zf-export-intro")!;
  intro.textContent = tr(actions.notice
    ?? trMsg`Online Farm is closed while we prepare the full release. Download a copy of your farm and you can carry on playing it in Local Farm.`);

  // Warn BEFORE they export, not after. An export taken from the cached snapshot can be
  // missing recent progress, and the player is about to treat it as their whole farm.
  const stale = root.querySelector<HTMLElement>(".zf-export-stale")!;
  const staleText = root.querySelector<HTMLElement>(".zf-export-stale-text")!;
  let cachedFrom = actions.cachedFrom ?? null;
  const renderStale = () => {
    stale.hidden = cachedFrom === null;
    if (cachedFrom === null) return;
    staleText.textContent =
      trMsg`We couldn't reach the server, so this is the copy saved on this device on ${new Date(cachedFrom).toLocaleString()}. Anything you did after that is not in it. Your online farm is safe either way — try again for the up-to-date one.`;
  };
  renderStale();

  const buttons = [...root.querySelectorAll<HTMLButtonElement>("[data-action]")];
  const status = root.querySelector<HTMLElement>(".zf-export-status")!;
  const setStatus = (text: string, bad = false) => {
    status.textContent = tr(text);
    status.classList.toggle("bad", bad);
  };
  const setBusy = (busy: boolean) => buttons.forEach((b) => { b.disabled = busy; });

  const withRaw = async (label: string, use: (raw: string) => void) => {
    setBusy(true);
    setStatus(label);
    const raw = await actions.exportRaw().catch(() => null);
    if (!raw) {
      setBusy(false);
      setStatus("Your farm could not be prepared. Check your connection and try again.", true);
      return;
    }
    use(raw);
  };

  return new Promise<never>(() => {
    root.querySelector<HTMLButtonElement>('[data-action="retry"]')!.onclick = () => {
      void (async () => {
        setBusy(true);
        setStatus("Reaching the server…");
        const recovered = await actions.retryAuthoritative?.().catch(() => false);
        setBusy(false);
        if (recovered) {
          cachedFrom = null;
          renderStale();
          setStatus("Got your up-to-date farm.");
          return;
        }
        setStatus("Still can't reach the server. The copy on this device is still here.", true);
      })();
    };

    root.querySelector<HTMLButtonElement>('[data-action="download"]')!.onclick = () =>
      void withRaw("Preparing your download…", (raw) => {
        actions.download(raw);
        setBusy(false);
        setStatus("Farm exported. Open Local Farm, then use Settings → Import to load it.");
      });

    root.querySelector<HTMLButtonElement>('[data-action="local"]')!.onclick = () => {
      setBusy(true);
      setStatus("Opening Local Farm…");
      actions.openLocal();
    };
  });
}
