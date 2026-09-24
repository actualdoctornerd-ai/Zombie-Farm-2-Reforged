// Turn the strength sweep's shards into a single colour-coded page.
//
// The text table (strength_table.mjs) is four tables stacked in a terminal; this is one
// grid you can actually read, with the win rate carried by fill as well as by digits.
// Both are generated from the same JSON, so neither can drift from the measurement.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const DIR = "tmp/strength";
const rows = readdirSync(DIR)
  .filter((f) => f.endsWith(".json") && f.startsWith("shard"))
  .flatMap((f) => JSON.parse(readFileSync(`${DIR}/${f}`, "utf8")));

if (!rows.length) {
  console.error(`no shard JSON in ${DIR} — run the sweep first`);
  process.exit(1);
}

const PILOTS = ["idle", "casual", "competent", "expert"];
const PILOT_NOTE = {
  idle: "No input at all. Every ability unspent, every focus bubble un-popped — the fight the old harness measured.",
  casual: "One eye on it. Brain bubbles, abilities as they light up, no hazards answered.",
  competent: "Played properly. Every bubble, every hazard, the placard answered, Explode held back.",
  expert: "The ceiling a human can plausibly reach, still bounded by reaction time and the 512-input transcript cap.",
};

// Where a player stands when each fight opens (src/raid/harness/unlockArmy.ts, emitted by
// markers.report.ts). Optional: a grid generated before the marks existed still renders,
// just without them.
let MARKS = new Map();
try {
  MARKS = new Map(JSON.parse(readFileSync(`${DIR}/markers.json`, "utf8")).map((m) => [m.label, m]));
} catch {
  console.error("no markers.json — the grid will render without unlock marks");
}

// Column headers come off the data so they cannot drift from the bin edges.
const bands = rows[0].cells.map((_, i) => {
  const seen = rows.map((r) => r.cells[i]).filter((c) => c.rosters > 0);
  const avg = (pick) => seen.length
    ? Math.round(seen.reduce((a, c) => a + pick(c), 0) / seen.length) : 0;
  return {
    i,
    mean: avg((c) => c.meanEffective ?? c.meanStrength),
    // What the OLD metric said about the same rosters, shown under each header so the
    // disagreement between the two is visible rather than asserted.
    ladder: avg((c) => c.meanStrength),
    rosters: seen[0]?.rosters ?? 0,
  };
});

const byPilot = {};
for (const pilot of PILOTS) {
  byPilot[pilot] = rows
    .filter((r) => r.pilot === pilot)
    .sort((a, b) => a.unlock - b.unlock || a.label.localeCompare(b.label))
    .map((r) => {
      const m = MARKS.get(r.label);
      return {
        label: r.label,
        unlock: Math.floor(r.unlock),
        elite: r.label.includes("★"),
        // Where the player actually stands when this opens (unlockArmy.ts). Null when the
        // marks have not been generated, so the grid still renders without them.
        mark: m && {
          ceiling: m.ceiling.bin, ceilingAt: Math.round(m.ceiling.strength),
          moderate: m.moderate.bin, moderateAt: Math.round(m.moderate.strength),
          minMaxedAt: Math.round(m.minMaxed.strength),
        },
        cells: r.cells.map((c) => (c.flights
          ? [Math.round(c.winRate * 1000) / 10, Math.round(c.meanLosses * 10) / 10, Math.round(c.losslessRate * 100)]
          : null)),
      };
    });
}

const flights = rows.reduce((a, r) => a + r.cells.reduce((b, c) => b + c.flights, 0), 0);
// The last row's marks are the endgame account, and the gap between its balanced ceiling
// and its min-maxed one is what the last column is made of.
const last = [...MARKS.values()].sort((a, b) => a.unlock - b.unlock).pop();
const data = {
  bands, byPilot, pilots: PILOTS, notes: PILOT_NOTE,
  fights: byPilot.expert.length,
  flights,
  perBand: bands[0]?.rosters ?? 0,
  wall: last && {
    level: Math.floor(last.unlock),
    balanced: Math.round(last.ceiling.strength),
    minMaxed: Math.round(last.minMaxed.strength),
  },
};

const html = `<title>Invasion Difficulty Grid</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Chivo:wght@400;600;900&family=IBM+Plex+Mono:wght@400;600&display=swap">
<style>

  :root {
    --surface:        #fbfaf7;
    --surface-sunk:   #f2f0e9;
    --surface-raised: #ffffff;
    --rule:           #ddd9cc;
    --rule-strong:    #bdb8a6;
    --ink:            #17170f;
    --ink-2:          #5a584c;
    --ink-3:          #8b887a;
    --ui:             #3f4a63;
    --ui-soft:        #e6e9f0;
    /* Win-rate ramp, red -> amber -> green. Anchored on the status palette's
       critical (#d03b3b) and good (#0ca30c) with warm steps between, so the two ends
       are the colours the rest of the system already uses for "bad" and "fine". */
    --w0:  #a82f2c;
    --w17: #cc3f3a;
    --w34: #e0743c;
    --w50: #eaa42c;
    --w67: #c4ba28;
    --w84: #79ae21;
    --w100:#0f9b12;
    --void: #eceade;
    /* Unlock marks. Blue = the strongest party the level allows, purple = an ordinary
       account's. The halo is the hairline that keeps both legible on any cell fill. */
    --mark-ceil: #1f63d6;
    --mark-mod:  #8341cf;
    --halo: rgb(255 255 255 / 0.92);
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --surface:        #17170f;
      --surface-sunk:   #111109;
      --surface-raised: #1f1f16;
      --rule:           #33322a;
      --rule-strong:    #4c4b3f;
      --ink:            #f3f1e6;
      --ink-2:          #b4b1a0;
      --ink-3:          #817e6f;
      --ui:             #9aa8c8;
      --ui-soft:        #262a35;
      --w0:  #c0413d;
      --w17: #d64f49;
      --w34: #e8814a;
      --w50: #f0b03c;
      --w67: #cfc434;
      --w84: #85bd28;
      --w100:#18ac1a;
      --void: #232219;
      --mark-ceil: #5fa8ff;
      --mark-mod:  #c08cff;
      --halo: rgb(10 10 6 / 0.85);
    }
  }
  :root[data-theme="dark"] {
    --surface:        #17170f;
    --surface-sunk:   #111109;
    --surface-raised: #1f1f16;
    --rule:           #33322a;
    --rule-strong:    #4c4b3f;
    --ink:            #f3f1e6;
    --ink-2:          #b4b1a0;
    --ink-3:          #817e6f;
    --ui:             #9aa8c8;
    --ui-soft:        #262a35;
    --w0:  #c0413d;
    --w17: #d64f49;
    --w34: #e8814a;
    --w50: #f0b03c;
    --w67: #cfc434;
    --w84: #85bd28;
    --w100:#18ac1a;
    --void: #232219;
    --mark-ceil: #5fa8ff;
    --mark-mod:  #c08cff;
    --halo: rgb(10 10 6 / 0.85);
  }

  body {
    background: var(--surface);
    color: var(--ink);
    font-family: Chivo, "Helvetica Neue", Arial, sans-serif;
    font-size: 15px;
    line-height: 1.5;
  }
  .wrap { max-width: 1180px; margin: 0 auto; padding-inline: 20px; padding-block: 36px 64px; }

  header { border-bottom: 2px solid var(--rule-strong); padding-bottom: 20px; margin-bottom: 24px; }
  h1 {
    font-weight: 900; font-size: clamp(28px, 5vw, 42px); line-height: 1.05;
    letter-spacing: -0.02em; margin: 0 0 8px; text-wrap: balance;
  }
  .sub { color: var(--ink-2); max-width: 66ch; margin: 0; }
  .meta {
    font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 12px;
    color: var(--ink-3); margin-top: 14px; display: flex; flex-wrap: wrap; gap: 6px 20px;
  }

  .controls {
    display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-start;
    justify-content: space-between; margin-bottom: 8px;
  }
  .seg { display: flex; flex-wrap: wrap; gap: 4px; background: var(--surface-sunk);
         border: 1px solid var(--rule); border-radius: 3px; padding: 4px; }
  .seg button {
    font: 600 13px/1 Chivo, sans-serif; letter-spacing: 0.04em; text-transform: uppercase;
    background: none; border: 0; color: var(--ink-2); padding: 8px 14px; border-radius: 2px;
    cursor: pointer;
  }
  .seg button:hover { color: var(--ink); background: var(--ui-soft); }
  .seg button[aria-pressed="true"] { background: var(--ui); color: var(--surface); }
  .seg button:focus-visible { outline: 2px solid var(--ui); outline-offset: 2px; }

  .legend { font-family: "IBM Plex Mono", monospace; font-size: 11px; color: var(--ink-2); }
  .ramp { display: flex; height: 12px; width: 220px; border: 1px solid var(--rule-strong); }
  .ramp span { flex: 1; }
  .legend .ends { display: flex; justify-content: space-between; margin-top: 4px; }

  .pilotnote {
    font-size: 14px; color: var(--ink-2); margin: 0 0 18px; max-width: 72ch;
    border-left: 3px solid var(--ui); padding-left: 12px;
  }

  .scroller { overflow-x: auto; border: 1px solid var(--rule); background: var(--surface-raised); }
  table { border-collapse: separate; border-spacing: 0; width: 100%; font-variant-numeric: tabular-nums; }
  th, td { padding: 0; }
  thead th {
    position: sticky; top: 0; z-index: 3; background: var(--surface-raised);
    border-bottom: 2px solid var(--rule-strong);
    font: 600 11px/1.3 "IBM Plex Mono", monospace; color: var(--ink-2);
    text-align: center; padding: 10px 6px; white-space: nowrap;
  }
  thead th.corner { z-index: 4; left: 0; text-align: left; padding-left: 12px; min-width: 232px; }
  thead th .band { display: block; font-size: 14px; color: var(--ink); font-weight: 600; }
  thead th .wasband { display: block; font-size: 10px; color: var(--ink-3); font-weight: 400; }
  tbody th {
    position: sticky; left: 0; z-index: 2; background: var(--surface-raised);
    text-align: left; font: 400 13px/1.25 Chivo, sans-serif; color: var(--ink);
    padding: 7px 12px; border-right: 1px solid var(--rule-strong);
    border-bottom: 1px solid var(--rule); white-space: nowrap; min-width: 232px;
  }
  tbody th .lv {
    font-family: "IBM Plex Mono", monospace; font-size: 11px; color: var(--ink-3);
    display: inline-block; min-width: 26px;
  }
  tbody th .star { color: var(--w50); font-weight: 600; }
  tbody tr.era-break th, tbody tr.era-break td { border-top: 2px solid var(--rule-strong); }

  td.cell {
    border-bottom: 1px solid var(--rule); border-right: 1px solid var(--rule);
    text-align: center; min-width: 86px; cursor: default;
  }
  td.cell .win {
    display: block; font: 600 14px/1.1 "IBM Plex Mono", monospace; padding-top: 6px;
  }
  td.cell .loss { display: block; font: 400 10px/1.4 "IBM Plex Mono", monospace; padding-bottom: 6px; opacity: 0.85; }
  td.cell.void { background: var(--void); color: var(--ink-3); }
  td.cell.void .win { font-weight: 400; }
  td.cell:hover { outline: 2px solid var(--ink); outline-offset: -2px; }

  /* WHERE THE PLAYER IS when the fight opens. Drawn as inset rings so nothing reflows,
     with a pale hairline on the outside because the ring sits on a fill that runs from
     deep red to deep green and neither colour reads against both ends on its own. */
  td.cell.mark-moderate { box-shadow: inset 0 0 0 1.5px var(--halo), inset 0 0 0 4px var(--mark-mod); }
  td.cell.mark-ceiling  { box-shadow: inset 0 0 0 1.5px var(--halo), inset 0 0 0 4px var(--mark-ceil); }
  /* Both at once: the account's whole span is one column wide. */
  td.cell.mark-both {
    box-shadow: inset 0 0 0 1.5px var(--halo),
                inset 0 0 0 4px var(--mark-ceil),
                inset 0 0 0 7px var(--mark-mod);
  }
  td.cell.mark-moderate .win, td.cell.mark-ceiling .win, td.cell.mark-both .win { padding-top: 8px; }

  .marklegend { display: flex; flex-wrap: wrap; gap: 6px 18px; align-items: center;
                font-size: 12.5px; color: var(--ink-2); margin: 0 0 18px; }
  .marklegend .chip { display: inline-flex; align-items: center; gap: 7px; }
  .marklegend .swatch {
    width: 20px; height: 14px; border-radius: 2px; background: var(--surface-sunk);
    box-shadow: inset 0 0 0 1px var(--halo), inset 0 0 0 3px var(--c);
  }

  #tip {
    position: fixed; z-index: 20; pointer-events: none; max-width: 280px;
    background: var(--surface-raised); color: var(--ink);
    border: 1px solid var(--rule-strong); border-radius: 3px;
    padding: 10px 12px; font-size: 12.5px; line-height: 1.45;
    box-shadow: 0 6px 24px rgb(0 0 0 / 0.18);
  }
  #tip strong { display: block; font-size: 13.5px; margin-bottom: 4px; }
  #tip dl { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; margin: 6px 0 0;
            font-family: "IBM Plex Mono", monospace; font-size: 11.5px; }
  #tip dt { color: var(--ink-3); }
  #tip dd { margin: 0; text-align: right; }
  #tip .tipmark { margin: 8px 0 0; padding-top: 7px; border-top: 1px solid var(--rule);
                  font-size: 12px; color: var(--ink-2); }

  .notes { margin-top: 36px; display: grid; gap: 22px; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
  .notes h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em;
              color: var(--ink-3); margin: 0 0 6px; font-weight: 600; }
  .notes p { margin: 0 0 8px; color: var(--ink-2); font-size: 14px; }
  .notes strong { color: var(--ink); font-weight: 600; }
  code { font-family: "IBM Plex Mono", monospace; font-size: 0.92em; background: var(--surface-sunk);
         padding: 1px 4px; border-radius: 2px; }

  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
  @media (max-width: 640px) {
    thead th.corner, tbody th { min-width: 168px; white-space: normal; }
    td.cell { min-width: 74px; }
  }
</style>

<div class="wrap">
  <header>
    <h1>Invasion Difficulty Grid</h1>
    <p class="sub">Every fight in Zombie Farm against every level of army, at four levels of play.
      Each cell is a win rate and the average number of zombies that did not come home, over a
      sixteen-strong party of that strength.</p>
    <div class="meta">
      <span id="m-flights"></span>
      <span id="m-fights"></span>
      <span>16 zombies per roster</span>
      <span id="m-perband"></span>
      <span>2 wave seeds per roster</span>
    </div>
  </header>

  <div class="controls">
    <div class="seg" role="group" aria-label="Activity level" id="seg"></div>
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

  <p class="marklegend">
    <span class="chip"><span class="swatch" style="--c:var(--mark-ceil)"></span>
      strongest party the level allows</span>
    <span class="chip"><span class="swatch" style="--c:var(--mark-mod)"></span>
      an ordinary account at that level</span>
    <span style="color:var(--ink-3)">&mdash; where the player stands when the fight opens</span>
  </p>

  <p class="pilotnote" id="pilotnote"></p>

  <div class="scroller">
    <table id="grid">
      <thead><tr id="head"></tr></thead>
      <tbody id="body"></tbody>
    </table>
  </div>

  <div class="notes">
    <div>
      <h2>Rows</h2>
      <p>Every fight in the order a player <strong>meets</strong> it. The number beside each name is
        the level it becomes reachable.</p>
      <p>A <span class="star">★</span> row is a Brain Ticket fight, filed at its raid's unlock plus
        that raid's elite delay — ten early, five at the Ninjas, four at the Robots, three from the
        Aliens on — and never below <strong>20</strong>, where tickets unlock.</p>
    </div>
    <div>
      <h2>Columns</h2>
      <p><strong>Effective strength</strong>, fitted from play: 1,500 random armies flown over a
        six-fight battery, the result regressed on which zombies were in them. On held-out armies
        those weights order results at <strong>+0.64</strong> Spearman.</p>
      <p>The small grey number is what the <em>old</em> axis &mdash; the Strength Ladder,
        <code>√(Σ str·dex·con)</code> &mdash; said about the same rosters. Across the whole catalog
        it scores <strong>+0.23</strong>: it does know a Silver beats a Green. Among <em>top-tier</em>
        armies, where everything is Silver or Special and only composition is left, it scores
        <strong>&minus;0.30</strong> &mdash; actively anti-correlated, because it rates a tank and a
        healer far below a glass cannon. That is the half that made this grid unreadable.</p>
      <p>Every roster is <strong>sixteen zombies built at level 50</strong>, so neither army size nor
        the stat ramp is a second hidden axis.</p>
    </div>
    <div>
      <h2>Cells</h2>
      <p>Win rate over the band's rosters, and the mean casualties out of sixteen. Fill follows the
        win rate; the digits are there so the grid never depends on colour alone.</p>
      <p><strong>Invasions do not scale with player level.</strong> Each has one authored wave with
        fixed stats &mdash; raid 5 is 94,000 enemy hit points whether you meet it at level 10 or 50.
        A row is a fixed obstacle and the only variable is the army, which is why a strong enough
        early army clears late content here: nothing about the fight knows your level.</p>
      <p>Hover a cell for the loss-less share.</p>
    </div>
    <div>
      <h2>The two rings</h2>
      <p>Each row marks where the player stands when that fight opens: a <b style="color:var(--mark-ceil)">blue</b>
        ring on the strongest party the level allows, a <b style="color:var(--mark-mod)">purple</b> one on what an
        ordinary account fields. Cells to the right of blue are out of reach at that level.</p>
      <p>Both are sixteen zombies &mdash; the base army cap, which every farm has from the start &mdash;
        built at that level, so the stat ramp is in the number. Blue takes the best obtainable species with
        no duplicate limit, a full Pot, Master rank and the farmer's life head.</p>
      <p>Purple <strong>progresses</strong>, on the two channels a real account does: veterancy reaches
        Master around level 20, and the Pot fills one more mutation slot at 22, 30, 38 and 44. It keeps a
        two-per-species limit throughout. Holding it fixed instead &mdash; which an earlier version did
        &mdash; described a <em>new</em> account and made the mark stop moving at level 26, where ability
        tiers top out and the stat ramp ends.</p>
      <p>A ring marks the <em>band</em> a party lands in, not a point inside it. A party near a band's
        lower edge does worse than its column says &mdash; hover for the exact score against the band's
        mean.</p>
      <p><strong>What the re-bin fixed.</strong> On the old axis, seven rows finished <em>lower</em>
        at the strongest column than at their own peak, by 124 points in total &mdash; the inversion
        that made the grid unreadable.</p>
      <p>The fit behind this axis covers <strong>all 80 obtainable species</strong>, sampled over
        2,500 random armies. An earlier version sampled only the top 18, which left the fourth
        column unreliable and froze the purple mark solid from level 26 &mdash; after that point the
        only thing that changes for a player is which species they field, and a fit blind to species
        could not see it.</p>
    </div>
    <div>
      <h2>Parties</h2>
      <p>Every party fields <strong>at least two healers and one headless</strong>. Without that
        floor the top band selected for armies with neither — the ladder weights dex as heavily as
        constitution, and the healer and the tank are the two classes with the least of it — so the
        strongest column was the one with no support in it and win rate fell as strength rose.</p>
      <p>Mutations are the Pot's <strong>best-in-slot mask per species</strong>, applied as the flat
        adds the game applies (+5 / +4 / +9 on a full body, +8 / +0 / +9 on a headless, which has
        two fewer slots) — worth about <strong>×1.47</strong> on the ladder. One cohort is drawn
        unmutated on purpose, which is most of what fills the weaker bands.</p>
    </div>
  </div>
</div>

<div id="tip" hidden></div>

<script>
const DATA = ${JSON.stringify(data)};

const RAMP = ["--w0","--w17","--w34","--w50","--w67","--w84","--w100"];
const css = getComputedStyle(document.documentElement);

function hexToRgb(h) {
  const v = h.trim().replace("#","");
  return [parseInt(v.slice(0,2),16), parseInt(v.slice(2,4),16), parseInt(v.slice(4,6),16)];
}
function mix(a, b, t) { return a.map((x,i) => Math.round(x + (b[i]-x)*t)); }
/** Fill for a win rate 0..100, interpolated across the seven ramp stops. */
function fillFor(win) {
  const stops = RAMP.map((n) => hexToRgb(css.getPropertyValue(n)));
  const pos = (win/100) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(pos));
  const rgb = mix(stops[i], stops[i+1], pos - i);
  return { css: \`rgb(\${rgb.join(",")})\`, rgb };
}
/** Near-black or near-white, whichever reads on that fill. */
function inkOn(rgb) {
  const lin = rgb.map((c) => { const s = c/255; return s <= 0.03928 ? s/12.92 : Math.pow((s+0.055)/1.055, 2.4); });
  const L = 0.2126*lin[0] + 0.7152*lin[1] + 0.0722*lin[2];
  return L > 0.42 ? "#14140d" : "#fbfaf4";
}

const seg = document.getElementById("seg");
const head = document.getElementById("head");
const body = document.getElementById("body");
const note = document.getElementById("pilotnote");
const tip = document.getElementById("tip");
let current = "expert";

document.getElementById("m-flights").textContent = DATA.flights.toLocaleString() + " flights";
document.getElementById("m-fights").textContent = DATA.fights + " fights";
document.getElementById("m-perband").textContent = DATA.perBand + " rosters per band";

// The last column is reachable only by an army that abandons its own support, so say so
// with the live number rather than letting the reader assume it is simply unreachable.
{
  const el = document.getElementById("minmaxnote");
  if (DATA.wall && el) {
    el.innerHTML = "No blue ring reaches the last column. A party that drops to the bare minimum of support " +
      "&mdash; one headless, two gardens, the rest damage &mdash; scores <b>" + DATA.wall.minMaxed +
      "</b> at level " + DATA.wall.level + " against the balanced ceiling's <b>" + DATA.wall.balanced +
      "</b>, without being a better army: the ladder weights dexterity as heavily as constitution, and the " +
      "best headless has 1.0 of it.";
  }
}

for (const p of DATA.pilots) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = p;
  b.setAttribute("aria-pressed", String(p === current));
  b.addEventListener("click", () => { current = p; render(); });
  seg.appendChild(b);
}

function render() {
  [...seg.children].forEach((b) => b.setAttribute("aria-pressed", String(b.textContent === current)));
  note.textContent = DATA.notes[current];

  head.innerHTML = "";
  const corner = document.createElement("th");
  corner.className = "corner";
  corner.scope = "col";
  corner.innerHTML = 'Invasion <span style="color:var(--ink-3);font-weight:400">/ party strength &rarr;</span>';
  head.appendChild(corner);
  for (const band of DATA.bands) {
    const th = document.createElement("th");
    th.scope = "col";
    th.innerHTML = '<span class="band">' + band.mean + "</span>effective" +
      '<span class="wasband">was ' + band.ladder + "</span>";
    head.appendChild(th);
  }

  body.innerHTML = "";
  let prev = null;
  for (const row of DATA.byPilot[current]) {
    const tr = document.createElement("tr");
    if (prev !== null && row.unlock !== prev) tr.className = "era-break";
    prev = row.unlock;

    const th = document.createElement("th");
    th.scope = "row";
    const name = row.label.replace(" ★", "");
    th.innerHTML = '<span class="lv">' + row.unlock + "</span> " + name +
      (row.elite ? ' <span class="star">&#9733;</span>' : "");
    tr.appendChild(th);

    row.cells.forEach((c, i) => {
      const td = document.createElement("td");
      td.className = "cell";
      // Where this row's player stands when the fight opens.
      if (row.mark) {
        const ceil = row.mark.ceiling === i;
        const mod = row.mark.moderate === i;
        if (ceil && mod) td.classList.add("mark-both");
        else if (ceil) td.classList.add("mark-ceiling");
        else if (mod) td.classList.add("mark-moderate");
      }
      if (!c) {
        td.classList.add("void");
        td.innerHTML = '<span class="win">&ndash;</span><span class="loss">no roster</span>';
      } else {
        const [win, loss, clean] = c;
        const f = fillFor(win);
        td.style.background = f.css;
        td.style.color = inkOn(f.rgb);
        td.innerHTML = '<span class="win">' + Math.round(win) + '%</span>' +
                       '<span class="loss">' + loss.toFixed(1) + ' lost</span>';
        td.addEventListener("pointerenter", (e) => showTip(e, row, i, c));
        td.addEventListener("pointermove", moveTip);
        td.addEventListener("pointerleave", hideTip);
      }
      tr.appendChild(td);
    });
    body.appendChild(tr);
  }
}

function showTip(e, row, i, [win, loss, clean]) {
  const m = row.mark;
  const at = m && (m.ceiling === i || m.moderate === i);
  const here = at
    ? '<p class="tipmark">' + (m.ceiling === i && m.moderate === i
        ? "At level " + row.unlock + " both a maxed and an ordinary account land here."
        : m.ceiling === i
          ? "A <b>maxed</b> account at level " + row.unlock + " fields a party this strong."
          : "An <b>ordinary</b> account at level " + row.unlock + " fields a party this strong.")
      + "</p>"
    : "";
  tip.innerHTML = "<strong>" + row.label + "</strong>" +
    "reachable at level " + row.unlock + " &middot; " + current + " play" +
    "<dl><dt>party strength</dt><dd>~" + DATA.bands[i].mean + "</dd>" +
    "<dt>win rate</dt><dd>" + win.toFixed(1) + "%</dd>" +
    "<dt>clears clean</dt><dd>" + clean + "%</dd>" +
    "<dt>avg casualties</dt><dd>" + loss.toFixed(1) + " of 16</dd>" +
    (m ? "<dt>at unlock: maxed</dt><dd>" + m.ceilingAt + "</dd>" +
         "<dt>at unlock: ordinary</dt><dd>" + m.moderateAt + "</dd>" : "") +
    "</dl>" + here;
  tip.hidden = false;
  moveTip(e);
}
function moveTip(e) {
  const pad = 14;
  const r = tip.getBoundingClientRect();
  let x = e.clientX + pad;
  let y = e.clientY + pad;
  if (x + r.width > innerWidth - 8) x = e.clientX - r.width - pad;
  if (y + r.height > innerHeight - 8) y = e.clientY - r.height - pad;
  tip.style.left = Math.max(8, x) + "px";
  tip.style.top = Math.max(8, y) + "px";
}
function hideTip() { tip.hidden = true; }

render();
</script>
`;

writeFileSync(`${DIR}/index.html`, html);
console.log(`wrote ${DIR}/index.html — ${data.fights} fights, ${flights} flights, ${bands.length} bands`);
