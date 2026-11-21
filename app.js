// Skip-Bo Scorekeeper: all state lives in localStorage, so a refresh mid-game loses nothing.
"use strict";

// ------------------------------------------------------------------ auto-save to the Game Night server
// When this page is served by game-night-server, every save also goes to its SQLite database.
// On GitHub Pages there's no /api, the health check fails, and this quietly does nothing.
const Sync = (() => {
  let enabled = false, sending = false;
  const queue = new Map(), failed = new Map();   // keyed by game id, so two games never overwrite each other
  const ready = fetch("/api/health", { cache: "no-store" })
    .then((r) => r.ok && (r.headers.get("content-type") || "").includes("json"))
    .then((ok) => { enabled = Boolean(ok); if (enabled) show("Connected to the game server"); })
    .catch(() => {});

  function show(text, bad = false) {
    const el = document.getElementById("syncStatus");
    if (el) { el.textContent = text; el.style.color = bad ? "var(--red, #c00)" : ""; }
  }

  // Each save sends the whole game, so a later save also fixes any earlier one that failed.
  async function save(id, gameType, state) {
    await ready;
    if (!enabled || !id) return;
    queue.set(id, JSON.stringify({ game_type: gameType, state }));  // newer state for the same game replaces older
    flush();
  }

  async function flush() {
    if (sending) return;            // the running loop picks up anything queued meanwhile
    sending = true;
    while (queue.size) {
      const [id, body] = queue.entries().next().value;
      queue.delete(id);
      try {
        const r = await fetch(`/api/games/${encodeURIComponent(id)}`, {
          method: "PUT", headers: { "Content-Type": "application/json" }, body,
        });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
        failed.delete(id);
        show("✓ Saved to the game server");
      } catch (err) {
        failed.set(id, body);
        show(`Not saved to the server yet (${err.message}). It will retry on the next save.`, true);
      }
    }
    sending = false;
  }

  const retry = () => { failed.forEach((body, id) => queue.has(id) || queue.set(id, body)); flush(); };
  window.addEventListener("online", retry);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) retry(); });

  return { save, ready: () => ready.then(() => enabled) };
})();

// crypto.randomUUID() only works on https or localhost. Over http://klisby it's undefined,
// so build an id from the time plus random letters instead.
const newGameId = (prefix) => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const STORE_KEY = "skipbo-league:current";
const PALETTE = ["var(--blue)", "var(--red)", "var(--green)", "var(--orange)", "var(--purple)", "var(--teal)"];
const WIN_BONUS = 25;
const PER_CARD = 5;

// state = { id, startedAt, label, players: [...], target: 500, stock: 30,
//           hands: [{ winner: 0, left: [0, 6, 9] }] }   left[winner] is always 0
let state = load();
if (state && !state.id) state.id = newGameId("sb"); // games started before auto-save
let draft = null;        // { winner: index|null, left: [string per player] }

const $ = (id) => document.getElementById(id);
// Names go into innerHTML, so escape them. Without this, a name like "<img onerror=...>" runs as code.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n) => n.toLocaleString("en-US");

// ------------------------------------------------------------------ storage
function load() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || null; } catch { return null; }
}
function save() {
  if (state) Sync.save(state.id, "skipbo", state);
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { toast("Couldn't save in this browser. Export a CSV to be safe."); }
  if (state && window.CloudSync) {
    // Games started before cloud sync existed get an id the first time they're saved.
    if (!state.id) { state.id = CloudSync.newId(); state.startedAt = new Date().toISOString(); save(); return; }
    CloudSync.save(cloudGame());
  }
}

// The shape the family scores database expects (see cloud-sync.js).
function cloudGame() {
  const totals = state.players.map((_, i) =>
    state.hands.reduce((sum, h) => sum + (h.winner === i ? handPoints(h) : 0), 0));
  return {
    id: state.id, game: "skipbo", label: state.label, started_at: state.startedAt,
    finished: totals.some((t) => t >= state.target), target: state.target, stock: state.stock,
    players: state.players,
    hands: state.hands.map((h, k) => ({
      no: k + 1,
      scores: state.players.map((_, i) => ({ points: h.winner === i ? handPoints(h) : 0, won: h.winner === i, left: h.left[i] })),
    })),
  };
}

// ------------------------------------------------------------------ scoring (mirrors builder/build_site.py)
const handPoints = (hand) => WIN_BONUS + PER_CARD * hand.left.reduce((a, b) => a + b, 0);

function computePlayers() {
  const players = state.players.map((name, i) => {
    const pts = state.hands.map((h) => (h.winner === i ? handPoints(h) : 0));
    const left = state.hands.map((h) => h.left[i]);
    const won = state.hands.map((h) => h.winner === i);
    let run = 0;
    const cum = pts.map((p) => (run += p));
    return { name, seat: i, pts, left, won, cum, total: run, wins: won.filter(Boolean).length, best: Math.max(0, ...pts) };
  });
  // Rank: highest score, then most hands won. Colors follow rank once a hand is in; seat order before that.
  const ranked = [...players].sort((a, b) => b.total - a.total || b.wins - a.wins);
  (state.hands.length ? ranked : players).forEach((p, i) => { p.color = PALETTE[i % PALETTE.length]; });
  return { players, ranked };
}
const isOver = (ranked) => ranked.length > 0 && ranked[0].total >= state.target;

// ------------------------------------------------------------------ setup view
function renderSetup() {
  $("setup").classList.remove("hidden");
  $("game").classList.add("hidden");
  if (!$("nameList").children.length) ["", ""].forEach(addNameRow);
}
function addNameRow(value = "") {
  const n = $("nameList").children.length + 1;
  const row = document.createElement("div");
  row.className = "row";
  row.innerHTML = `<input type="text" id="name${n}" aria-label="Player ${n} name" placeholder="Player ${n}" maxlength="20" value="${esc(value)}">
    <button class="iconbtn" type="button" aria-label="Remove player ${n}">×</button>`;
  row.querySelector("button").onclick = () => row.remove();
  $("nameList").appendChild(row);
}
function startGame() {
  const names = [...$("nameList").querySelectorAll("input")].map((i) => i.value.trim()).filter(Boolean);
  if (names.length < 2) return ($("setupErr").textContent = "Add at least two players.");
  if (new Set(names.map((n) => n.toLowerCase())).size !== names.length)
    return ($("setupErr").textContent = "Two players have the same name. Add an initial to tell them apart.");
  const choice = $("stockSize").value;
  // Official rule: 30 cards for 2-4 players, 20 for 5 or more.
  const stock = choice === "auto" ? (names.length >= 5 ? 20 : 30) : Number(choice);
  const today = new Date().toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  state = { id: newGameId("sb"), label: $("gameLabel").value.trim() || today, players: names, target: Number($("target").value), stock, hands: [] };
  draft = null;
  save();
  render();
}

// ------------------------------------------------------------------ game view
function render() {
  if (!state) return renderSetup();
  $("setup").classList.add("hidden");
  $("game").classList.remove("hidden");

  const { players, ranked } = computePlayers();
  const over = isOver(ranked);
  const n = state.hands.length;
  const leader = ranked[0];

  $("gameEyebrow").textContent = `${state.label} · Playing to ${fmt(state.target)} · ${state.stock}-card stock piles · ${n} ${n === 1 ? "hand" : "hands"}`;
  if (!n) {
    $("headline").textContent = "Shuffle up";
    $("subline").textContent = `${players.length} players racing to ${fmt(state.target)}. Deal ${state.stock} cards to each stock pile.`;
  } else if (over) {
    $("headline").innerHTML = `<em style="color:${leader.color}">${esc(leader.name)}</em> takes the crown`;
    $("subline").innerHTML = `${esc(leader.name)} reached <strong>${fmt(leader.total)} points</strong> in ${n} hands, winning ${leader.wins} of them.`;
  } else {
    const togo = state.target - leader.total;
    $("headline").innerHTML = `<em style="color:${leader.color}">${esc(leader.name)}</em> leads after hand ${n}`;
    $("subline").innerHTML = `<strong>${fmt(leader.total)} points</strong>, ${fmt(togo)} away from ${fmt(state.target)}.`;
  }
  $("heroCard").style.setProperty("--champ", leader.color);
  const big = n ? fmt(leader.total) : "12";
  $("heroCenter").textContent = big;
  $("heroCenter").classList.toggle("long", big.length >= 3);
  $("heroCorner1").textContent = $("heroCorner2").textContent = n ? "★" : "12";
  $("heroRibbon").textContent = over ? "Champion" : n ? "Leader" : "Skip-Bo";

  $("entrySection").classList.toggle("hidden", over);
  $("overSection").classList.toggle("hidden", !over);
  $("undoBtn").disabled = !n;
  if (over) {
    $("banner").style.setProperty("--champ", leader.color);
    $("banner").innerHTML = `<div class="eyebrow" style="color:#fff;opacity:.85;margin:0">Game over</div>
      <h2>${esc(leader.name)} wins</h2>
      <div>Download the CSV to keep this game, then start a new one.</div>
      <div class="row" style="margin-top:8px"><button class="btn small" style="border-color:#fff;color:#fff" type="button" id="bannerUndo">Undo last hand</button></div>`;
    $("bannerUndo").onclick = undoHand;
  } else {
    $("entryTitle").textContent = `Hand ${n + 1}`;
    if (!draft || draft.left.length !== players.length) draft = { winner: null, left: players.map(() => "") };
    renderEntry(players);
  }

  $("standingsNote").textContent = `Highest score leads. First to ${fmt(state.target)} wins.`;
  renderPodium(ranked);
  renderLadder(players);
  renderChart(players);
}

function renderEntry(players) {
  $("entryRows").innerHTML = players.map((p, i) => {
    const isWinner = draft.winner === i;
    return `<div class="erow" style="--c:${p.color}">
      <div><div class="pname">${esc(p.name)}</div><div class="ptask">${fmt(p.total)} points · ${p.wins} ${p.wins === 1 ? "win" : "wins"}</div></div>
      <button type="button" class="toggle winpick" aria-pressed="${isWinner}" data-win="${i}">${isWinner ? "★ Won it" : "Won hand?"}</button>
      <div class="pts">
        ${isWinner
          ? `<div class="ptask" style="margin:0">Stock pile empty</div>`
          : `<div class="stepper">
              <button type="button" class="iconbtn" data-step="${i}" data-d="-1" aria-label="One fewer card for ${esc(p.name)}">−</button>
              <input type="number" inputmode="numeric" min="1" max="${state.stock}" id="left${i}" aria-label="Cards left in ${esc(p.name)}'s stock pile" placeholder="Cards left" value="${draft.left[i]}">
              <button type="button" class="iconbtn" data-step="${i}" data-d="1" aria-label="One more card for ${esc(p.name)}">+</button>
            </div>`}
      </div>
    </div>`;
  }).join("");
  updatePreview();
}

function updatePreview() {
  if (draft.winner === null) return ($("preview").textContent = "");
  const cards = draft.left.reduce((sum, v, i) => sum + (i === draft.winner ? 0 : Number(v) || 0), 0);
  const name = esc(state.players[draft.winner]);
  $("preview").innerHTML = `${name} scores <strong>${fmt(WIN_BONUS + PER_CARD * cards)}</strong> = 25 + 5 × ${cards} cards`;
}

function renderPodium(ranked) {
  const sfx = (k) => (k === 1 ? "st" : k === 2 ? "nd" : k === 3 ? "rd" : "th");
  $("podium").innerHTML = ranked.map((p, i) => `
    <article class="pcard" style="--c:${p.color}">
      <div style="display:flex;justify-content:space-between;align-items:end;gap:10px">
        <div class="name">${esc(p.name)}</div><div class="place">${i + 1}${sfx(i + 1)}</div>
      </div>
      <span class="tag">${p.total >= state.target ? "Reached " + fmt(state.target) : fmt(Math.max(0, state.target - p.total)) + " to go"}</span>
      <dl class="stats num">
        <dt>Score</dt><dd>${fmt(p.total)}</dd>
        <dt>Hands won</dt><dd>${p.wins}</dd>
        <dt>Best hand</dt><dd>${p.best ? fmt(p.best) : "–"}</dd>
      </dl>
    </article>`).join("");
}

function renderLadder(players) {
  const n = state.hands.length;
  $("ladderSection").classList.toggle("hidden", !n);
  const grid = $("ladder");
  grid.style.setProperty("--hands", n || 1);
  let html = "<div></div>";
  for (let h = 1; h <= n; h++) html += `<div class="hh">Hand ${h}</div>`;
  players.forEach((p) => {
    html += `<div class="who" style="color:${p.color}">${esc(p.name)}</div>`;
    for (let k = 0; k < n; k++) {
      html += p.won[k]
        ? `<div class="chip win" style="--c:${p.color};font-size:17px" title="Hand ${k + 1}: won, ${p.pts[k]} points">${p.pts[k]}<small>won</small></div>`
        : `<div class="chip left" style="--c:${p.color}" title="Hand ${k + 1}: ${p.left[k]} cards left">${p.left[k]}<small>left</small></div>`;
    }
  });
  grid.innerHTML = html;
}

function renderChart(players) {
  const n = state.hands.length;
  $("raceSection").classList.toggle("hidden", n < 1);
  if (n < 1) return;
  const svg = $("chart"), W = 900, H = 360, L = 52, R = 110, T = 16, B = 40;
  // x runs from 0 (start, everyone at 0) to n hands
  const top = Math.max(state.target, Math.ceil(Math.max(...players.map((p) => p.total)) / 100) * 100);
  const step = top <= 600 ? 100 : top <= 1200 ? 200 : 500;
  const x = (i) => L + (W - L - R) * (i / n), y = (v) => T + (H - T - B) * (1 - v / top);
  let s = "";
  for (let v = 0; v <= top; v += step) s += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${fmt(v)}</text>`;
  for (let i = 0; i <= n; i++) s += `<text x="${x(i)}" y="${H - B + 20}" text-anchor="middle">${i === 0 ? "Start" : i}</text>`;
  s += `<line x1="${L}" x2="${W - R}" y1="${y(state.target)}" y2="${y(state.target)}" stroke="var(--ink)" stroke-width="1.5" stroke-dasharray="6 5"/>`;
  s += `<text x="${L + 6}" y="${y(state.target) - 6}" style="fill:var(--ink);font-weight:700">Finish ${fmt(state.target)}</text>`;
  players.forEach((p) => {
    const pts = [0, ...p.cum];
    const d = pts.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    s += `<path d="${d}" fill="none" stroke="${p.color}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${x(n)}" cy="${y(p.total)}" r="5" fill="${p.color}"/>`;
  });
  const labels = players.map((p) => ({ p, y: y(p.total) })).sort((a, b) => a.y - b.y);
  labels.forEach((l, i) => { if (i && l.y - labels[i - 1].y < 16) l.y = labels[i - 1].y + 16; });
  labels.forEach(({ p, y: ly }) => (s += `<text x="${W - R + 10}" y="${ly + 4}" style="fill:${p.color};font-weight:700">${esc(p.name)} ${fmt(p.total)}</text>`));
  svg.innerHTML = s;
  $("chartKey").innerHTML = players.map((p) => `<span style="--c:${p.color}">${esc(p.name)}</span>`).join("");
}

// ------------------------------------------------------------------ hand entry
$("entryRows").addEventListener("click", (e) => {
  const t = e.target.closest("button");
  if (!t) return;
  if (t.dataset.win !== undefined) {
    const i = +t.dataset.win;
    draft.winner = draft.winner === i ? null : i;  // tap again to clear
    if (draft.winner !== null) draft.left[i] = "";
    renderEntry(computePlayers().players);
  } else if (t.dataset.step !== undefined) {
    const i = +t.dataset.step;
    const next = Math.min(state.stock, Math.max(1, (Number(draft.left[i]) || 0) + Number(t.dataset.d)));
    draft.left[i] = next;
    $("left" + i).value = next;
    updatePreview();
  }
});
$("entryRows").addEventListener("input", (e) => {
  const m = e.target.id.match(/^left(\d+)$/);
  if (m) { draft.left[+m[1]] = e.target.value; updatePreview(); }
});

$("entryForm").addEventListener("submit", (e) => {
  e.preventDefault(); // GitHub Pages has no server to submit to
  if (draft.winner === null) return ($("entryErr").textContent = "Tap the player who emptied their stock pile first.");
  const left = [];
  for (let i = 0; i < state.players.length; i++) {
    if (i === draft.winner) { left.push(0); continue; }
    const raw = String(draft.left[i]).trim(), v = Number(raw);
    if (raw === "") return ($("entryErr").textContent = `How many cards are left in ${state.players[i]}'s stock pile?`);
    if (!Number.isInteger(v) || v < 1 || v > state.stock)
      return ($("entryErr").textContent = `${state.players[i]}'s cards left should be between 1 and ${state.stock}.`);
    left.push(v);
  }
  $("entryErr").textContent = "";
  const hand = { winner: draft.winner, left };
  state.hands.push(hand);
  draft = null;
  save();
  render();
  toast(`Hand ${state.hands.length} saved: ${state.players[hand.winner]} +${handPoints(hand)}`);
});

function undoHand() {
  if (!state.hands.length) return;
  confirmThen(`Remove hand ${state.hands.length}? Its scores will go back into the entry form.`, () => {
    const h = state.hands.pop();
    draft = { winner: h.winner, left: h.left.map((v, i) => (i === h.winner ? "" : v)) };
    save();
    render();
  });
}
$("undoBtn").onclick = undoHand;

// ------------------------------------------------------------------ export / new game
function toCSV() {
  // One row per player per hand. builder/build_site.py reads this format.
  const q = (s) => (/[",\n]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : s);
  const lines = [`# target=${state.target} stock=${state.stock}`, "Hand,Player,Won hand?,Cards left"];
  state.hands.forEach((h, k) => h.left.forEach((v, i) => lines.push([k + 1, q(state.players[i]), h.winner === i ? "TRUE" : "FALSE", v].join(","))));
  return lines.join("\n") + "\n";
}
const fileName = () => (state.label || "game").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + ".csv";
$("exportBtn").onclick = () => {
  const url = URL.createObjectURL(new Blob([toCSV()], { type: "text/csv" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: fileName() });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
$("copyBtn").onclick = async () => {
  try { await navigator.clipboard.writeText(toCSV()); toast("CSV copied"); }
  catch { toast("Copy was blocked. Use Download CSV instead."); }
};
$("newBtn").onclick = () => confirmThen("Start a new game? This one is cleared from this browser, so download the CSV first if you want to keep it.", () => {
  const names = state.players;
  state = null; draft = null;
  try { localStorage.removeItem(STORE_KEY); } catch {}
  $("nameList").innerHTML = "";
  names.forEach(addNameRow); // same players again, ready to edit
  $("gameLabel").value = "";
  render();
});

// ------------------------------------------------------------------ small UI helpers
function confirmThen(text, onYes) {
  $("confirmText").textContent = text;
  $("confirmDlg").classList.remove("hidden");
  $("confirmYes").focus();
  $("confirmYes").onclick = () => { $("confirmDlg").classList.add("hidden"); onYes(); };
  $("confirmNo").onclick = () => $("confirmDlg").classList.add("hidden");
}
let toastTimer;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 2400);
}

$("addName").onclick = () => addNameRow();
$("startGame").onclick = startGame;
$("pastEmpty").classList.toggle("hidden", $("pastList").children.length > 0);

render();

// On the Game Night server every game is already saved, so point "Past games" at its home page
// instead of the CSV + builder steps (those still apply on GitHub Pages).
Sync.ready().then((onServer) => {
  if (!onServer) return;
  document.querySelectorAll("[data-server]").forEach((el) => (el.hidden = false));
  const past = document.getElementById("past");
  past.querySelector(".sechead p").textContent = "Every game is saved on the Game Night server automatically.";
  past.querySelector(".pastlist").insertAdjacentHTML("afterbegin",
    '<li><a href="/"><strong>See all saved games, winners and CSV downloads</strong></a></li>');
  document.getElementById("pastEmpty")?.classList.add("hidden");
});
