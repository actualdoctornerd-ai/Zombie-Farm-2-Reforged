// Boot / start-screen animation. Kept as an EXTERNAL classic script (not inline)
// so a strict Content-Security-Policy can allow it via `script-src 'self'` with no
// 'unsafe-inline' and no brittle per-edit hash (see SECURITY.md finding A9). It
// still runs before the app module (classic scripts execute before deferred
// modules), so window.__ZFBoot exists by the time main.ts reports progress.
//
// The static #boot markup in index.html paints on the first frame regardless; this
// only drives the load bar and status text and exposes window.__ZFBoot.
(function () {
  var fill = document.getElementById("bootFill");
  var statusEl = document.getElementById("bootStatus");
  var boot = document.getElementById("boot");
  // The original game's five loading lines (LoadingScreenText.plist).
  var LINES = ["Gathering Zombies…", "Zombies Taking a Bath…",
    "Zombies Getting Dressed…", "Zombies Marching…", "Zombies Going to Work…"];
  var li = 0, cur = 0, tgt = 0.12, phase = "load", auto = true;

  // Cycle the status line while loading.
  var cycle = setInterval(function () {
    if (phase === "load" || phase === "readywait") {
      li = (li + 1) % LINES.length; statusEl.textContent = LINES[li];
    }
  }, 1500);
  // Creep the bar forward on its own until main.ts starts reporting real
  // milestones — keeps it alive during the bundle download.
  var creep = setInterval(function () {
    if (auto && tgt < 0.62) tgt += 0.05;
  }, 340);

  function frame() {
    cur += (tgt - cur) * 0.09;
    if (cur > 0.999) cur = 1;
    fill.style.width = (cur * 100).toFixed(1) + "%";
    if (phase === "readywait" && cur >= 0.985) enterReady();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  function enterReady() {
    phase = "ready";
    clearInterval(cycle);
    statusEl.textContent = "Click to Start";
    statusEl.classList.add("ready");
  }
  function dismiss() {
    if (phase !== "ready") return;
    phase = "done";
    boot.classList.add("hidden");
    setTimeout(function () { if (boot.parentNode) boot.parentNode.removeChild(boot); }, 650);
  }
  boot.addEventListener("click", dismiss);

  window.__ZFBoot = {
    // Report a real load milestone (0..1); stops the auto-creep.
    progress: function (p) { auto = false; clearInterval(creep); if (p > tgt) tgt = p; },
    // Boot finished building the game: fill to 100%, then flip to "Click to Start".
    ready: function () { auto = false; clearInterval(creep); tgt = 1;
      if (phase === "load") phase = "readywait"; },
    // Bail out (fatal error): tear the overlay down so the error is visible.
    fail: function () { clearInterval(cycle); clearInterval(creep);
      if (boot.parentNode) boot.parentNode.removeChild(boot); }
  };
})();
