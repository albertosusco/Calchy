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
const tabList = $("tabs");

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

function deleteFile(name) {
  clearTimeout(saveTimers[name]);
  if (core) core.invoke("delete_file", { name }).catch(console.error);
  else localStorage.removeItem(`calchy:${name}`);
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
  tab: "calc", // id del tab aperto
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

function applyFontSize() {
  const s = document.documentElement.style;
  s.setProperty("--font-size", `${settings.fontSize}px`);
  // Altezza della riga in pixel interi: WebKit arrotonda quella della textarea
  // (25,5px -> 25px) ma non quella del testo colorato, che si sfalserebbe riga dopo riga
  s.setProperty("--row", `${Math.round(settings.fontSize * 1.7)}px`);
}

function setFontSize(px) {
  settings.fontSize = Math.min(28, Math.max(10, px));
  applyFontSize();
  saveSettings();
  alignRows();
}

// ---------------------------------------------------------------------------
// Tab: elenco in tabs.json, il testo di ognuno nel suo file.
// I primi due (Calcoli e Note) usano ancora note.txt e notes.md delle versioni precedenti.
// ---------------------------------------------------------------------------
const FIRST_TABS = [
  { id: "calc", name: "Calcoli", type: "calc", file: "note.txt" },
  { id: "notes", name: "Note", type: "text", file: "notes.md" },
];
let tabs = [];
let current = null; // tab aperto

const calcTabs = () => tabs.filter((t) => t.type === "calc");
const tabById = (id) => tabs.find((t) => t.id === id);

function saveTabs() {
  // subito, non dopo la pausa: l'elenco cambia di rado e non deve andare perso
  saveFile("tabs.json", JSON.stringify(tabs.map(({ id, name, type, file }) => ({ id, name, type, file })), null, 2), true);
}

async function loadTabs() {
  let list = [];
  try {
    list = JSON.parse((await loadFile("tabs.json")) || "[]");
  } catch {
    /* elenco illeggibile: si riparte dai due tab iniziali */
  }
  if (!Array.isArray(list) || list.length === 0) list = structuredClone(FIRST_TABS);
  tabs = await Promise.all(list.map(async (t) => ({ ...t, text: await loadFile(t.file) })));
}

/** Risultati di un tab di calcolo (ricalcolati solo se il testo è cambiato) */
function rowsOf(tab) {
  const key = `${settings.notation}\n${tab.text}`;
  if (tab.cacheKey !== key) {
    tab.rows = evaluateDocument(tab.text, { notation: settings.notation });
    tab.cacheKey = key;
  }
  return tab.rows;
}

function renderTabBar() {
  tabList.replaceChildren(...tabs.map((t) => {
    const b = document.createElement("button");
    b.className = `tab ${t.type}`;
    b.classList.toggle("active", t === current);
    b.dataset.id = t.id;
    b.textContent = t.name;
    b.title = t.type === "calc"
      ? "Calcoli · doppio clic o pressione lunga per rinominare"
      : "Testo · doppio clic o pressione lunga per rinominare";
    return b;
  }));
  $("title").textContent = current.name;
  tabList.querySelector(".active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

// ---------------------------------------------------------------------------
// Tab di calcolo
// ---------------------------------------------------------------------------
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
  const rows = rowsOf(current);
  const lines = current.text.split("\n");
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
    // altezza esatta: offsetHeight arrotonda (25,5px -> 26px) e riga dopo riga si sfalsa
    const h = `${texts[i].getBoundingClientRect().height}px`;
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
// Tab di testo (markdown)
// ---------------------------------------------------------------------------
// Niente HTML grezzo nelle note: viene mostrato come testo
marked.use({ gfm: true, breaks: true, renderer: { html: (token) => escapeHtml(token.text) } });

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Richiami nel testo: @N*nome prende la riga N del tab di calcolo "nome"
 * (il nome può contenere spazi; maiuscole e minuscole sono indifferenti),
 * @N da solo prende la riga N del primo tab di calcolo.
 * Restituisce { start, end, n, tab, name } per ogni richiamo trovato.
 */
function findRefs(text) {
  const names = calcTabs().slice().sort((a, b) => b.name.length - a.name.length);
  const found = [];
  for (const m of text.matchAll(REF_RE)) {
    const start = m.index + m[1].length;
    let end = m.index + m[0].length;
    let tab = calcTabs()[0];
    let name = null;
    if (text[end] === "*") {
      const rest = text.slice(end + 1).toLowerCase();
      tab = names.find((t) => rest.startsWith(t.name.toLowerCase())
        && !/[\p{L}\p{N}_]/u.test(rest[t.name.length] ?? ""));
      name = tab ? text.substr(end + 1, tab.name.length) : (rest.match(/^[\p{L}\p{N}_-]+/u)?.[0] ?? "");
      if (tab || name) end += 1 + name.length;
      else tab = calcTabs()[0]; // "@3*2": un asterisco seguito da altro non è un nome
    }
    found.push({ start, end, n: Number(m[2]), tab, name });
  }
  return found;
}

function refValue({ n, tab }) {
  return tab ? rowsOf(tab).find((r) => r.ref === n)?.result ?? null : null;
}

// Segnaposto nel markdown al posto dei richiami: così l'asterisco di @3*Casa
// non viene scambiato per un corsivo
const PH = (i) => `${i}`;
const PH_RE = /(\d+)/g;

function renderNotes() {
  const source = current.text;
  if (!source.trim()) {
    mdPreview.innerHTML = '<p class="empty">Tocca qui per scrivere. Supporta il markdown (# titoli, **grassetto**, - elenchi…) e i richiami ai calcoli: @3 per la riga 3 del primo tab di calcolo, @3*Nome per quella del tab "Nome".</p>';
    return;
  }
  const refs = findRefs(source);
  let withPlaceholders = "";
  let pos = 0;
  refs.forEach((r, i) => {
    withPlaceholders += source.slice(pos, r.start) + PH(i);
    pos = r.end;
  });
  mdPreview.innerHTML = marked.parse(withPlaceholders + source.slice(pos));

  const walker = document.createTreeWalker(mdPreview, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const text = node.nodeValue;
    if (!text.includes("")) continue;
    // nel codice il richiamo resta scritto così com'è
    if (node.parentElement.closest("code, pre")) {
      node.nodeValue = text.replace(PH_RE, (_, i) => source.slice(refs[i].start, refs[i].end));
      continue;
    }
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of text.matchAll(PH_RE)) {
      frag.append(text.slice(last, m.index));
      const r = refs[Number(m[1])];
      const written = source.slice(r.start, r.end);
      const value = refValue(r);
      const span = document.createElement("span");
      span.className = value ? "ref" : "ref missing";
      span.textContent = value ?? `${written}?`;
      span.title = value ? written
        : !r.tab ? `Nessun tab di calcolo si chiama "${r.name}"`
        : `La riga @${r.n} non esiste nel tab "${r.tab.name}"`;
      frag.append(span);
      last = m.index + m[0].length;
    }
    frag.append(text.slice(last));
    node.replaceWith(frag);
  }
}

function setNotesEditing(editing) {
  mdEditor.hidden = !editing;
  mdPreview.hidden = editing;
  mdToggle.textContent = editing ? "Anteprima" : "Modifica";
  if (editing) {
    mdEditor.focus();
  } else if (current?.type === "text") {
    saveFile(current.file, current.text, true);
    renderNotes();
  }
}

// ---------------------------------------------------------------------------
// Cambio tab, finestra, scorciatoie
// ---------------------------------------------------------------------------
function showTab(id, direction = null) {
  const tab = tabById(id) ?? tabs[0];
  if (current && current !== tab) saveFile(current.file, current.text, true);
  current = tab;
  settings.tab = tab.id;
  saveSettings();
  renderTabBar();

  const isCalc = tab.type === "calc";
  const view = $(isCalc ? "calc-view" : "notes-view");
  $("calc-view").classList.toggle("active", isCalc);
  $("notes-view").classList.toggle("active", !isCalc);
  if (isCalc) {
    if (editor.value !== tab.text) editor.value = tab.text;
    editor.scrollTop = 0;
    renderCalc();
    if (!isMobile) editor.focus();
  } else {
    if (mdEditor.value !== tab.text) mdEditor.value = tab.text;
    setNotesEditing(false);
    mdPreview.scrollTop = 0;
  }
  if (direction) {
    view.classList.remove("from-right", "from-left");
    void view.offsetWidth; // riavvia l'animazione
    view.classList.add(direction > 0 ? "from-right" : "from-left");
    view.addEventListener("animationend", () => view.classList.remove("from-right", "from-left"), { once: true });
  }
}

/** Tab vicino: +1 quello a destra, -1 quello a sinistra */
function stepTab(step) {
  const i = tabs.indexOf(current);
  const next = tabs[i + step];
  if (next) showTab(next.id, step);
}

function focusActive() {
  if (current.type === "calc") editor.focus();
  else if (!mdEditor.hidden) mdEditor.focus();
}

let toastTimer;
function showToast(msg) {
  const toast = $("toast");
  toast.textContent = msg;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 1600);
}

function saveAll() {
  for (const t of tabs) saveFile(t.file, t.text, true);
  saveFile("settings.json", JSON.stringify(settings, null, 2), true);
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
// Finestra per creare, rinominare ed eliminare un tab
// ---------------------------------------------------------------------------
const tabDialog = $("tab-dialog");
const tabName = $("tab-name");
let editing = null; // tab che si sta modificando; null = nuovo tab
let newType = "calc";

function setNewType(type) {
  newType = type;
  document.querySelectorAll("[data-type]").forEach((b) => b.classList.toggle("active", b.dataset.type === type));
}

function openTabDialog(tab = null) {
  editing = tab;
  $("tab-dialog-title").textContent = tab ? "Modifica tab" : "Nuovo tab";
  $("tab-type-field").hidden = !!tab;
  $("tab-ok").textContent = tab ? "Salva" : "Crea";
  const del = $("tab-delete");
  del.hidden = !tab;
  del.disabled = tabs.length === 1;
  del.textContent = "Elimina";
  delete del.dataset.confirm;
  tabName.value = tab ? tab.name : "";
  if (!tab) setNewType("calc");
  tabDialog.hidden = false;
  tabName.focus();
  tabName.select();
}

function closeTabDialog() {
  tabDialog.hidden = true;
  focusActive();
}

/** Nome valido e non già usato da un altro tab (serve per i richiami @N*nome) */
function checkName(name, except) {
  if (!name) return "Scrivi un nome";
  if (/[*@]/.test(name)) return "Il nome non può contenere * o @";
  if (tabs.some((t) => t !== except && t.name.toLowerCase() === name.toLowerCase())) return "Esiste già un tab con questo nome";
  return null;
}

/** Aggiorna i richiami @N*vecchio nei tab di testo quando un tab di calcolo cambia nome */
function renameRefs(tab, newName) {
  for (const t of tabs) {
    if (t.type !== "text") continue;
    const refs = findRefs(t.text).filter((r) => r.tab === tab && r.name);
    if (!refs.length) continue;
    let out = "";
    let pos = 0;
    for (const r of refs) {
      out += t.text.slice(pos, r.start) + `@${r.n}*${newName}`;
      pos = r.end;
    }
    t.text = out + t.text.slice(pos);
    saveFile(t.file, t.text);
  }
}

$("tab-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = tabName.value.trim().replace(/\s+/g, " ");
  const error = checkName(name, editing);
  if (error) return showToast(error);
  if (editing) {
    if (editing.type === "calc") renameRefs(editing, name);
    editing.name = name;
  } else {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const tab = { id, name, type: newType, file: `tab-${id}.${newType === "calc" ? "txt" : "md"}`, text: "" };
    tabs.push(tab);
    saveFile(tab.file, "", true);
    editing = tab;
  }
  saveTabs();
  tabDialog.hidden = true;
  const opened = editing;
  showTab(opened.id);
  if (opened.type === "text" && !opened.text) setNotesEditing(true);
});

$("tab-delete").addEventListener("click", () => {
  const del = $("tab-delete");
  // primo tocco: chiede conferma; secondo tocco: elimina
  if (!del.dataset.confirm) {
    del.dataset.confirm = "1";
    del.textContent = "Conferma eliminazione";
    return;
  }
  const i = tabs.indexOf(editing);
  tabs.splice(i, 1);
  deleteFile(editing.file);
  saveTabs();
  tabDialog.hidden = true;
  showToast(`Tab "${editing.name}" eliminato`);
  if (current === editing) {
    current = null;
    showTab(tabs[Math.max(0, i - 1)].id);
  } else {
    renderTabBar();
  }
});
$("tab-cancel").addEventListener("click", closeTabDialog);
tabDialog.addEventListener("click", (e) => { if (e.target === tabDialog) closeTabDialog(); });
document.querySelectorAll("[data-type]").forEach((b) => b.addEventListener("click", () => setNewType(b.dataset.type)));
$("add-tab").addEventListener("click", () => openTabDialog());

tabList.addEventListener("click", (e) => {
  const id = e.target.closest(".tab")?.dataset.id;
  if (id && id !== current.id) showTab(id, tabs.indexOf(tabById(id)) > tabs.indexOf(current) ? 1 : -1);
});
// Doppio clic (computer) o pressione lunga (telefono, arriva come contextmenu): modifica
tabList.addEventListener("dblclick", (e) => {
  const id = e.target.closest(".tab")?.dataset.id;
  if (id) openTabDialog(tabById(id));
});
tabList.addEventListener("contextmenu", (e) => {
  const id = e.target.closest(".tab")?.dataset.id;
  if (!id) return;
  e.preventDefault();
  openTabDialog(tabById(id));
});

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
    // Converte i numeri già scritti nelle righe di calcolo di tutti i tab: 1.250,50 <-> 1,250.50
    for (const tab of calcTabs()) {
      const lines = tab.text.split("\n");
      rowsOf(tab).forEach((row, i) => {
        if (row.isCalc) {
          lines[i] = lines[i].replace(/\d[\d.,]*\d/g, (num) =>
            num.replace(/[.,]/g, (c) => (c === "." ? "," : ".")));
        }
      });
      tab.text = lines.join("\n");
      saveFile(tab.file, tab.text);
    }
    settings.notation = b.dataset.notation;
    saveSettings();
    applyNotation();
    showTab(current.id); // ricalcola con la nuova notazione
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
editor.addEventListener("input", () => {
  current.text = editor.value;
  renderCalc();
  saveFile(current.file, current.text);
});
editor.addEventListener("scroll", syncScroll);
mdEditor.addEventListener("input", () => {
  current.text = mdEditor.value;
  saveFile(current.file, current.text);
});
mdEditor.addEventListener("blur", () => { if (!mdEditor.hidden) setNotesEditing(false); });
window.addEventListener("blur", saveAll);

for (const ta of [editor, mdEditor]) {
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Tab" && !e.ctrlKey) { e.preventDefault(); insertAtCursor(ta, "  "); } // Tab = due spazi
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

// Swipe orizzontale: verso sinistra il tab successivo, verso destra il precedente
let swipe = null;
document.querySelector("main").addEventListener("touchstart", (e) => {
  const t = e.touches[0];
  // niente swipe con più dita o dove il contenuto scorre di lato (tabelle, codice)
  swipe = e.touches.length === 1 && !e.target.closest("pre, table")
    ? { x: t.clientX, y: t.clientY, time: e.timeStamp } : null;
}, { passive: true });
document.querySelector("main").addEventListener("touchend", (e) => {
  if (!swipe) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - swipe.x;
  const dy = t.clientY - swipe.y;
  const quick = e.timeStamp - swipe.time < 600;
  swipe = null;
  if (!quick || Math.abs(dx) < 60 || Math.abs(dx) < 2 * Math.abs(dy)) return;
  // trascinando per selezionare del testo non si cambia tab
  if (editor.selectionStart !== editor.selectionEnd && document.activeElement === editor) return;
  if (!window.getSelection().isCollapsed && document.activeElement !== editor) return;
  stepTab(dx < 0 ? 1 : -1);
});
document.querySelector("main").addEventListener("touchcancel", () => { swipe = null; });
$("close").addEventListener("click", hideWindow);
$("pin").addEventListener("click", () => setAlwaysOnTop(!settings.alwaysOnTop));
for (const id of ["settings-btn", "settings-btn-bottom"]) {
  $(id).addEventListener("click", () => openSettings($("settings").hidden));
}

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
    if (!tabDialog.hidden) closeTabDialog();
    else if (!$("settings").hidden) openSettings(false);
    else if (current.type === "text" && !mdEditor.hidden) setNotesEditing(false);
    else hideWindow();
    return;
  }
  if (!e.ctrlKey) return;
  if (key === "q") { e.preventDefault(); saveAll(); if (core) core.invoke("quit_app"); }
  else if (/^[1-9]$/.test(key)) { e.preventDefault(); const t = tabs[Number(key) - 1]; if (t) showTab(t.id); }
  else if (key === "tab") { e.preventDefault(); showTab(tabs[(tabs.indexOf(current) + (e.shiftKey ? -1 : 1) + tabs.length) % tabs.length].id); }
  else if (key === "n") { e.preventDefault(); openTabDialog(); }
  else if (key === "e" && current.type === "text") { e.preventDefault(); setNotesEditing(mdEditor.hidden); }
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
applyFontSize();
$("native-wayland").checked = settings.nativeWayland;
applyNotation();
$("pin").disabled = settings.nativeWayland;
if (settings.nativeWayland) $("pin").title = "Non disponibile in modalità Wayland nativa (vedi Impostazioni)";
if (settings.alwaysOnTop && !settings.nativeWayland) setAlwaysOnTop(true, false);

await loadTabs();
showTab(settings.tab);
