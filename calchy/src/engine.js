// Motore di calcolo di Calchy: riceve tutto il testo e restituisce,
// riga per riga, il risultato da mostrare (oppure null se la riga è testo).
import { create, all } from "mathjs";

const math = create(all);

// Parole che, da sole su una riga, sommano o mediano i risultati del blocco
// (un blocco finisce con una riga vuota).
const SUM_WORDS = new Set(["totale", "somma", "total", "sum"]);
const AVG_WORDS = new Set(["media", "average", "avg"]);
// Parole che richiamano il risultato della riga precedente
const PREV_RE = /\b(prev|prec|precedente)\b/gi;

// Note dentro un calcolo: "20 _mele_ + 30 _pere_". L'underscore deve aprirsi dopo
// uno spazio, un numero o una parentesi, così i nomi tipo "costo_totale" funzionano ancora.
export const NOTE_RE = /(^|[\s\d)])_([^_\n]+)_(?=[\s+\-*/^)=,;%]|$)/g;
// Richiamo del risultato di una riga di calcolo: @1, @2, ...
export const REF_RE = /(^|[^\w@])@(\d+)(?!\d)/g;

/** Toglie le note _..._ lasciando uno spazio al loro posto */
export function togliNote(expr) {
  return expr.replace(NOTE_RE, "$1 ");
}

/**
 * Notazione dei numeri:
 *  "eu" (europea):      1.234,56  -> punto per le migliaia, virgola per i decimali
 *  "en" (anglosassone): 1,234.56  -> virgola per le migliaia, punto per i decimali
 */
const SEPARATORS = {
  eu: { thousands: ".", decimal: "," },
  en: { thousands: ",", decimal: "." },
};

/** Traduce i numeri scritti dall'utente nella notazione di mathjs (1234.56) */
export function normalizza(expr, notation = "eu") {
  if (notation === "en") {
    return expr
      .replace(/(\d),(?=\d{3}(?!\d))/g, "$1") // virgola delle migliaia
      .replace(/;/g, ","); // il ; separa gli argomenti delle funzioni
  }
  return expr
    .replace(/(\d)\.(?=\d{3}(?!\d))/g, "$1") // punto delle migliaia
    .replace(/(\d),(?=\d)/g, "$1.") // virgola decimale
    .replace(/;/g, ","); // il ; separa gli argomenti delle funzioni
}

/** Parole italiane e scorciatoie stile Numi -> sintassi di mathjs */
export function traduci(expr) {
  return expr
    // "10% di 200" / "10% of 200" -> (10/100) * 200
    .replace(/(\d+(?:\.\d+)?)\s*%\s*(?:di|del|della|dello|dei|degli|delle|of)\b/gi, "($1 / 100) *")
    .replace(/(\d|\))\s*[x×]\s*(?=[\d(])/g, "$1 * ") // 3 x 4
    .replace(/\bper\b/gi, "*")
    .replace(/\bdiviso\b/gi, "/")
    .replace(/\b(più|piu)\b/gi, "+")
    .replace(/\bmeno\b/gi, "-")
    .replace(/÷/g, "/");
}

/** Numero nella notazione scelta: 1234567.891 -> "1.234.567,891" (eu) o "1,234,567.891" (en) */
export function formatNumber(n, notation = "eu") {
  const sep = SEPARATORS[notation] ?? SEPARATORS.eu;
  if (!Number.isFinite(n)) return n > 0 ? "∞" : n < 0 ? "-∞" : null;
  const abs = Math.abs(n);
  if (abs !== 0 && (abs < 1e-6 || abs >= 1e15)) {
    return n.toExponential(6).replace(/\.?0+e/, "e").replace(".", sep.decimal);
  }
  // Arrotonda a 6 decimali e toglie gli zeri finali
  const [int, dec] = Math.abs(n).toFixed(6).replace(/\.?0+$/, "").split(".");
  const sign = n < 0 && (int !== "0" || dec) ? "-" : "";
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, sep.thousands); // separatore ogni 3 cifre
  return sign + grouped + (dec ? sep.decimal + dec : "");
}

function isShowable(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === "number") return true;
  if (math.isBigNumber(value) || math.isFraction(value) || math.isComplex(value)) return true;
  // Un'unità "nuda" (es. una riga con scritto solo "m" o "day") non è un calcolo
  if (math.isUnit(value)) return value.value !== null;
  return false;
}

export function formatValue(value, notation = "eu") {
  if (typeof value === "number") return formatNumber(value, notation);
  if (math.isBigNumber(value) || math.isFraction(value)) return formatNumber(Number(value), notation);
  // Unità e complessi: formatta i numeri contenuti nella stringa
  return math
    .format(value, { precision: 10 })
    .replace(/-?\d+(\.\d+)?(e[+-]?\d+)?/g, (n) => formatNumber(parseFloat(n), notation));
}

/**
 * Valuta l'intero documento.
 * Ogni riga di calcolo riceve un numero progressivo (ref): 1, 2, 3...
 * che si può richiamare più sotto scrivendo @1, @2...
 * @param {{ notation?: "eu" | "en" }} options notazione dei numeri
 * @returns {{ result: string|null, isCalc: boolean, ref: number|null }[]} una voce per riga
 */
export function evaluateDocument(text, { notation = "eu" } = {}) {
  const scope = new Map();
  let refCount = 0;
  let block = []; // risultati del blocco corrente, per totale/media
  let prev;

  return text.split("\n").map((rawLine) => {
    const TEXT = { result: null, isCalc: false, ref: null };
    if (rawLine.trim() === "") {
      block = [];
      return TEXT;
    }
    // Commenti
    const trimmed = rawLine.trim();
    if (trimmed.startsWith("#") || trimmed.startsWith("//")) return TEXT;

    let line = togliNote(rawLine).trim();
    if (line === "") return TEXT;

    // Etichette: "Affitto: 850" -> calcola solo "850"
    const label = line.match(/^([^:=\d][^:=]*?):\s*(.*)$/);
    if (label) {
      line = label[2];
      if (line === "") return TEXT;
    }

    let value;
    const word = line.toLowerCase();
    try {
      if (SUM_WORDS.has(word) || AVG_WORDS.has(word)) {
        if (block.length === 0) return TEXT;
        value = block.reduce((a, b) => math.add(a, b));
        if (AVG_WORDS.has(word)) value = math.divide(value, block.length);
      } else {
        // @3 -> variabile interna __r3 (se la riga 3 non esiste, la riga resta testo)
        let expr = traduci(normalizza(line.replace(REF_RE, "$1__r$2"), notation));
        if (prev !== undefined) {
          scope.set("__prev", prev);
          expr = expr.replace(PREV_RE, "__prev");
        }
        value = math.evaluate(expr, scope);
      }
    } catch {
      return TEXT; // non è un calcolo: è testo
    }

    if (!isShowable(value)) return TEXT;
    const result = formatValue(value, notation);
    if (result === null) return TEXT;

    prev = value;
    if (!SUM_WORDS.has(word) && !AVG_WORDS.has(word)) block.push(value);
    const ref = ++refCount;
    scope.set(`__r${ref}`, value);
    return { result, isCalc: true, ref };
  });
}
