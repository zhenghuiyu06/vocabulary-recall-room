import { mkdir, writeFile } from "node:fs/promises";
import { GlobalFonts, createCanvas } from "/Users/yuzhenghui/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/@napi-rs/canvas/index.js";
import { vocabulary } from "../app/vocabulary";
import {
  assembleWeakVocabularyPdf,
  renderWeakVocabularyPageImages,
  selectWeakVocabularyEntries,
  type VocabularyPdfCandidate,
} from "../app/vocabulary-pdf";

const fontUrl =
  "https://cdn.jsdelivr.net/npm/@fontsource/noto-sans-sc@5.2.8/files/noto-sans-sc-chinese-simplified-400-normal.woff2";
const outputPath = new URL("../output/pdf/待加强词汇-样张.pdf", import.meta.url);

const ratings: VocabularyPdfCandidate["lastRating"][] = [
  "unknown",
  "fuzzy",
  null,
  "familiar",
  "familiar",
];
const candidates = vocabulary.map((entry, index) => ({
  word: entry.word,
  meaning: entry.meaning,
  lastRating: ratings[index % ratings.length],
  familiarStreak: index % ratings.length >= 3 ? (index % 2) + 1 : 0,
  reviewCount: index % 6,
}));

const response = await fetch(fontUrl);
if (!response.ok) throw new Error(`Font request failed: ${response.status}`);
const entries = selectWeakVocabularyEntries(candidates);
const generatedAt = new Date("2026-09-02T10:00:00+08:00");
const fontBytes = Buffer.from(await response.arrayBuffer());
const fontFamily = "VocabularyPdfCJK";
if (!GlobalFonts.register(fontBytes, fontFamily)) {
  throw new Error("Unable to register the PDF sample font");
}
const images = renderWeakVocabularyPageImages(
  entries,
  (width, height) => createCanvas(width, height) as unknown as HTMLCanvasElement,
  fontFamily,
  generatedAt,
);
const pdf = assembleWeakVocabularyPdf(images, generatedAt);

await mkdir(new URL("../output/pdf/", import.meta.url), { recursive: true });
await writeFile(outputPath, new Uint8Array(pdf));
console.log(outputPath.pathname);
