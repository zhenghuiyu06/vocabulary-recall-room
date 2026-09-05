import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import {
  countOcrTicks,
  parseOcrText,
  prioritizeExamMeaning,
} from "../app/photo-vocabulary.ts";

const root = new URL("../", import.meta.url);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("renders the vocabulary recall app shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>词汇回忆室｜英语间隔复习<\/title>/i);
  assert.match(html, /正在打开你的词库/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i);
});

test("ships the complete merged vocabulary and fixed review schedule", async () => {
  const [page, vocabulary] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/vocabulary.ts", root), "utf8"),
  ]);

  const entries = [...vocabulary.matchAll(/^\s*\["[a-z-]+",\s*"/gm)];
  assert.equal(entries.length, 213);
  assert.match(vocabulary, /\["manuscript", "n\. 手稿，原稿"\]/);
  assert.match(vocabulary, /\["deplete", "v\. 耗尽，消耗"\]/);
  assert.match(vocabulary, /\["arbitrary", "adj\. 武断的；任意的"\]/);
  assert.match(vocabulary, /\["slot", "n\. 时间空档；职位；狭槽"\]/);
  assert.match(vocabulary, /\["portray", "v\. 描绘；描述"\]/);
  assert.match(vocabulary, /\["discrete", "adj\. 离散的；分离的"\]/);
  assert.match(vocabulary, /\["discreet", "adj\. 谨慎的；慎重的"\]/);
  assert.doesNotMatch(vocabulary, /portary/i);
  assert.match(page, /12 \* HOUR/);
  assert.match(page, /3 \* 24 \* HOUR/);
  assert.match(page, /7 \* 24 \* HOUR/);
  assert.match(page, /localStorage\.setItem/);
  assert.match(page, /parseVocabularyCsv/);
});

test("bundles local Chinese and English photo OCR", async () => {
  const [page, packageJson, dictionaryText] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("package.json", root), "utf8"),
    readFile(new URL("public/dictionary/ecdict-exam.json", root), "utf8"),
    access(new URL("public/tesseract/worker.min.js", root)),
    access(new URL("public/tesseract-core/tesseract-core-lstm.wasm.js", root)),
    access(
      new URL("public/tesseract-core/tesseract-core-simd-lstm.wasm.js", root),
    ),
    access(new URL("public/tessdata/eng.traineddata.gz", root)),
    access(new URL("public/tessdata/chi_sim.traineddata.gz", root)),
    access(new URL("public/dictionary/NOTICE-ECDICT.txt", root)),
  ]);

  assert.match(packageJson, /"tesseract\.js": "\^6\.0\.1"/);
  assert.match(page, /拍照识别词表/);
  assert.match(page, /createWorker\(\["eng", "chi_sim"\]/);
  assert.match(page, /workerPath: "\/tesseract\/worker\.min\.js"/);
  assert.match(page, /langPath: "\/tessdata"/);
  assert.match(page, /照片只在当前浏览器中处理/);
  assert.match(page, /loadLocalDictionary/);
  assert.match(page, /正在自动补全中文释义/);

  const dictionary = JSON.parse(dictionaryText);
  assert.ok(Object.keys(dictionary).length >= 37_000);
  assert.match(dictionary.manuscript, /手稿/);
  assert.match(dictionary.photosynthesis, /光合作用/);
});

test("reviews photographed tick counts before routing words", async () => {
  const [page, photoParser] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/photo-vocabulary.ts", root), "utf8"),
  ]);

  assert.equal(countOcrTicks("acute  ✓ ✓"), 2);
  assert.equal(countOcrTicks("repel v. 排斥"), 0);
  assert.equal(countOcrTicks("slot  V | V"), 2);
  const [candidate] = parseOcrText("1. acute adj. 严重的；急性的 ✓✓");
  assert.equal(candidate.word, "acute");
  assert.equal(candidate.tickCount, 2);
  assert.equal(candidate.meaning, "adj. 严重的；急性的");
  const prioritized = prioritizeExamMeaning(
    "vt. 放弃, 抛弃, 遗弃, 使屈从；[医] 院禁；n. 放任, 无拘束, 狂热",
  );
  assert.equal(prioritized, "v. 放弃；抛弃；遗弃 n. 放任；无拘束；狂热");
  assert.match(photoParser, /countOcrTicks/);
  assert.match(page, /candidate\.tickCount >= 2/);
  assert.match(page, /移入长期记忆/);
  assert.match(page, /继续复习/);
  assert.match(page, /处理并导出 PDF/);
  assert.match(page, /照片新增待复习词汇-/);
  assert.match(page, /restoreMasteredWord/);
  assert.match(photoParser, /prioritizeExamMeaning/);
});

test("keeps session history and offers mistake-only review", async () => {
  const page = await readFile(new URL("app/page.tsx", root), "utf8");

  assert.match(page, /sessionHistory/);
  assert.match(page, /学习记录/);
  assert.match(page, /近 7 天/);
  assert.match(page, /只复习本轮错词/);
  assert.match(page, /开始错词专项/);
  assert.match(page, /总体掌握/);
});

test("protects progress from accidental ratings", async () => {
  const page = await readFile(new URL("app/page.tsx", root), "utf8");

  assert.match(page, /撤销上一题/);
  assert.match(page, /重新巩固/);
  assert.match(page, /Date\.now\(\) - revealStartedAt\.current < 1000/);
  assert.match(page, /防误触：答案显示 1 秒后才启用数字键/);
});

test("graduates only durable recalls into the long-term memory library", async () => {
  const page = await readFile(new URL("app/page.tsx", root), "utf8");

  assert.match(page, /familiarStreak/);
  assert.match(page, /familiarStreak >= 3/);
  assert.match(page, /step >= REVIEW_INTERVALS\.length/);
  assert.match(page, /data\.progress\[id\]\.step < 5/);
  assert.match(page, /长期记忆库/);
  assert.match(page, /通过 7D/);
  assert.match(page, /连续熟悉 × 3/);
  assert.match(page, /一次“模糊”或“不会”都会中断连续记录/);
});

test("exports a Chinese PDF containing only words below three familiar recalls", async () => {
  const [page, pdfBuilder] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/vocabulary-pdf.ts", root), "utf8"),
  ]);

  assert.match(page, /导出待加强 PDF/);
  assert.match(page, /familiarStreak < 3/);
  assert.match(page, /cdn\.jsdelivr\.net\/npm\/@fontsource\/noto-sans-sc/);
  assert.match(pdfBuilder, /candidate\.familiarStreak < 3/);
  assert.match(pdfBuilder, /待加强词汇/);
  assert.doesNotMatch(pdfBuilder, /考研/);
  assert.match(pdfBuilder, /中文释义/);
  assert.match(pdfBuilder, /const TABLE_GAP = 12/);
  assert.match(pdfBuilder, /const labels = \["序", "英文单词", "中文释义"\]/);
  assert.doesNotMatch(pdfBuilder, /当前状态/);
});
