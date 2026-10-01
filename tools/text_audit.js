/* Text overflow audit for the in-game UI.
 *
 * Finds text that is cut off ("…" or hard-clipped), pokes out of a clipping parent,
 * runs off the screen, or has shrunk below a readable size. Text inside a container
 * that scrolls sideways (the Market tab strip, the raid list) is NOT flagged: it is
 * reachable by scrolling.
 *
 * It runs inside the live game page — there is no headless browser in this repo — so
 * the workflow is:
 *   1. npm run dev -- --mode offline, open the game, click through to the farm.
 *   2. Emulate the screen size you want to check (browser pane: 390x844, 360x740,
 *      320x640, 812x375, 768x1024, 1280x720).
 *   3. Paste this file into the page console (or run it with the browser tool's
 *      javascript_exec), then:
 *        __textAudit()                 // whatever is on screen right now
 *        await __textAuditPanels()     // open every panel and each of its tabs
 *      Pass a list of Hud method names to limit it: __textAuditPanels(["openMarket"]).
 *   Each finding is { panel, text, where, issues }; an empty result is "clean".
 *
 * Skip the tutorial first (its Skip button): while it runs the HUD refuses to close
 * panels, so a second panel would be audited on top of the first.
 */
(() => {
  const SCROLL = /(auto|scroll)/;
  const CLIP = /(hidden|clip)/;

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const c = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && c.visibility !== "hidden" && c.display !== "none" && c.opacity !== "0";
  };
  const path = (el) => {
    const parts = [];
    for (let e = el; e && e !== document.body && parts.length < 4; e = e.parentElement) {
      const cls = typeof e.className === "string" && e.className.trim()
        ? "." + e.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
      parts.push(e.tagName.toLowerCase() + cls);
    }
    return parts.join(" < ");
  };
  // Containers that are MEANT to scroll sideways; text inside them is reachable by
  // scrolling. Anything else that scrolls sideways is reported as a finding itself.
  const SIDE_SCROLL_OK = ".mkt-tabs, .set-tabs, .st-tabs, .raid-list, .quest-tabs";
  const inScroller = (el, axis) => {
    for (let e = el.parentElement; e; e = e.parentElement) {
      const c = getComputedStyle(e);
      if (axis === "x") {
        if (SCROLL.test(c.overflowX) && e.scrollWidth > e.clientWidth + 1 && e.matches(SIDE_SCROLL_OK)) return true;
      } else if (SCROLL.test(c.overflowY) && e.scrollHeight > e.clientHeight + 1) return true;
    }
    return false;
  };
  const clipAncestor = (el) => {
    for (let e = el.parentElement; e; e = e.parentElement) {
      const c = getComputedStyle(e);
      if (CLIP.test(c.overflowX) || CLIP.test(c.overflowY)) return e;
    }
    return null;
  };

  window.__textAudit = (root) => {
    const out = [];
    const vw = innerWidth, vh = innerHeight;
    const walker = document.createTreeWalker(root || document.querySelector("#hud") || document.body, NodeFilter.SHOW_TEXT);
    const seen = new Set();
    for (let n; (n = walker.nextNode());) {
      const text = n.textContent.trim();
      if (!text) continue;
      const el = n.parentElement;
      if (!el || seen.has(el) || !visible(el) || el.closest('[aria-hidden="true"]')) continue;
      seen.add(el);
      const cs = getComputedStyle(el);
      const range = document.createRange();
      range.selectNodeContents(n);
      const tr = range.getBoundingClientRect();
      if (!tr.width) continue;
      const issues = [];
      if (CLIP.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1) {
        issues.push(`clipped-x ${el.scrollWidth}>${el.clientWidth}${cs.textOverflow === "ellipsis" ? " (ellipsis)" : ""}`);
      }
      if (CLIP.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1) {
        issues.push(`clipped-y ${el.scrollHeight}>${el.clientHeight}`);
      }
      if (!inScroller(el, "x")) {
        const ca = clipAncestor(el);
        if (ca) {
          const cr = ca.getBoundingClientRect();
          if (tr.right > cr.right + 1 || tr.left < cr.left - 1) {
            issues.push(`outside-clip-x by ${Math.round(Math.max(tr.right - cr.right, cr.left - tr.left))}px`);
          }
        }
        if (tr.right > vw + 1 || tr.left < -1) {
          issues.push(`off-screen-x ${Math.round(tr.left)}..${Math.round(tr.right)} of ${vw}`);
        }
      }
      if (tr.bottom > vh + 1 && !inScroller(el, "y")) issues.push("off-screen-y");
      if (parseFloat(cs.fontSize) < 9) issues.push(`tiny ${cs.fontSize}`);
      if (issues.length) out.push({ text: text.slice(0, 40), where: path(el), issues });
    }
    // Containers that scroll sideways by accident: something inside is wider than the box.
    const scope = root || document.querySelector("#hud") || document.body;
    for (const el of scope.querySelectorAll("*")) {
      if (!visible(el) || el.matches(SIDE_SCROLL_OK)) continue;
      const c = getComputedStyle(el);
      if (SCROLL.test(c.overflowX) && el.scrollWidth > el.clientWidth + 1) {
        out.push({ text: (el.textContent || "").trim().slice(0, 40), where: path(el),
          issues: [`sideways-scroll ${el.scrollWidth - el.clientWidth}px`] });
      }
    }
    return out;
  };

  const OVERLAYS = ".panelbg, .mkt-bg, .info-bg, .st-bg, .pm-bg, .raid-bg";
  const CLOSERS = ".panelclose, .mkt-close, .info-close, .st-close, .pm-close";
  const TABS = ".mkt-tabs, .set-tabs, .st-tabs";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const closeAll = async () => {
    for (let i = 0; i < 6; i++) {
      const open = [...document.querySelectorAll(OVERLAYS)].filter(visible);
      if (!open.length) return;
      open.forEach((o) => o.querySelector(CLOSERS)?.click());
      await sleep(250);
    }
  };

  const DEFAULT_OPENERS = [
    "openMarket", "openStorage", "openSettings", "openQuestLog", "openRaids", "openPeriodicQuests",
    "openFriends", "openProfiles", "openBlackMarket", "openZombieList",
  ];

  /** Open each panel, audit it and every tab inside it, close it. */
  window.__textAuditPanels = async (openers = DEFAULT_OPENERS) => {
    const findings = [];
    await closeAll();
    for (const name of openers) {
      try {
        window.ZF.hud[name]();
      } catch (e) {
        findings.push({ panel: name, text: "", where: "", issues: [`could not open: ${String(e.message).slice(0, 60)}`] });
        continue;
      }
      await sleep(900);
      const top = [...document.querySelectorAll(OVERLAYS)].filter(visible).pop();
      const tag = (list, label) => list.forEach((f) => findings.push({ panel: `${name}${label}`, ...f }));
      tag(window.__textAudit(top || undefined), "");
      const strip = top && top.querySelector(TABS);
      const tabs = strip ? [...strip.children].filter((b) => b.tagName === "BUTTON" && visible(b)) : [];
      for (const tab of tabs) {
        tab.click();
        await sleep(400);
        tag(window.__textAudit(top), ` [${tab.textContent.trim().slice(0, 18)}]`);
      }
      await closeAll();
    }
    // The same text can show up on several tabs; keep one line per (panel, text, issue).
    const uniq = new Map();
    for (const f of findings) uniq.set(`${f.panel.split(" [")[0]}|${f.text}|${f.issues.join(",")}`, f);
    return [...uniq.values()];
  };
})();
