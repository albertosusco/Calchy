import { marked } from "marked";
import { evaluateDocument, NOTE_RE, REF_RE } from "./engine.js";

const $ = (id) => document.getElementById(id);
const editor = $("editor");
const backdrop = $("backdrop");
const results = $("results");
const gutter = $("gutter");
const mdEditor = $("md-editor");
const mdPreview = $("md-preview");
const mdToggle = $("md-toggle");

// ---------------------------------------------------------------------------
// File: dentro Tauri passano dai comandi Rust (~/.local/share/io.github.calchy/),
// aperta in un browser normale (npm run dev) si usa localStorage.
// ---------------------------------------------------------------------------
const inTauri = "__TAURI_INTERNALS__" in window;
// Su Android niente finestra da spostare, "sempre in primo piano" o scorciatoie globali
const isMobile = /Android|iPhone|iPad/i.test(navigator.userAgent);
if (isMobile) document.documentElement.classList.add("mobile");
const core = inTauri ? await import("@tauri-apps/api/core") : null;
const win = inTauri ? (await import("@tauri-apps/api/window")).getCurrentWindow() : null;

async function loadFile(name) {
  if (core) return core.invoke("load_file", { name });
  return localStorage.getItem(`calchy:${name}`) || "";
}

const saveTimers = {};
function saveFile(name, text, now = false) {
  clearTimeout(saveTimers[name]);
  const doSave = () => {
    if (core) core.invoke("save_file", { name, text }).catch(console.error);
    else localStorage.setItem(`calchy:${name}`, text);
  };
  if (now) doSave();
  else saveTimers[name] = setTimeout(doSave, 300);
}

// ---------------------------------------------------------------------------
// Impostazioni e temi
// ---------------------------------------------------------------------------
const PRESETS = {
  Notte: { bg: "#1e1f26", text: "#e8e8ea", calc: "#e0b03b", result: "#4f83a6" },
  Grafite: { bg: "#2a2a2a", text: "#eeeeec", calc: "#f6a35c", result: "#62a0ea" },
  Bosco: { bg: "#1d2521", text: "#e4eadf", calc: "#d9c36a", result: "#6fb39b" },
  Carta: { bg: "#f6f2e8", text: "#2e2b26", calc: "#a5700c", result: "#2f6690" },
};
const DEFAULTS = {
  colors: { ...PRESETS.Notte },
  fontSize: isMobile ? 16 : 15,
  alwaysOnTop: false,
  nativeWayland: false,
  notation: "eu", // "eu" = 1.234,56 · "en" = 1,234.56
  tab: "calc",
};
let settings = structuredClone(DEFAULTS);

function saveSettings() {
  saveFile("settings.json", JSON.stringify(settings, null, 2));
}

/** Mescola due colori #rrggbb: amount 0 = a, 1 = b */
function mix(a, b, amount) {
  const pa = a.match(/\w\w/g).map((h) => parseInt(h, 16));
  const pb = b.match(/\w\w/g).map((h) => parseInt(h, 16));
  return "#" + pa.map((v, i) => Math.round(v + (pb[i] - v) * amount).toString(16).padStart(2, "0")).join("");
}
function isLight(hex) {
  const [r, g, b] = hex.match(/\w\w/g).map((h) => parseInt(h, 16));
  return 0.299 * r + 0.587 * g + 0.114 * b > 150;
}

function applyTheme() {
  const { bg, text, calc, result } = settings.colors;
  const towards = isLight(bg) ? "#000000" : "#ffffff"; // schiarisce i temi scuri, scurisce i chiari
  const s = document.documentElement.style;
  s.setProperty("--bg", bg);
  s.setProperty("--text", text);
  s.setProperty("--calc", calc);
  s.setProperty("--result", result);
  s.setProperty("--bar", mix(bg, towards, 0.07));
  s.setProperty("--hover", mix(bg, towards, 0.14));
  s.setProperty("--line", mix(bg, towards, 0.16));
  s.setProperty("--border", mix(bg, calc, 0.55));
  s.setProperty("--muted", mix(text, bg, 0.45));
  document.querySelectorAll("[data-color]").forEach((input) => {
    input.value = settings.colors[input.dataset.color];
  });
}

function setFontSize(px) {
  settings.fontSize = Math.min(28, Math.max(10, px));
  document.documentElement.style.setProperty("--font-size", `${settings.fontSize}px`);
  saveSettings();
  alignRows();
}

// ---------------------------------------------------------------------------
// Tab Calcoli
// ---------------------------------------------------------------------------
let rows = []; // ultimo risultato del motore, usato anche dal tab Note
const refValues = () => new Map(rows.filter((r) => r.ref).map((r) => [r.ref, r.result]));

/** Riga colorata per il livello "fantasma": note _..._ attenuate, richiami @N in azzurro */
function highlightLine(line, isCalc) {
  const div = document.createElement("div");
  if (!line) { div.textContent = " "; return div; }
  if (!isCalc) { div.textContent = line; return div; }
  div.className = "calc";

  const marks = [];
  for (const m of line.matchAll(NOTE_RE)) marks.push([m.index + m[1].length, m.index + m[0].length, "note"]);
  for (const m of line.matchAll(REF_RE)) marks.push([m.index + m[1].length, m.index + m[0].length, "ref"]);
  marks.sort((a, b) => a[0] - b[0]);

  let pos = 0;
  for (const [start, end, cls] of marks) {
    if (start < pos) continue;
    if (start > pos) div.append(line.slice(pos, start));
    const span = document.createElement("span");
    span.className = cls;
    span.textContent = line.slice(start, end);
    div.append(span);
    pos = end;
  }
  if (pos < line.length) div.append(line.slice(pos));
  return div;
}

function renderCalc() {
  rows = evaluateDocument(editor.value, { notation: settings.notation });
  const lines = editor.value.split("\n");
  const back = document.createDocumentFragment();
  const res = document.createDocumentFragment();
  const gut = document.createDocumentFragment();

  rows.forEach(({ result, isCalc, ref }, i) => {
    back.append(highlightLine(lines[i], isCalc));

    const r = document.createElement("div");
    const g = document.createElement("div");
    if (result !== null) {
      r.textContent = result;
      r.dataset.copy = result;
      g.textContent = `@${ref}`;
      g.dataset.ref = ref;
    }
    res.append(r);
    gut.append(g);
  });

  backdrop.replaceChildren(back);
  results.replaceChildren(res);
  gutter.replaceChildren(gut);
  alignRows();
}

/** Allinea risultati e margine alle righe di testo, anche quando una riga va a capo */
function alignRows() {
  const texts = backdrop.children;
  const res = results.children;
  const gut = gutter.children;
  for (let i = 0; i < texts.length; i++) {
    const h = `${texts[i].offsetHeight}px`;
    res[i].style.height = h;
    gut[i].style.height = h;
  }
  syncScroll();
}
// Se la finestra cambia larghezza, gli a capo cambiano: riallinea
new ResizeObserver(alignRows).observe(editor);

function syncScroll() {
  backdrop.scrollTop = editor.scrollTop;
  backdrop.scrollLeft = editor.scrollLeft;
  results.scrollTop = editor.scrollTop;
  gutter.scrollTop = editor.scrollTop;
}

function insertAtCursor(textarea, text) {
  textarea.focus();
  document.execCommand("insertText", false, text);
}

// ---------------------------------------------------------------------------
// Tab Note (markdown)
// ---------------------------------------------------------------------------
// Niente HTML grezzo nelle note: viene mostrato come testo
marked.use({ gfm: true, breaks: true, renderer: { html: (token) => escapeHtml(token.text) } });

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderNotes() {
  if (!mdEditor.value.trim()) {
    mdPreview.innerHTML = '<p class="empty">Clicca qui per scrivere. Supporta il markdown (# titoli, **grassetto**, - elenchi…) e i richiami ai calcoli come @1.</p>';
    return;
  }
  mdPreview.innerHTML = marked.parse(mdEditor.value);

  // Sostituisce i richiami @N con i risultati del tab Calcoli (sempre aggiornati)
  const values = refValues();
  const walker = document.createTreeWalker(mdPreview, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) {
    const n = walker.currentNode;
    if (!n.parentElement.closest("code, pre")) nodes.push(n);
  }
  for (const node of nodes) {
    const text = node.nodeValue;
    if (!text.includes("@")) continue;
    const frag = document.createDocumentFragment();
    let pos = 0;
    for (const m of text.matchAll(REF_RE)) {
      const start = m.index + m[1].length;
      frag.append(text.slice(pos, start));
      const span = document.createElement("span");
      const value = values.get(Number(m[2]));
      span.className = value ? "ref" : "ref missing";
      span.textContent = value ?? `@${m[2]}?`;
      span.title = value ? `@${m[2]}` : `La riga @${m[2]} non esiste nel tab Calcoli`;
      frag.append(span);
      pos = m.index + m[0].length;
    }
    if (pos === 0) continue;
    frag.append(text.slice(pos));
    node.replaceWith(frag);
  }
}

function setNotesEditing(editing) {
  mdEditor.hidden = !editing;
  mdPreview.hidden = editing;
  mdToggle.textContent = editing ? "Anteprima" : "Modifica";
  if (editing) {
    mdEditor.focus();
  } else {
    saveFile("notes.md", mdEditor.value, true);
    renderNotes();
  }
}

// ---------------------------------------------------------------------------
// Tab, finestra, scorciatoie
// ---------------------------------------------------------------------------
function showTab(tab) {
  settings.tab = tab;
  saveSettings();
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $("calc-view").classList.toggle("active", tab === "calc");
  $("notes-view").classList.toggle("active", tab === "notes");
  if (tab === "notes") {
    renderNotes(); // i richiami potrebbero essere cambiati
    if (!mdEditor.hidden) mdEditor.focus();
  } else {
    alignRows();
    if (!isMobile) editor.focus();
  }
}

function focusActive() {
  if (settings.tab === "calc") editor.focus();
  else if (!mdEditor.hidden) mdEditor.focus();
}

let toastTimer;
function showToast(msg) {
  const toast = $("toast");
  toast.textContent = msg;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 1400);
}

function saveAll() {
  saveFile("note.txt", editor.value, true);
  saveFile("notes.md", mdEditor.value, true);
}

function hideWindow() {
  saveAll();
  if (core) core.invoke("hide_window");
}

async function setAlwaysOnTop(on, announce = true) {
  settings.alwaysOnTop = on;
  $("pin").setAttribute("aria-pressed", String(on));
  saveSettings();
  if (win) await win.setAlwaysOnTop(on).catch(console.error);
  if (announce) showToast(on ? "Sempre in primo piano: attivo" : "Sempre in primo piano: disattivato");
}

// ---------------------------------------------------------------------------
// Pannello impostazioni
// ---------------------------------------------------------------------------
function openSettings(open) {
  $("settings").hidden = !open;
  if (!open) focusActive();
}

const presetBox = document.querySelector(".presets");
for (const [name, colors] of Object.entries(PRESETS)) {
  const b = document.createElement("button");
  b.className = "preset";
  b.textContent = name;
  b.style.background = colors.bg;
  b.style.color = colors.calc;
  b.addEventListener("click", () => { settings.colors = { ...colors }; applyTheme(); saveSettings(); });
  presetBox.append(b);
}
document.querySelectorAll("[data-color]").forEach((input) => {
  input.addEventListener("input", () => {
    settings.colors[input.dataset.color] = input.value;
    applyTheme();
    saveSettings();
  });
});
$("reset-colors").addEventListener("click", () => { settings.colors = { ...PRESETS.Notte }; applyTheme(); saveSettings(); });
$("settings-close").addEventListener("click", () => openSettings(false));
$("settings").addEventListener("click", (e) => { if (e.target.id === "settings") openSettings(false); });
function applyNotation() {
  document.querySelectorAll("[data-notation]").forEach((b) =>
    b.classList.toggle("active", b.dataset.notation === settings.notation));
}
document.querySelectorAll("[data-notation]").forEach((b) => {
  b.addEventListener("click", () => {
    if (b.dataset.notation === settings.notation) return;
    // Converte i numeri già scritti nelle righe di calcolo: 1.250,50 <-> 1,250.50
    const lines = editor.value.split("\n");
    rows.forEach((row, i) => {
      if (row.isCalc) {
        lines[i] = lines[i].replace(/\d[\d.,]*\d/g, (num) =>
          num.replace(/[.,]/g, (c) => (c === "." ? "," : ".")));
      }
    });
    editor.value = lines.join("\n");
    saveFile("note.txt", editor.value);
    settings.notation = b.dataset.notation;
    saveSettings();
    applyNotation();
    renderCalc(); // ricalcola con la nuova notazione
    renderNotes();
  });
});

$("native-wayland").addEventListener("change", (e) => {
  settings.nativeWayland = e.target.checked;
  saveSettings();
  $("pin").disabled = settings.nativeWayland;
  showToast("Chiudi Calchy con Ctrl+Q e riaprila per applicare");
});

// ---------------------------------------------------------------------------
// Eventi
// ---------------------------------------------------------------------------
editor.addEventListener("input", () => { renderCalc(); saveFile("note.txt", editor.value); });
editor.addEventListener("scroll", syncScroll);
mdEditor.addEventListener("input", () => saveFile("notes.md", mdEditor.value));
mdEditor.addEventListener("blur", () => { if (!mdEditor.hidden) setNotesEditing(false); });
window.addEventListener("blur", saveAll);

for (const ta of [editor, mdEditor]) {
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Tab") { e.preventDefault(); insertAtCursor(ta, "  "); } // Tab = due spazi
  });
}

// Clic sull'anteprima: passa alla modifica (ma non se si sta selezionando del testo)
mdPreview.addEventListener("click", (e) => {
  if (e.target.closest("a")) e.preventDefault(); // i link non devono aprirsi dentro la finestra
  if (!window.getSelection().isCollapsed) return;
  setNotesEditing(true);
});
mdToggle.addEventListener("mousedown", (e) => e.preventDefault()); // non far perdere il focus all'editor
mdToggle.addEventListener("click", () => setNotesEditing(mdEditor.hidden));

document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
$("close").addEventListener("click", hideWindow);
$("pin").addEventListener("click", () => setAlwaysOnTop(!settings.alwaysOnTop));
$("settings-btn").addEventListener("click", () => openSettings($("settings").hidden));

// Clic su un risultato: lo copia negli appunti
results.addEventListener("click", async (e) => {
  const value = e.target.dataset?.copy;
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    // alcune WebView Android non permettono l'API moderna: metodo classico
    const tmp = document.createElement("textarea");
    tmp.value = value;
    document.body.append(tmp);
    tmp.select();
    const ok = document.execCommand("copy");
    tmp.remove();
    if (!ok) return showToast("Impossibile copiare");
  }
  showToast(`Copiato: ${value}`);
});
// Clic su @N nel margine: inserisce il richiamo dove si trova il cursore
gutter.addEventListener("mousedown", (e) => e.preventDefault());
gutter.addEventListener("click", (e) => {
  const ref = e.target.dataset?.ref;
  if (ref) insertAtCursor(editor, `@${ref}`);
});

window.addEventListener("keydown", (e) => {
  const key = e.key.toLowerCase();
  if (e.key === "Escape") {
    e.preventDefault();
    if (!$("settings").hidden) openSettings(false);
    else if (settings.tab === "notes" && !mdEditor.hidden) setNotesEditing(false);
    else hideWindow();
    return;
  }
  if (!e.ctrlKey) return;
  if (key === "q") { e.preventDefault(); saveAll(); if (core) core.invoke("quit_app"); }
  else if (key === "1") { e.preventDefault(); showTab("calc"); }
  else if (key === "2") { e.preventDefault(); showTab("notes"); }
  else if (key === "tab") { e.preventDefault(); showTab(settings.tab === "calc" ? "notes" : "calc"); }
  else if (key === "e" && settings.tab === "notes") { e.preventDefault(); setNotesEditing(mdEditor.hidden); }
  else if (key === "t") { e.preventDefault(); setAlwaysOnTop(!settings.alwaysOnTop); }
  else if (key === "+" || key === "=") { e.preventDefault(); setFontSize(settings.fontSize + 1); }
  else if (key === "-") { e.preventDefault(); setFontSize(settings.fontSize - 1); }
  else if (key === "0") { e.preventDefault(); setFontSize(DEFAULTS.fontSize); }
});

// Quando la finestra torna visibile, rimetti il cursore nel testo
document.addEventListener("visibilitychange", () => {
  if (document.hidden) saveAll(); // su Android l'app può essere chiusa dal sistema mentre è in background
  else if (!isMobile) focusActive(); // sul telefono non apriamo la tastiera da soli
});
$("font-down").addEventListener("click", () => setFontSize(settings.fontSize - 1));
$("font-up").addEventListener("click", () => setFontSize(settings.fontSize + 1));

// ---------------------------------------------------------------------------
// Avvio
// ---------------------------------------------------------------------------
try {
  const saved = JSON.parse((await loadFile("settings.json")) || "{}");
  settings = { ...DEFAULTS, ...saved, colors: { ...DEFAULTS.colors, ...saved.colors } };
} catch {
  /* impostazioni illeggibili: si riparte dai valori predefiniti */
}
applyTheme();
document.documentElement.style.setProperty("--font-size", `${settings.fontSize}px`);
$("native-wayland").checked = settings.nativeWayland;
applyNotation();
$("pin").disabled = settings.nativeWayland;
if (settings.nativeWayland) $("pin").title = "Non disponibile in modalità Wayland nativa (vedi Impostazioni)";
if (settings.alwaysOnTop && !settings.nativeWayland) setAlwaysOnTop(true, false);

editor.value = await loadFile("note.txt");
mdEditor.value = await loadFile("notes.md");
renderCalc();
setNotesEditing(false);
showTab(settings.tab);
