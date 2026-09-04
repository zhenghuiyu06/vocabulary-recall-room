import { jsPDF } from "jspdf";

export type VocabularyPdfCandidate = {
  word: string;
  meaning: string;
  familiarStreak: number;
  lastRating: "familiar" | "fuzzy" | "unknown" | null;
  reviewCount: number;
};

export type WeakVocabularyPdfEntry = VocabularyPdfCandidate & {
  status: string;
};

export type PdfCanvasFactory = (
  width: number,
  height: number,
) => HTMLCanvasElement;

const DESIGN_WIDTH = 595;
const DESIGN_HEIGHT = 842;
const CANVAS_SCALE = 2;
const MARGIN = 28;
const CONTENT_WIDTH = DESIGN_WIDTH - MARGIN * 2;
const TABLE_GAP = 12;
const TABLE_WIDTH = (CONTENT_WIDTH - TABLE_GAP) / 2;
const CELL_WIDTHS = [24, 88, TABLE_WIDTH - 24 - 88];
const FIRST_TABLE_TOP = 108;
const FIRST_ROWS_TOP = FIRST_TABLE_TOP + 22;
const CONTINUATION_TABLE_TOP = 67;
const CONTINUATION_ROWS_TOP = CONTINUATION_TABLE_TOP + 22;
const ROWS_BOTTOM = 807;
const COLORS = {
  ink: "#15263a",
  muted: "#667386",
  paper: "#fffdf8",
  cream: "#f5f0e6",
  line: "#ded8ca",
  navy: "#16324f",
  orange: "#e8733f",
  orangeSoft: "#fff0e8",
  green: "#397a64",
  greenSoft: "#e8f4ee",
  yellow: "#b47b18",
  yellowSoft: "#fff6d9",
  red: "#b94f47",
  redSoft: "#fbeae7",
};
const RATING_PRIORITY: Record<string, number> = {
  unknown: 0,
  fuzzy: 1,
  new: 2,
  familiar: 3,
};

function statusFor(candidate: VocabularyPdfCandidate): string {
  if (candidate.lastRating === "unknown") return "不会";
  if (candidate.lastRating === "fuzzy") return "模糊";
  if (candidate.lastRating === "familiar") {
    return `熟悉 x ${Math.max(1, candidate.familiarStreak)}`;
  }
  return "未回忆";
}

export function selectWeakVocabularyEntries(
  candidates: VocabularyPdfCandidate[],
): WeakVocabularyPdfEntry[] {
  return candidates
    .filter((candidate) => candidate.familiarStreak < 3)
    .map((candidate) => ({ ...candidate, status: statusFor(candidate) }))
    .sort((left, right) => {
      const leftKey = left.lastRating ?? "new";
      const rightKey = right.lastRating ?? "new";
      return (
        RATING_PRIORITY[leftKey] - RATING_PRIORITY[rightKey] ||
        left.word.localeCompare(right.word, "en")
      );
    });
}

function setFont(
  context: CanvasRenderingContext2D,
  fontFamily: string,
  size: number,
) {
  context.font = `${size}px "${fontFamily}", sans-serif`;
}

function wrapText(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [""];
  const lines: string[] = [];
  let line = "";

  for (const character of [...normalized]) {
    const candidate = `${line}${character}`;
    if (!line || context.measureText(candidate).width <= maxWidth) {
      line = candidate;
      continue;
    }
    lines.push(line.trimEnd());
    line = character.trimStart();
  }
  if (line) lines.push(line.trimEnd());
  return lines;
}

function meaningLines(
  context: CanvasRenderingContext2D,
  entry: WeakVocabularyPdfEntry,
  fontFamily: string,
): string[] {
  setFont(context, fontFamily, 8);
  return wrapText(context, entry.meaning, CELL_WIDTHS[2] - 12);
}

function rowHeight(
  context: CanvasRenderingContext2D,
  entry: WeakVocabularyPdfEntry,
  fontFamily: string,
): number {
  return Math.max(24, 7 + meaningLines(context, entry, fontFamily).length * 9.8);
}

function createDrawingSurface(
  canvasFactory: PdfCanvasFactory,
): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D } {
  const canvas = canvasFactory(
    DESIGN_WIDTH * CANVAS_SCALE,
    DESIGN_HEIGHT * CANVAS_SCALE,
  );
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas");
  context.scale(CANVAS_SCALE, CANVAS_SCALE);
  context.textBaseline = "alphabetic";
  context.lineJoin = "round";
  return { canvas, context };
}

function paginateEntries(
  entries: WeakVocabularyPdfEntry[],
  context: CanvasRenderingContext2D,
  fontFamily: string,
): Array<[WeakVocabularyPdfEntry[], WeakVocabularyPdfEntry[]]> {
  const pages: Array<[WeakVocabularyPdfEntry[], WeakVocabularyPdfEntry[]]> = [];
  let entryIndex = 0;

  while (entryIndex < entries.length) {
    const page: [WeakVocabularyPdfEntry[], WeakVocabularyPdfEntry[]] = [[], []];
    const rowsTop = pages.length === 0 ? FIRST_ROWS_TOP : CONTINUATION_ROWS_TOP;

    for (let tableIndex = 0; tableIndex < 2; tableIndex += 1) {
      let cursorY = rowsTop;
      while (entryIndex < entries.length) {
        const entry = entries[entryIndex];
        const height = rowHeight(context, entry, fontFamily);
        if (page[tableIndex].length > 0 && cursorY + height > ROWS_BOTTOM) break;
        page[tableIndex].push(entry);
        entryIndex += 1;
        cursorY += height;
      }
    }
    pages.push(page);
  }

  const finalPage = pages.at(-1);
  if (finalPage) {
    const combined = [...finalPage[0], ...finalPage[1]];
    const rowsTop = pages.length === 1 ? FIRST_ROWS_TOP : CONTINUATION_ROWS_TOP;
    const capacity = ROWS_BOTTOM - rowsTop;
    let bestSplit = finalPage[0].length;
    let smallestDifference = Number.POSITIVE_INFINITY;
    for (let splitIndex = 1; splitIndex < combined.length; splitIndex += 1) {
      const leftHeight = combined
        .slice(0, splitIndex)
        .reduce((sum, entry) => sum + rowHeight(context, entry, fontFamily), 0);
      const rightHeight = combined
        .slice(splitIndex)
        .reduce((sum, entry) => sum + rowHeight(context, entry, fontFamily), 0);
      const difference = Math.abs(leftHeight - rightHeight);
      if (
        leftHeight <= capacity &&
        rightHeight <= capacity &&
        difference < smallestDifference
      ) {
        bestSplit = splitIndex;
        smallestDifference = difference;
      }
    }
    finalPage[0] = combined.slice(0, bestSplit);
    finalPage[1] = combined.slice(bestSplit);
  }
  return pages;
}

function drawBasePage(
  context: CanvasRenderingContext2D,
  fontFamily: string,
) {
  context.fillStyle = COLORS.paper;
  context.fillRect(0, 0, DESIGN_WIDTH, DESIGN_HEIGHT);
  context.fillStyle = COLORS.orange;
  context.fillRect(0, 0, DESIGN_WIDTH, 7);
  setFont(context, fontFamily, 8);
}

function drawFirstPageHeader(
  context: CanvasRenderingContext2D,
  entries: WeakVocabularyPdfEntry[],
  fontFamily: string,
  generatedAt: Date,
) {
  context.fillStyle = COLORS.navy;
  setFont(context, fontFamily, 20);
  context.fillText("待加强词汇", MARGIN, 43);

  context.fillStyle = COLORS.muted;
  setFont(context, fontFamily, 9);
  context.fillText(`看英文 - 回忆中文释义 · 共 ${entries.length} 词`, MARGIN, 63);
  const date = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(generatedAt);
  setFont(context, fontFamily, 8);
  context.fillText(
    date,
    DESIGN_WIDTH - MARGIN - context.measureText(date).width,
    63,
  );

  context.fillStyle = COLORS.orangeSoft;
  context.strokeStyle = "#f4c3aa";
  context.lineWidth = 0.5;
  context.fillRect(MARGIN, 76, CONTENT_WIDTH, 22);
  context.strokeRect(MARGIN, 76, CONTENT_WIDTH, 22);
  context.fillStyle = COLORS.ink;
  setFont(context, fontFamily, 7.8);
  context.fillText(
    "已排除连续“熟悉”次数 >= 3 的单词。建议遮住中文，先回忆，再核对。",
    MARGIN + 10,
    91,
  );
}

function drawContinuationHeader(
  context: CanvasRenderingContext2D,
  entries: WeakVocabularyPdfEntry[],
  fontFamily: string,
) {
  context.fillStyle = COLORS.navy;
  setFont(context, fontFamily, 13);
  context.fillText("待加强词汇", MARGIN, 39);
  context.fillStyle = COLORS.muted;
  setFont(context, fontFamily, 8);
  context.fillText(`共 ${entries.length} 词 · 看英文，回忆中文`, MARGIN, 56);
}

function drawTableHeader(
  context: CanvasRenderingContext2D,
  topY: number,
  fontFamily: string,
  tableX: number,
) {
  context.fillStyle = COLORS.navy;
  context.fillRect(tableX, topY, TABLE_WIDTH, 22);
  context.fillStyle = COLORS.paper;
  setFont(context, fontFamily, 8.2);
  const starts = [
    tableX,
    tableX + CELL_WIDTHS[0],
    tableX + CELL_WIDTHS[0] + CELL_WIDTHS[1],
  ];
  const labels = ["序", "英文单词", "中文释义"];
  labels.forEach((label, index) => {
    context.fillText(label, starts[index] + (index === 0 ? 8 : 6), topY + 15);
  });
}

function drawRow(
  context: CanvasRenderingContext2D,
  entry: WeakVocabularyPdfEntry,
  number: number,
  topY: number,
  fontFamily: string,
  alternate: boolean,
  tableX: number,
): number {
  const lines = meaningLines(context, entry, fontFamily);
  const height = Math.max(24, 7 + lines.length * 9.8);
  const starts = [
    tableX,
    tableX + CELL_WIDTHS[0],
    tableX + CELL_WIDTHS[0] + CELL_WIDTHS[1],
  ];
  if (alternate) {
    context.fillStyle = "#fcfaf5";
    context.fillRect(tableX, topY, TABLE_WIDTH, height);
  }
  context.strokeStyle = COLORS.line;
  context.lineWidth = 0.45;
  context.beginPath();
  context.moveTo(tableX, topY + height);
  context.lineTo(tableX + TABLE_WIDTH, topY + height);
  context.stroke();
  context.lineWidth = 0.3;
  starts.slice(1).forEach((x) => {
    context.beginPath();
    context.moveTo(x, topY);
    context.lineTo(x, topY + height);
    context.stroke();
  });

  context.fillStyle = COLORS.muted;
  setFont(context, fontFamily, 7.2);
  context.fillText(String(number), starts[0] + 7, topY + height / 2 + 2.5);

  context.fillStyle = COLORS.navy;
  let wordSize = 9.4;
  setFont(context, fontFamily, wordSize);
  while (
    wordSize > 7.2 &&
    context.measureText(entry.word).width > CELL_WIDTHS[1] - 12
  ) {
    wordSize -= 0.4;
    setFont(context, fontFamily, wordSize);
  }
  context.fillText(entry.word, starts[1] + 6, topY + height / 2 + 3.1);

  context.fillStyle = COLORS.ink;
  setFont(context, fontFamily, 8);
  const meaningStartY = topY + (height - lines.length * 9.8) / 2 + 7.5;
  lines.forEach((line, lineIndex) => {
    context.fillText(line, starts[2] + 6, meaningStartY + lineIndex * 9.8);
  });
  return topY + height;
}

export function renderWeakVocabularyPageImages(
  entries: WeakVocabularyPdfEntry[],
  canvasFactory: PdfCanvasFactory,
  fontFamily: string,
  generatedAt = new Date(),
): string[] {
  const measuringSurface = createDrawingSurface(canvasFactory);
  const pageEntries = paginateEntries(
    entries,
    measuringSurface.context,
    fontFamily,
  );

  let runningNumber = 1;
  return pageEntries.map((tables, pageIndex) => {
    const { canvas, context } = createDrawingSurface(canvasFactory);
    drawBasePage(context, fontFamily);
    const tableTop = pageIndex === 0 ? FIRST_TABLE_TOP : CONTINUATION_TABLE_TOP;
    const rowsTop = pageIndex === 0 ? FIRST_ROWS_TOP : CONTINUATION_ROWS_TOP;
    if (pageIndex === 0) {
      drawFirstPageHeader(context, entries, fontFamily, generatedAt);
    } else {
      drawContinuationHeader(context, entries, fontFamily);
    }
    tables.forEach((words, tableIndex) => {
      const tableX = MARGIN + tableIndex * (TABLE_WIDTH + TABLE_GAP);
      drawTableHeader(context, tableTop, fontFamily, tableX);
      let cursorY = rowsTop;
      words.forEach((entry, rowIndex) => {
        cursorY = drawRow(
          context,
          entry,
          runningNumber,
          cursorY,
          fontFamily,
          rowIndex % 2 === 1,
          tableX,
        );
        runningNumber += 1;
      });
    });

    const footer = `词汇回忆室 · 连续熟悉次数 < 3 · ${pageIndex + 1} / ${pageEntries.length}`;
    context.fillStyle = COLORS.muted;
    setFont(context, fontFamily, 7.5);
    context.fillText(
      footer,
      (DESIGN_WIDTH - context.measureText(footer).width) / 2,
      823,
    );
    return canvas.toDataURL("image/jpeg", 0.9);
  });
}

export function assembleWeakVocabularyPdf(
  pageImages: string[],
  generatedAt = new Date(),
): ArrayBuffer {
  const pdf = new jsPDF({
    orientation: "portrait",
    unit: "mm",
    format: "a4",
    compress: true,
  });
  pdf.setProperties({
    title: "待加强词汇",
    subject: "连续熟悉次数少于 3 的复习词汇",
    author: "词汇回忆室",
    creator: "词汇回忆室",
    keywords: "英语, 词汇, 间隔复习, 待加强",
  });
  pdf.setCreationDate(generatedAt);
  pdf.setLanguage("zh-CN");
  pageImages.forEach((image, index) => {
    if (index > 0) pdf.addPage("a4", "portrait");
    pdf.addImage(image, "JPEG", 0, 0, 210, 297, undefined, "FAST");
  });
  return pdf.output("arraybuffer");
}

export async function createWeakVocabularyPdf(
  entries: WeakVocabularyPdfEntry[],
  fontBytes: ArrayBuffer,
  generatedAt = new Date(),
): Promise<ArrayBuffer> {
  const fontFamily = `VocabularyPdfCJK-${Date.now()}`;
  const fontFace = new FontFace(fontFamily, fontBytes);
  await fontFace.load();
  document.fonts.add(fontFace);
  try {
    await document.fonts.ready;
    const images = renderWeakVocabularyPageImages(
      entries,
      (width, height) => {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        return canvas;
      },
      fontFamily,
      generatedAt,
    );
    return assembleWeakVocabularyPdf(images, generatedAt);
  } finally {
    document.fonts.delete(fontFace);
  }
}
