// Turn the prod grid's shards into one colour-coded page.
//
// Same visual language as tools/strength_page.mjs, different question. There the columns
// are a fitted strength band and the parties are generated; here the columns are PLAYER
// LEVEL and every party is one a real account actually deployed, pulled out of
// raid_sessions_v3.roster_json with its species, per-unit mutation mask, per-unit
// veterancy and deploy order intact.
//
// Nobody retreats in these flights, which is the whole point — see prodGrid.ts.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const DIR = "tmp/prodgrid";
const rows = readdirSync(DIR)
  .filter((f) => f.endsWith(".json") && f.startsWith("shard"))
  .flatMap((f) => JSON.parse(readFileSync(`${DIR}/${f}`, "utf8")));

if (!rows.length) {
  console.error(`no shard JSON in ${DIR} — run the sweep first`);
  process.exit(1);
}

const PILOTS = [...new Set(rows.map((r) => r.pilot))].sort((a, b) =>
  (a === "competent" ? 0 : 1) - (b === "competent" ? 0 : 1));
const PILOT_NOTE = {
  competent: "Played properly. Every bubble, every hazard, the placard answered, Explode held back.",
  expert: "The ceiling a human can plausibly reach, still bounded by reaction time and the 512-input transcript cap. A fight that costs casualties here costs them to anybody.",
};

const COLUMNS = rows[0].cells.map((c) => c.level);

// OPTIONAL BASELINE. `node tools/prod_grid_page.mjs <dir>` reads a second set of shards and
// prints each cell's old win rate and losses beside the new ones, so a re-tune can be read
// as a diff. Cells that moved less than DELTA_MIN points show no "was" line.
const BASE_DIR = process.argv[2];
const DELTA_MIN = 3;
const baseline = new Map();
if (BASE_DIR) {
  for (const f of readdirSync(BASE_DIR).filter((f) => f.endsWith(".json") && f.startsWith("shard"))) {
    for (const r of JSON.parse(readFileSync(`${BASE_DIR}/${f}`, "utf8"))) baseline.set(`${r.pilot}|${r.label}`, r);
  }
}
const byPilot = {};
for (const pilot of PILOTS) {
  byPilot[pilot] = rows
    .filter((r) => r.pilot === pilot)
    .sort((a, b) => b.rowLevel - a.rowLevel || a.raidId - b.raidId || (b.tier ?? 0) - (a.tier ?? 0) || Number(a.elite) - Number(b.elite))
    .map((r) => { const base = baseline.get(`${r.pilot}|${r.label}`); return {
      label: r.label,
      rowLevel: r.rowLevel,
      elite: r.elite || /t10$/.test(r.label),
      dual: r.raidId >= 12,
      cells: r.cells.map((c) => { const bc = base?.cells.find((x) => x.level === c.level); return [
        Math.round(c.winRate * 1000) / 10,
        Math.round(c.meanLosses * 100) / 100,
        Math.round(c.losslessRate * 1000) / 10,
        Math.round(c.meanLossFrac * 1000) / 10,
        Math.round(c.wipeRate * 1000) / 10,
        Math.round(c.timeoutRate * 1000) / 10,
        c.medianWinSecs === null ? null : Math.round(c.medianWinSecs),
        Math.round(c.deadlockRate * 1000) / 10,
        c.hist ?? [],
        bc ? Math.round(bc.winRate * 1000) / 10 : null,
        bc ? Math.round(bc.meanLosses * 100) / 100 : null,
      ]; }),
    }; });
}

const totalFlights = rows.reduce((a, r) => a + r.cells.reduce((b, c) => b + c.flights, 0), 0);
const armiesPerCell = rows[0].cells.map((c) => c.armies);
const data = {
  columns: COLUMNS,
  pilots: PILOTS,
  notes: PILOT_NOTE,
  byPilot,
  flights: totalFlights,
  fights: rows.length / PILOTS.length,
  armies: armiesPerCell,
  baseline: BASE_DIR ? true : false,
  deltaMin: DELTA_MIN,
};

const html = `<!doctype html>
<html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Prod Army Difficulty Grid</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Chivo:wght@400;600;900&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body { margin: 0; }
  :root {
    --surface: #faf9f2; --surface-sunk: #f0efe4; --surface-raised: #fffffb;
    --rule: #dddbcb; --rule-strong: #b9b6a2;
    --ink: #1b1b12; --ink-2: #4e4c3f; --ink-3: #7a7768;
    --ui: #3a4a6b; --ui-soft: #e4e8f2;
    --w0:#a5322f; --w17:#c0413d; --w34:#d4763f; --w50:#d9a12f;
    --w67:#b4ae2b; --w84:#6fa321; --w100:#128f15;
    --void: #e8e6da; --halo: rgb(255 255 255 / 0.92);
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --surface:#17170f; --surface-sunk:#111109; --surface-raised:#1f1f16;
      --rule:#33322a; --rule-strong:#4c4b3f;
      --ink:#f3f1e6; --ink-2:#b4b1a0; --ink-3:#817e6f;
      --ui:#9aa8c8; --ui-soft:#262a35;
      --w0:#c0413d; --w17:#d64f49; --w34:#e8814a; --w50:#f0b03c;
      --w67:#cfc434; --w84:#85bd28; --w100:#18ac1a;
      --void:#232219; --halo: rgb(10 10 6 / 0.85);
    }
  }
  :root[data-theme="dark"] {
    --surface:#17170f; --surface-sunk:#111109; --surface-raised:#1f1f16;
    --rule:#33322a; --rule-strong:#4c4b3f;
    --ink:#f3f1e6; --ink-2:#b4b1a0; --ink-3:#817e6f;
    --ui:#9aa8c8; --ui-soft:#262a35;
    --w0:#c0413d; --w17:#d64f49; --w34:#e8814a; --w50:#f0b03c;
    --w67:#cfc434; --w84:#85bd28; --w100:#18ac1a;
    --void:#232219; --halo: rgb(10 10 6 / 0.85);
  }
  body { background: var(--surface); color: var(--ink);
         font-family: Chivo, "Helvetica Neue", Arial, sans-serif; font-size: 15px; line-height: 1.5; }
  .wrap { max-width: 1180px; margin: 0 auto; padding-inline: 20px; padding-block: 36px 64px; }
  header { border-bottom: 2px solid var(--rule-strong); padding-bottom: 20px; margin-bottom: 24px; }
  h1 { font-weight: 900; font-size: clamp(28px, 5vw, 42px); line-height: 1.05;
       letter-spacing: -0.02em; margin: 0 0 8px; text-wrap: balance; }
  .sub { color: var(--ink-2); max-width: 70ch; margin: 0; }
  .meta { font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 12px;
          color: var(--ink-3); margin-top: 14px; display: flex; flex-wrap: wrap; gap: 6px 20px; }
  .controls { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-start;
              justify-content: space-between; margin-bottom: 8px; }
  .seg { display: flex; flex-wrap: wrap; gap: 4px; background: var(--surface-sunk);
         border: 1px solid var(--rule); border-radius: 3px; padding: 4px; }
  .seg button { font: 600 13px/1 Chivo, sans-serif; letter-spacing: 0.04em; text-transform: uppercase;
                background: none; border: 0; color: var(--ink-2); padding: 8px 14px;
                border-radius: 2px; cursor: pointer; }
  .seg button:hover { color: var(--ink); background: var(--ui-soft); }
  .seg button[aria-pressed="true"] { background: var(--ui); color: var(--surface); }
  .seg button:focus-visible { outline: 2px solid var(--ui); outline-offset: 2px; }
  .legend { font-family: "IBM Plex Mono", monospace; font-size: 11px; color: var(--ink-2); }
  .ramp { display: flex; height: 12px; width: 220px; border: 1px solid var(--rule-strong); }
  .ramp span { flex: 1; }
  .legend .ends { display: flex; justify-content: space-between; margin-top: 4px; }
  .pilotnote { font-size: 14px; color: var(--ink-2); margin: 0 0 18px; max-width: 74ch;
               border-left: 3px solid var(--ui); padding-left: 12px; }
  .scroller { overflow-x: auto; border: 1px solid var(--rule); background: var(--surface-raised); }
  table { border-collapse: separate; border-spacing: 0; width: 100%; font-variant-numeric: tabular-nums; }
  th, td { padding: 0; }
  thead th { position: sticky; top: 0; z-index: 3; background: var(--surface-raised);
             border-bottom: 2px solid var(--rule-strong);
             font: 600 11px/1.3 "IBM Plex Mono", monospace; color: var(--ink-2);
             text-align: center; padding: 10px 6px; white-space: nowrap; }
  thead th.corner { z-index: 4; left: 0; text-align: left; padding-left: 12px; min-width: 250px; }
  thead th .band { display: block; font-size: 15px; color: var(--ink); font-weight: 600; }
  thead th .wasband { display: block; font-size: 10px; color: var(--ink-3); font-weight: 400; }
  tbody th { position: sticky; left: 0; z-index: 2; background: var(--surface-raised);
             text-align: left; font: 400 13px/1.25 Chivo, sans-serif; color: var(--ink);
             padding: 7px 12px; border-right: 1px solid var(--rule-strong);
             border-bottom: 1px solid var(--rule); white-space: nowrap; min-width: 250px; }
  tbody th .lv { font-family: "IBM Plex Mono", monospace; font-size: 11px; color: var(--ink-3);
                 display: inline-block; min-width: 26px; }
  tbody th .star { color: var(--w50); font-weight: 600; }
  tbody th .dual { color: var(--ui); font-weight: 600; }
  tbody tr.era-break th, tbody tr.era-break td { border-top: 2px solid var(--rule-strong); }
  td.cell { border-bottom: 1px solid var(--rule); border-right: 1px solid var(--rule);
            text-align: center; min-width: 86px; cursor: default; }
  td.cell .win { display: block; font: 600 14px/1.1 "IBM Plex Mono", monospace; padding-top: 6px; }
  td.cell .loss { display: block; font: 400 10px/1.4 "IBM Plex Mono", monospace;
                  padding-bottom: 6px; opacity: 0.85; }
  td.cell .was { display: block; font: 400 9.5px/1.2 "IBM Plex Mono", monospace;
                 padding-bottom: 5px; margin-top: -3px; opacity: 0.8; }
  td.cell { position: relative; cursor: pointer; }
  td.cell:hover { outline: 2px solid var(--ink); outline-offset: -2px; }
  td.cell[aria-pressed="true"] { outline: 3px solid var(--ink); outline-offset: -3px; }
  /* At least one flight in this cell was won with NOBODY LOST. The mean can sit at 2.0
     and still contain clean clears; this says the fight is answerable, not just winnable. */
  td.cell .clean { position: absolute; top: 1px; right: 3px; font-size: 11px; line-height: 1;
                   opacity: 0.95; pointer-events: none; }

  .histwrap { margin-top: 18px; border: 1px solid var(--rule); background: var(--surface-raised);
              border-radius: 3px; padding: 16px 18px; }
  .histwrap.empty { color: var(--ink-3); font-size: 14px; }
  .histwrap h3 { margin: 0 0 2px; font-size: 16px; font-weight: 600; }
  .histwrap .hsub { margin: 0 0 12px; font-family: "IBM Plex Mono", monospace;
                    font-size: 11.5px; color: var(--ink-3); }
  .histwrap .keys { display: flex; gap: 18px; font-size: 12.5px; color: var(--ink-2);
                    margin-bottom: 10px; }
  .histwrap .keys span { display: inline-flex; align-items: center; gap: 6px; }
  .histwrap .sw { width: 12px; height: 12px; border-radius: 2px; }
  .histwrap svg { display: block; width: 100%; height: auto; }
  .histwrap text { font-family: "IBM Plex Mono", monospace; fill: var(--ink-3); }
  #tip { position: fixed; z-index: 20; pointer-events: none; max-width: 290px;
         background: var(--surface-raised); color: var(--ink);
         border: 1px solid var(--rule-strong); border-radius: 3px; padding: 10px 12px;
         font-size: 12.5px; line-height: 1.45; box-shadow: 0 6px 24px rgb(0 0 0 / 0.18); }
  #tip strong { display: block; font-size: 13.5px; margin-bottom: 4px; }
  #tip dl { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; margin: 6px 0 0;
            font-family: "IBM Plex Mono", monospace; font-size: 11.5px; }
  #tip dt { color: var(--ink-3); } #tip dd { margin: 0; text-align: right; }
  .notes { margin-top: 36px; display: grid; gap: 22px;
           grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
  .notes h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em;
              color: var(--ink-3); margin: 0 0 6px; font-weight: 600; }
  .notes p { margin: 0 0 8px; color: var(--ink-2); font-size: 14px; }
  .notes strong { color: var(--ink); font-weight: 600; }
  code { font-family: "IBM Plex Mono", monospace; font-size: 0.92em;
         background: var(--surface-sunk); padding: 1px 4px; border-radius: 2px; }
  @media (max-width: 640px) {
    thead th.corner, tbody th { min-width: 180px; white-space: normal; }
    td.cell { min-width: 74px; }
  }
</style>

<div class="wrap">
  <header>
    <h1>Prod Army Difficulty Grid</h1>
    <p class="sub">Every invasion flown by parties <strong>real accounts actually deployed</strong> &mdash;
      species, per-unit mutations, veterancy and deploy order taken straight from settled invasions &mdash;
      with <strong>nobody retreating</strong>. Columns are the player level the army was pulled from.
      Each cell is a win rate and the average number of zombies that did not come home.</p>
    <div class="meta">
      <span id="m-flights"></span>
      <span id="m-fights"></span>
      <span id="m-armies"></span>
      <span>3 wave seeds per army</span>
      <span>no retreat</span>
    </div>
    ${BASE_DIR ? `<p class="sub" style="margin-top:12px"><strong>Re-tune preview.</strong> ${process.env.PRODGRID_NOTE ?? ""}
      A small <em>was</em> line under a cell gives its win rate before the change (shown when it moved
      ${DELTA_MIN}+ points); hover for the old losses too.</p>` : ""}
  </header>

  <div class="controls">
    <div class="seg" role="group" aria-label="Level of play" id="seg"></div>
    <div class="legend">
      <div class="ramp" aria-hidden="true">
        <span style="background:var(--w0)"></span><span style="background:var(--w17)"></span>
        <span style="background:var(--w34)"></span><span style="background:var(--w50)"></span>
        <span style="background:var(--w67)"></span><span style="background:var(--w84)"></span>
        <span style="background:var(--w100)"></span>
      </div>
      <div class="ends"><span>0% win</span><span>100% win</span></div>
    </div>
  </div>
  <p class="pilotnote" id="pilotnote"></p>

  <div class="scroller">
    <table>
      <thead><tr id="head"></tr></thead>
      <tbody id="body"></tbody>
    </table>
  </div>

  <div class="histwrap empty" id="hist">Click any cell for the spread of casualties behind its average.</div>

  <div class="notes">
    <div>
      <h2>What a row is</h2>
      <p>The number on the left is the level at which the row becomes content. A base invasion sits at
        its own unlock level; an <span class="star">&#9733;</span> elite one sits at
        <code>clamp(unlock + 10, 20, 44)</code> &mdash; Brain Tickets unlock at 20, so no elite fight is
        content before then. Rows run hardest first.</p>
      <p>The four <span class="dual">dual invasions</span> have a ten-rung ladder rather than a ticket, so
        they contribute their two ends (t1 and t10) instead of a base/elite pair.</p>
    </div>
    <div>
      <h2>Why nobody retreats</h2>
      <p>On the live service a late-game player reads a fight going wrong and bails. A non-win at level 45
        costs <strong>zero zombies 86% of the time</strong> &mdash; so the production casualty rate measures
        how well people retreat, not how dangerous a fight is.</p>
      <p>Every flight here runs to a conclusion. The loss column is the <strong>counterfactual</strong>:
        what the fight would have taken had the player played it out. That is the threat an invasion is
        actually making, and it is the number to tune against.</p>
    </div>
    <div>
      <h2>The parties</h2>
      <p>Drawn from settled invasions where <em>every</em> unit id still resolves against the live roster or
        the graveyard, so no slot is guessed. Deduplicated, and capped at six parties per account so no one
        player owns a column.</p>
      <p>Nothing is composed: the party floor, the duplicate stacking, the half-mutated bench units and the
        order the player tapped them in are all whatever they really were. Army sizes run 8&ndash;20 and the
        median reaches 20 by level 30.</p>
      <p>Hover a cell for the loss-less share, wipe rate, timeout rate and median clear.
        <strong>Click</strong> one for the full spread of casualties behind its average, split by
        whether the fight was won. A <span class="star">&#9733;</span> in a cell's corner means at
        least one flight there was won with <em>nobody lost</em> &mdash; the fight is answerable,
        not merely winnable.</p>
    </div>
  </div>
</div>

<div id="tip" hidden></div>

<script>
const DATA = ${JSON.stringify(data)};
const RAMP = ["--w0","--w17","--w34","--w50","--w67","--w84","--w100"];
const css = getComputedStyle(document.documentElement);
function hexToRgb(h) { const v = h.trim().replace("#","");
  return [parseInt(v.slice(0,2),16), parseInt(v.slice(2,4),16), parseInt(v.slice(4,6),16)]; }
function mix(a,b,t){ return a.map((x,i)=>Math.round(x+(b[i]-x)*t)); }
function fillFor(win){
  const stops = RAMP.map((n)=>hexToRgb(css.getPropertyValue(n)));
  const pos = (win/100)*(stops.length-1);
  const i = Math.min(stops.length-2, Math.floor(pos));
  const rgb = mix(stops[i], stops[i+1], pos-i);
  return { css: "rgb("+rgb.join(",")+")", rgb };
}
function inkOn(rgb){
  const lin = rgb.map((c)=>{const s=c/255; return s<=0.03928? s/12.92 : Math.pow((s+0.055)/1.055,2.4);});
  const L = 0.2126*lin[0]+0.7152*lin[1]+0.0722*lin[2];
  return L > 0.42 ? "#14140d" : "#fbfaf4";
}
const seg=document.getElementById("seg"), head=document.getElementById("head"),
      body=document.getElementById("body"), note=document.getElementById("pilotnote"),
      tip=document.getElementById("tip");
let current = DATA.pilots.includes("expert") ? "expert" : DATA.pilots[0];
let selected = null;
document.getElementById("m-flights").textContent = DATA.flights.toLocaleString()+" flights";
document.getElementById("m-fights").textContent = DATA.fights+" fights";
document.getElementById("m-armies").textContent = DATA.armies[0]+"\\u2013"+Math.max(...DATA.armies)+" real armies per cell";

for (const p of DATA.pilots) {
  const b=document.createElement("button"); b.textContent=p; b.dataset.pilot=p;
  b.onclick=()=>{current=p; render();}; seg.appendChild(b);
}
function render(){
  for (const b of seg.children) b.setAttribute("aria-pressed", String(b.dataset.pilot===current));
  note.textContent = DATA.notes[current] || "";
  head.innerHTML = '<th class="corner">Invasion / <span style="color:var(--ink-3)">player level &rarr;</span></th>'
    + DATA.columns.map((L,i)=>'<th><span class="band">'+L+'</span><span class="wasband">'
        +DATA.armies[i]+' armies</span></th>').join("");
  const rows = DATA.byPilot[current];
  body.innerHTML = rows.map((r,idx)=>{
    const brk = idx>0 && rows[idx-1].rowLevel!==r.rowLevel ? ' class="era-break"' : "";
    const nameCls = r.dual ? "dual" : (r.elite ? "star" : "");
    const cells = r.cells.map((c,ci)=>{
      const [win,loss,lossless,frac,wipe,timeout,secs,dead,hist,wasWin,wasLoss] = c;
      const f = fillFor(win);
      // The star reads against both ends of the ramp, so it takes the cell's own ink.
      const clean = lossless > 0 ? '<span class="clean">\\u2605</span>' : "";
      return '<td class="cell" tabindex="0" aria-pressed="false" style="background:'+f.css+';color:'+inkOn(f.rgb)+'"'
        + ' data-t="'+encodeURIComponent(JSON.stringify({label:r.label,level:DATA.columns[ci],
            win,loss,lossless,frac,wipe,timeout,secs,dead,hist:hist||[],wasWin,wasLoss}))+'">'
        + clean
        + '<span class="win">'+win.toFixed(0)+'%</span>'
        + '<span class="loss">'+loss.toFixed(1)+' lost</span>'
        + (wasWin!==null && wasWin!==undefined && Math.abs(win-wasWin)>=DATA.deltaMin
            ? '<span class="was">was '+wasWin.toFixed(0)+'%</span>' : '')
        + '</td>';
    }).join("");
    return '<tr'+brk+'><th><span class="lv">'+r.rowLevel+'</span> <span class="'+nameCls+'">'
      + r.label+'</span></th>'+cells+'</tr>';
  }).join("");
  // The old cells are detached now, so the selection highlight has nothing to hold on to.
  selected = null;
}
body.addEventListener("mouseover",(e)=>{
  const td=e.target.closest("td.cell"); if(!td) return;
  const d=JSON.parse(decodeURIComponent(td.dataset.t));
  tip.innerHTML = "<strong>"+d.label+"</strong>at player level "+d.level
    + "<dl><dt>win</dt><dd>"+d.win.toFixed(1)+"%</dd>"
    + (d.wasWin!==null&&d.wasWin!==undefined?"<dt>win before</dt><dd>"+d.wasWin.toFixed(1)+"%</dd><dt>lost before</dt><dd>"+d.wasLoss.toFixed(2)+"</dd>":"")
    + "<dt>loss-less</dt><dd>"+d.lossless.toFixed(1)+"%</dd>"
    + "<dt>mean lost</dt><dd>"+d.loss.toFixed(2)+"</dd>"
    + "<dt>as % of party</dt><dd>"+d.frac.toFixed(1)+"%</dd>"
    + "<dt>wiped (&ge;75%)</dt><dd>"+d.wipe.toFixed(1)+"%</dd>"
    + "<dt>timed out</dt><dd>"+d.timeout.toFixed(1)+"%</dd>"
    + (d.dead>0?"<dt>deadlocked</dt><dd>"+d.dead.toFixed(1)+"%</dd>":"")
    + "<dt>median clear</dt><dd>"+(d.secs===null?"\\u2013":d.secs+"s")+"</dd></dl>";
  tip.hidden=false;
});
body.addEventListener("mousemove",(e)=>{
  const x=Math.min(e.clientX+16, innerWidth-tip.offsetWidth-8);
  const y=Math.min(e.clientY+16, innerHeight-tip.offsetHeight-8);
  tip.style.left=x+"px"; tip.style.top=y+"px";
});
body.addEventListener("mouseout",(e)=>{ if(!e.relatedTarget||!e.relatedTarget.closest("td.cell")) tip.hidden=true; });

// ---- the click-through histogram -------------------------------------------------
// The mean in a cell cannot tell "everybody loses two" from "nine in ten lose none and
// the tenth loses eleven", and those are different fights to tune: the second is the
// cascade running. Each bar is one casualty count, split by whether the fight was WON.
const histEl = document.getElementById("hist");
function drawHist(d, td) {
  const hist = d.hist || [];
  if (!hist.length) { histEl.className = "histwrap empty"; histEl.textContent = "No flights in that cell."; return; }
  const total = hist.reduce((a,b)=>a+b[0]+b[1],0);
  const max = Math.max(...hist.map((b)=>b[0]+b[1]));
  const W = 900, H = 260, PADL = 44, PADB = 40, PADT = 12, PADR = 8;
  const plotW = W-PADL-PADR, plotH = H-PADT-PADB;
  const bw = plotW / hist.length;
  const y = (v)=> PADT + plotH - (v/max)*plotH;
  // Gridlines at a round step, so the eye can read a count off the chart.
  const step = Math.max(1, Math.pow(10, Math.floor(Math.log10(max)))*(max/Math.pow(10,Math.floor(Math.log10(max)))>=5?1:0.5));
  let grid = "";
  for (let g=0; g<=max; g+=step) grid += '<line x1="'+PADL+'" x2="'+(W-PADR)+'" y1="'+y(g)+'" y2="'+y(g)
    +'" stroke="currentColor" stroke-opacity="0.12"/><text x="'+(PADL-7)+'" y="'+(y(g)+4)+'" text-anchor="end" font-size="11">'+g+'</text>';
  const bars = hist.map((b,i)=>{
    const [won,lost] = b, tot = won+lost;
    if (!tot) return "";
    const x = PADL + i*bw + Math.min(3, bw*0.12);
    const w = bw - 2*Math.min(3, bw*0.12);
    const hWon = (won/max)*plotH, hLost = (lost/max)*plotH;
    // Wins sit on the baseline, losses stack above them, so the green band is the part
    // of the distribution you are trying to grow.
    return '<rect x="'+x+'" y="'+(PADT+plotH-hWon)+'" width="'+w+'" height="'+hWon+'" fill="var(--w100)"><title>'
      + won+' won with '+i+' lost</title></rect>'
      + '<rect x="'+x+'" y="'+(PADT+plotH-hWon-hLost)+'" width="'+w+'" height="'+hLost+'" fill="var(--w0)"><title>'
      + lost+' lost the fight with '+i+' dead</title></rect>';
  }).join("");
  const ticks = hist.map((b,i)=> (hist.length<=14 || i%2===0)
    ? '<text x="'+(PADL+i*bw+bw/2)+'" y="'+(H-PADB+16)+'" text-anchor="middle" font-size="11">'+i+'</text>' : "").join("");
  histEl.className = "histwrap";
  histEl.innerHTML = '<h3>'+d.label+' &mdash; player level '+d.level+'</h3>'
    + '<p class="hsub">'+total+' flights &middot; '+d.win.toFixed(1)+'% won &middot; '
    + d.lossless.toFixed(1)+'% won with nobody lost &middot; mean '+d.loss.toFixed(2)+' lost'
    + (d.dead>0 ? ' &middot; '+d.dead.toFixed(1)+'% DEADLOCKED' : '')+'</p>'
    + '<div class="keys"><span><i class="sw" style="background:var(--w100)"></i>won</span>'
    + '<span><i class="sw" style="background:var(--w0)"></i>lost</span></div>'
    + '<svg viewBox="0 0 '+W+' '+H+'" role="img" aria-label="casualties per flight">'
    + grid + bars + ticks
    + '<line x1="'+PADL+'" x2="'+(W-PADR)+'" y1="'+(PADT+plotH)+'" y2="'+(PADT+plotH)+'" stroke="currentColor" stroke-opacity="0.35"/>'
    + '<text x="'+(PADL+plotW/2)+'" y="'+(H-4)+'" text-anchor="middle" font-size="11.5">zombies lost in the flight</text>'
    + '</svg>';
  if (selected) selected.setAttribute("aria-pressed","false");
  selected = td; td.setAttribute("aria-pressed","true");
  histEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
}
function pick(e) {
  const td = e.target.closest("td.cell"); if (!td) return;
  drawHist(JSON.parse(decodeURIComponent(td.dataset.t)), td);
}
body.addEventListener("click", pick);
body.addEventListener("keydown",(e)=>{ if (e.key==="Enter"||e.key===" ") { e.preventDefault(); pick(e); } });
render();
</script>
</html>`;

writeFileSync("tmp/prod_grid.html", html);
console.log(`wrote tmp/prod_grid.html — ${totalFlights.toLocaleString()} flights, ${rows.length / PILOTS.length} fights x ${COLUMNS.length} columns x ${PILOTS.length} pilots`);
