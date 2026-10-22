// Test del motore: npm test
import { evaluateDocument } from "../src/engine.js";

const cases = [
  ["1.250,50 + 749,50", "2.000"],
  ["pizza = 24,90", "24,9"],
  ["20 inch to cm", "50,8 cm"],
  ["20 inch in cm", "50,8 cm"],
  ["120 - 10%", "108"],
  ["100 + 22%", "122"],
  ["10% di 200", "20"],
  ["3 x 4", "12"],
  ["10 per 3", "30"],
  ["100 diviso 8", "12,5"],
  ["round(7,456; 2)", "7,46"],
  ["sqrt(144) * 2", "24"],
  ["1.000.000 * 2", "2.000.000"],
  ["999 + 1", "1.000"],
  ["-1234,5", "-1.234,5"],
  ["2 / 3", "0,666667"],
  ["Affitto: 850", "850"],
  ["Spesa del weekend", null],
  ["# commento 2 + 2", null],
  ["day", null],
  ["ciao come stai", null],
  ["20 _mele_ + 30 _pere_", "50"],
  ["_solo una nota_", null],
  ["costo_totale = 12", "12"],
  ["3 _kg_ * 2,5 _€/kg_", "7,5"],
];

let failed = 0;
for (const [input, expected] of cases) {
  const [{ result }] = evaluateDocument(input);
  const ok = result === expected;
  if (!ok) failed++;
  console.log(`${ok ? "✓" : "✗"} ${input.padEnd(22)} → ${result}${ok ? "" : `  (atteso: ${expected})`}`);
}

// Blocchi: totale, media, prev
const doc = ["Spesa", "pane = 3", "latte = 1,5", "uova = 4,5", "totale", "media", "", "10", "prev * 2", "", "pizza = 24,90", "pizza * 3"].join("\n");
const r = evaluateDocument(doc).map((x) => x.result);
const exp = [null, "3", "1,5", "4,5", "9", "3", null, "10", "20", null, "24,9", "74,7"];
const okDoc = JSON.stringify(r) === JSON.stringify(exp);
if (!okDoc) failed++;
console.log(`${okDoc ? "✓" : "✗"} blocco totale/media/prev → ${JSON.stringify(r)}`);

// Richiami @N: numerazione progressiva delle sole righe di calcolo, aggiornamento dinamico
const refDoc = ["Mele", "20 _mele_ + 30 _pere_", "testo", "@1 * 2", "@2 + @1", "@9 + 1", "Affitto: 850", "@4 x 12"].join("\n");
const rr = evaluateDocument(refDoc);
const got = rr.map((x) => (x.result ? `@${x.ref}=${x.result}` : null));
const expRef = [null, "@1=50", null, "@2=100", "@3=150", null, "@4=850", "@5=10.200"];
const okRef = JSON.stringify(got) === JSON.stringify(expRef);
if (!okRef) failed++;
console.log(`${okRef ? "✓" : "✗"} richiami @N → ${JSON.stringify(got)}`);
const changed = evaluateDocument(refDoc.replace("20 _mele_", "40 _mele_")).map((x) => x.result);
const okDyn = changed[4] === "210";
if (!okDyn) failed++;
console.log(`${okDyn ? "✓" : "✗"} aggiornamento dinamico (@2 + @1 dopo modifica) → ${changed[4]}`);

// Notazione anglosassone: virgola per le migliaia, punto per i decimali
const enCases = [
  ["1,250.50 + 749.50", "2,000"],
  ["1,000,000 * 2", "2,000,000"],
  ["2 / 3", "0.666667"],
  ["120 - 10%", "108"],
  ["round(7.456, 2)", "7.46"],
  ["round(7.456; 2)", "7.46"],
  ["20 inch in cm", "50.8 cm"],
  ["1234.5 x 2", "2,469"],
];
for (const [input, expected] of enCases) {
  const [{ result }] = evaluateDocument(input, { notation: "en" });
  const ok = result === expected;
  if (!ok) failed++;
  console.log(`${ok ? "✓" : "✗"} [en] ${input.padEnd(20)} → ${result}${ok ? "" : `  (atteso: ${expected})`}`);
}

console.log(failed ? `\n${failed} test falliti` : "\nTutti i test superati");
process.exit(failed ? 1 : 0);
