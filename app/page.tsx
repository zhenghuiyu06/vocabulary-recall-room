"use client";

import {
  type CSSProperties,
  type ChangeEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { vocabulary, type VocabularyEntry } from "./vocabulary";

type Rating = "familiar" | "fuzzy" | "unknown";

type ReviewEvent = {
  at: string;
  rating: Rating;
  step: number;
};

type WordProgress = {
  step: number;
  nextDue: number | null;
  lastRating: Rating | null;
  reviewCount: number;
  familiarStreak: number;
  history: ReviewEvent[];
};

type SessionCard = {
  id: string;
  retry: boolean;
};

type SessionRating = {
  id: string;
  at: string;
  rating: Rating;
};

type StudySession = {
  queue: SessionCard[];
  index: number;
  startedAt: number;
  kind: "due" | "all" | "mistakes";
  ratings: SessionRating[];
};

type SessionHistoryEntry = {
  id: string;
  startedAt: number;
  endedAt: number;
  kind: StudySession["kind"];
  ratings: SessionRating[];
  mistakeIds: string[];
};

type AppData = {
  version: 3;
  dictionary: VocabularyEntry[];
  progress: Record<string, WordProgress>;
  session: StudySession | null;
  sessionHistory: SessionHistoryEntry[];
};

type LastAction = {
  data: AppData;
  word: string;
  rating: Rating;
};

type OcrCandidate = {
  id: string;
  word: string;
  meaning: string;
  selected: boolean;
  source: "photo" | "existing" | "dictionary" | "manual" | "missing";
};

type OcrState = "idle" | "reading" | "review" | "error";

const STORAGE_KEY = "kaoyan-vocabulary-recall-v1";
const HOUR = 60 * 60 * 1000;
const REVIEW_INTERVALS = [12 * HOUR, 24 * HOUR, 3 * 24 * HOUR, 7 * 24 * HOUR];
const REVIEW_STEPS = ["初见", "12H", "1D", "3D", "7D"];
const RATING_LABELS: Record<Rating, string> = {
  familiar: "熟悉",
  fuzzy: "模糊",
  unknown: "不会",
};
const SESSION_KIND_LABELS: Record<StudySession["kind"], string> = {
  due: "到期复习",
  all: "自由回忆",
  mistakes: "错词专项",
};
const PDF_FONT_URL =
  "https://cdn.jsdelivr.net/npm/@fontsource/noto-sans-sc@5.2.8/files/noto-sans-sc-chinese-simplified-400-normal.woff2";
let localDictionaryPromise: Promise<Record<string, string>> | null = null;

function hasChinese(text: string): boolean {
  return /[\u3400-\u9fff]/.test(text);
}

function loadLocalDictionary(): Promise<Record<string, string>> {
  localDictionaryPromise ??= fetch("/dictionary/ecdict-exam.json", {
    cache: "force-cache",
  }).then((response) => {
    if (!response.ok) throw new Error("dictionary");
    return response.json() as Promise<Record<string, string>>;
  });
  return localDictionaryPromise;
}

function wordVariants(word: string): string[] {
  const variants = [word.toLowerCase()];
  if (word.endsWith("ies") && word.length > 4) variants.push(`${word.slice(0, -3)}y`);
  if (word.endsWith("ing") && word.length > 5) {
    variants.push(word.slice(0, -3), `${word.slice(0, -3)}e`);
  }
  if (word.endsWith("ed") && word.length > 4) {
    variants.push(word.slice(0, -2), `${word.slice(0, -1)}`);
  }
  if (word.endsWith("es") && word.length > 4) variants.push(word.slice(0, -2));
  if (word.endsWith("s") && word.length > 3) variants.push(word.slice(0, -1));
  return [...new Set(variants)];
}

function blankProgress(): WordProgress {
  return {
    step: 0,
    nextDue: 0,
    lastRating: null,
    reviewCount: 0,
    familiarStreak: 0,
    history: [],
  };
}

function trailingFamiliarCount(history: ReviewEvent[]): number {
  let count = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index]?.rating !== "familiar") break;
    count += 1;
  }
  return count;
}

function shuffle<T>(items: T[]): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[randomIndex]] = [result[randomIndex], result[index]];
  }
  return result;
}

function makeSession(ids: string[], kind: StudySession["kind"]): StudySession {
  return {
    queue: shuffle(ids).map((id) => ({ id, retry: false })),
    index: 0,
    startedAt: Date.now(),
    kind,
    ratings: [],
  };
}

function sanitizeDictionary(entries: unknown): VocabularyEntry[] {
  if (!Array.isArray(entries)) return [];

  const unique = new Map<string, VocabularyEntry>();
  entries.forEach((item) => {
    if (!item || typeof item !== "object") return;
    const record = item as Partial<VocabularyEntry>;
    const word = typeof record.word === "string" ? record.word.trim() : "";
    const meaning =
      typeof record.meaning === "string" ? record.meaning.trim() : "";
    if (!word || !meaning) return;
    const id = word.toLowerCase();
    unique.set(id, { id, word, meaning });
  });
  return [...unique.values()];
}

function normalizeData(raw?: (Partial<AppData> & { version?: number }) | null): AppData {
  const dictionaryMap = new Map(
    vocabulary.map((entry) => [entry.id, entry] as const),
  );
  sanitizeDictionary(raw?.dictionary).forEach((entry) => {
    dictionaryMap.set(entry.id, entry);
  });
  const dictionary = [...dictionaryMap.values()];
  const savedProgress = raw?.progress ?? {};
  const progress: Record<string, WordProgress> = {};

  dictionary.forEach((entry) => {
    const saved = savedProgress[entry.id];
    progress[entry.id] = saved
      ? {
          step: Math.max(0, Math.min(5, Number(saved.step) || 0)),
          nextDue:
            saved.nextDue === null ? null : Math.max(0, Number(saved.nextDue) || 0),
          lastRating:
            saved.lastRating && saved.lastRating in RATING_LABELS
              ? saved.lastRating
              : null,
          reviewCount: Math.max(0, Number(saved.reviewCount) || 0),
          familiarStreak: Math.max(
            0,
            Number(saved.familiarStreak) ||
              trailingFamiliarCount(
                Array.isArray(saved.history) ? saved.history : [],
              ),
          ),
          history: Array.isArray(saved.history) ? saved.history.slice(-50) : [],
        }
      : blankProgress();
  });

  const validIds = new Set(dictionary.map((entry) => entry.id));
  const session = raw?.session;
  const validSession =
    session &&
    Array.isArray(session.queue) &&
    session.queue.length > 0 &&
    session.index >= 0 &&
    session.index < session.queue.length
      ? {
          ...session,
          queue: session.queue.filter((item) => validIds.has(item.id)),
          kind:
            session.kind === "all" || session.kind === "mistakes"
              ? session.kind
              : "due",
          ratings: Array.isArray(session.ratings)
            ? session.ratings.filter(
                (item) =>
                  item &&
                  validIds.has(item.id) &&
                  item.rating in RATING_LABELS,
              )
            : [],
        }
      : null;

  const sessionHistory = Array.isArray(raw?.sessionHistory)
    ? raw.sessionHistory
        .filter(
          (item) =>
            item &&
            Number.isFinite(item.startedAt) &&
            Number.isFinite(item.endedAt) &&
            Array.isArray(item.ratings),
        )
        .map((item) => ({
          id: typeof item.id === "string" ? item.id : `session-${item.endedAt}`,
          startedAt: Number(item.startedAt),
          endedAt: Number(item.endedAt),
          kind:
            item.kind === "all" || item.kind === "mistakes"
              ? item.kind
              : "due" as const,
          ratings: item.ratings.filter(
            (rating) =>
              rating &&
              validIds.has(rating.id) &&
              rating.rating in RATING_LABELS,
          ),
          mistakeIds: Array.isArray(item.mistakeIds)
            ? item.mistakeIds.filter((id) => validIds.has(id))
            : [],
        }))
        .slice(0, 100)
    : [];

  return {
    version: 3,
    dictionary,
    progress,
    session:
      validSession && validSession.index < validSession.queue.length
        ? validSession
        : null,
    sessionHistory,
  };
}

function loadData(): AppData {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    return normalizeData(saved ? JSON.parse(saved) : null);
  } catch {
    return normalizeData();
  }
}

function dueIds(data: AppData, now = Date.now()): string[] {
  return data.dictionary
    .filter((entry) => {
      const progress = data.progress[entry.id];
      return progress.nextDue !== null && progress.nextDue <= now;
    })
    .map((entry) => entry.id);
}

function formatDue(timestamp: number | null): string {
  if (timestamp === null) return "长期记忆库";
  const difference = timestamp - Date.now();
  if (difference <= 0) return "现在可复习";
  const hours = Math.ceil(difference / HOUR);
  if (hours < 24) return `${hours} 小时后`;
  const days = Math.ceil(hours / 24);
  return `${days} 天后`;
}

function formatSessionDate(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}

function formatDuration(startedAt: number, endedAt: number): string {
  const minutes = Math.max(1, Math.round((endedAt - startedAt) / 60000));
  return minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

function formatMasteredAt(progress: WordProgress): string {
  for (let index = progress.history.length - 1; index >= 0; index -= 1) {
    if (progress.history[index].step >= 5) {
      return new Intl.DateTimeFormat("zh-CN", {
        year: "numeric",
        month: "numeric",
        day: "numeric",
      }).format(new Date(progress.history[index].at));
    }
  }
  return "已进入长期记忆";
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function parseCsvRow(line: string): string[] {
  const values: string[] = [];
  let value = "";
  let quoted = false;
  const delimiter = line.includes("\t") && !line.includes(",") ? "\t" : ",";

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === delimiter && !quoted) {
      values.push(value.trim());
      value = "";
    } else {
      value += character;
    }
  }
  values.push(value.trim());
  return values;
}

function parseVocabularyCsv(text: string): VocabularyEntry[] {
  const rows = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseCsvRow);

  if (!rows.length) return [];
  const header = rows[0].map((cell) => cell.toLowerCase());
  const hasHeader = header.includes("word") || header.includes("单词");
  const wordIndex = Math.max(0, header.findIndex((cell) => cell === "word" || cell === "单词"));
  const meaningIndex = Math.max(
    1,
    header.findIndex(
      (cell) => cell === "meaning" || cell === "释义" || cell === "中文",
    ),
  );

  return sanitizeDictionary(
    rows.slice(hasHeader ? 1 : 0).map((row) => ({
      word: row[wordIndex] ?? "",
      meaning: row[meaningIndex] ?? "",
    })),
  );
}

function parseOcrText(text: string): OcrCandidate[] {
  const ignoredWords = new Set(["word", "meaning", "vocabulary", "english", "chinese"]);
  const unique = new Map<string, OcrCandidate>();

  text
    .replace(/\r/g, "")
    .split("\n")
    .flatMap((line) => line.split(/\s{3,}|\t+/))
    .map((line) => line.replace(/^\s*[\d①-⑳]+[.)、．:\s-]*/, "").trim())
    .filter(Boolean)
    .forEach((line, index) => {
      const match = line.match(/\b([A-Za-z][A-Za-z'-]{1,})\b(.*)$/);
      if (!match) return;
      const word = match[1].toLowerCase();
      if (ignoredWords.has(word)) return;
      const meaning = match[2]
        .replace(/^[\s|:：;；,，.。—–-]+/, "")
        .replace(/\s{2,}/g, " ")
        .trim();
      unique.set(word, {
        id: `${word}-${index}`,
        word,
        meaning,
        selected: true,
        source: hasChinese(meaning) ? "photo" : "missing",
      });
    });

  return [...unique.values()];
}

async function preparePhoto(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const maximumSide = 2400;
  const scale = Math.min(1, maximumSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas");
  context.filter = "grayscale(1) contrast(1.22)";
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("image"))),
      "image/png",
      0.92,
    );
  });
}

async function enrichOcrCandidates(
  candidates: OcrCandidate[],
  currentDictionary: VocabularyEntry[],
): Promise<OcrCandidate[]> {
  const existing = new Map(
    currentDictionary.map((entry) => [entry.word.toLowerCase(), entry.meaning] as const),
  );
  let local: Record<string, string> = {};
  try {
    local = await loadLocalDictionary();
  } catch {
    local = {};
  }

  return candidates.map((candidate) => {
    if (hasChinese(candidate.meaning)) return candidate;
    const variants = wordVariants(candidate.word.trim().toLowerCase());
    const existingMeaning = variants.map((word) => existing.get(word)).find(Boolean);
    if (existingMeaning) {
      return { ...candidate, meaning: existingMeaning, source: "existing" };
    }
    const dictionaryMeaning = variants.map((word) => local[word]).find(Boolean);
    if (dictionaryMeaning) {
      return { ...candidate, meaning: dictionaryMeaning, source: "dictionary" };
    }
    return { ...candidate, meaning: "", source: "missing" };
  });
}

function download(name: string, content: string, type: string) {
  downloadBlob(name, new Blob([content], { type }));
}

function downloadBlob(name: string, content: Blob) {
  const url = URL.createObjectURL(content);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function Home() {
  const [data, setData] = useState<AppData | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [activeView, setActiveView] = useState<"study" | "library" | "history" | "mastered">("study");
  const [filter, setFilter] = useState<"all" | "due" | "familiar" | "fuzzy" | "unknown" | "weak" | "mastered">("all");
  const [search, setSearch] = useState("");
  const [sessionFinished, setSessionFinished] = useState(false);
  const [lastAction, setLastAction] = useState<LastAction | null>(null);
  const revealStartedAt = useRef(0);
  const [photoPanelOpen, setPhotoPanelOpen] = useState(false);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [ocrState, setOcrState] = useState<OcrState>("idle");
  const [ocrProgress, setOcrProgress] = useState(0);
  const [ocrMessage, setOcrMessage] = useState("等待选择照片");
  const [ocrRawText, setOcrRawText] = useState("");
  const [ocrCandidates, setOcrCandidates] = useState<OcrCandidate[]>([]);
  const [pdfExporting, setPdfExporting] = useState(false);

  useEffect(() => {
    const loaded = loadData();
    if (!loaded.session) {
      const due = dueIds(loaded);
      if (due.length) loaded.session = makeSession(due, "due");
    }
    setData(loaded);
  }, []);

  useEffect(() => {
    if (data) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    }
  }, [data]);

  useEffect(() => {
    return () => {
      if (photoPreview) URL.revokeObjectURL(photoPreview);
    };
  }, [photoPreview]);

  const currentSessionCard = data?.session?.queue[data.session.index] ?? null;
  const currentWord = currentSessionCard
    ? data?.dictionary.find((entry) => entry.id === currentSessionCard.id) ?? null
    : null;
  const currentProgress = currentWord ? data?.progress[currentWord.id] : null;

  const stats = useMemo(() => {
    if (!data) return { due: 0, mastered: 0, reviewed: 0 };
    return {
      due: dueIds(data).length,
      mastered: data.dictionary.filter((entry) => data.progress[entry.id].step >= 5)
        .length,
      reviewed: data.dictionary.filter(
        (entry) => data.progress[entry.id].reviewCount > 0,
      ).length,
    };
  }, [data]);

  const startSession = useCallback(
    (kind: StudySession["kind"], selectedIds?: string[]) => {
      if (!data) return;
      const candidateIds =
        selectedIds ??
        (kind === "due"
          ? dueIds(data)
          : kind === "mistakes"
            ? data.dictionary
                .filter((entry) => {
                  const rating = data.progress[entry.id].lastRating;
                  return rating === "fuzzy" || rating === "unknown";
                })
                .map((entry) => entry.id)
            : data.dictionary.map((entry) => entry.id));
      const ids = candidateIds.filter(
        (id) => data.progress[id] && data.progress[id].step < 5,
      );
      if (!ids.length) return;
      setData({ ...data, session: makeSession(ids, kind) });
      setRevealed(false);
      setSessionFinished(false);
      setLastAction(null);
      setActiveView("study");
    },
    [data],
  );

  const rate = useCallback(
    (rating: Rating) => {
      if (!data?.session || !currentSessionCard || !currentWord) return;
      const now = Date.now();
      const existing = data.progress[currentWord.id];
      let step = existing.step;
      let nextDue: number | null;
      const familiarStreak =
        rating === "familiar" ? existing.familiarStreak + 1 : 0;

      if (rating === "familiar") {
        if (step >= REVIEW_INTERVALS.length) {
          if (familiarStreak >= 3) {
            step = 5;
            nextDue = null;
          } else {
            step = 4;
            nextDue = now + REVIEW_INTERVALS[REVIEW_INTERVALS.length - 1];
          }
        } else {
          nextDue = now + REVIEW_INTERVALS[step];
          step += 1;
        }
      } else if (rating === "fuzzy") {
        nextDue = now + 12 * HOUR;
      } else {
        step = 0;
        nextDue = now + 12 * HOUR;
      }

      const progress: Record<string, WordProgress> = {
        ...data.progress,
        [currentWord.id]: {
          step,
          nextDue,
          lastRating: rating,
          reviewCount: existing.reviewCount + 1,
          familiarStreak,
          history: [
            ...existing.history,
            { at: new Date(now).toISOString(), rating, step },
          ].slice(-50),
        },
      };

      const queue = [...data.session.queue];
      if (rating === "unknown" && !currentSessionCard.retry) {
        queue.push({ id: currentWord.id, retry: true });
      }
      const nextIndex = data.session.index + 1;
      const finished = nextIndex >= queue.length;
      const sessionRatings = [
        ...data.session.ratings,
        { id: currentWord.id, at: new Date(now).toISOString(), rating },
      ];
      const completedSession: SessionHistoryEntry | null = finished
        ? {
            id: `session-${now}`,
            startedAt: data.session.startedAt,
            endedAt: now,
            kind: data.session.kind,
            ratings: sessionRatings,
            mistakeIds: [
              ...new Set(
                sessionRatings
                  .filter((item) => item.rating !== "familiar")
                  .map((item) => item.id),
              ),
            ],
          }
        : null;

      setLastAction({ data, word: currentWord.word, rating });
      setData({
        ...data,
        progress,
        session: finished
          ? null
          : { ...data.session, queue, index: nextIndex, ratings: sessionRatings },
        sessionHistory: completedSession
          ? [completedSession, ...data.sessionHistory].slice(0, 100)
          : data.sessionHistory,
      });
      setRevealed(false);
      setSessionFinished(finished);
    },
    [currentSessionCard, currentWord, data],
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (photoPanelOpen) return;
      if (activeView !== "study" || !currentWord) return;
      if (!revealed && (event.key === " " || event.key === "Enter")) {
        event.preventDefault();
        revealStartedAt.current = Date.now();
        setRevealed(true);
      } else if (revealed && ["1", "2", "3"].includes(event.key)) {
        event.preventDefault();
        if (Date.now() - revealStartedAt.current < 1000) return;
        rate(event.key === "1" ? "familiar" : event.key === "2" ? "fuzzy" : "unknown");
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeView, currentWord, photoPanelOpen, rate, revealed]);

  function revealAnswer() {
    if (revealed) return;
    revealStartedAt.current = Date.now();
    setRevealed(true);
  }

  function undoLastRating() {
    if (!lastAction) return;
    setData(lastAction.data);
    setLastAction(null);
    setSessionFinished(false);
    revealStartedAt.current = Date.now();
    setRevealed(true);
    setActiveView("study");
  }

  function shuffleRemaining() {
    if (!data?.session) return;
    const done = data.session.queue.slice(0, data.session.index);
    const remaining = shuffle(data.session.queue.slice(data.session.index));
    setData({
      ...data,
      session: { ...data.session, queue: [...done, ...remaining] },
    });
    setLastAction(null);
    setRevealed(false);
  }

  function resetProgress() {
    if (!data) return;
    const confirmed = window.confirm(`确定清空全部复习记录吗？${data.dictionary.length} 个词会回到未开始状态。此操作无法撤销。`);
    if (!confirmed) return;
    const progress = Object.fromEntries(
      data.dictionary.map((entry) => [entry.id, blankProgress()]),
    );
    const next = { ...data, progress, session: null, sessionHistory: [] };
    next.session = makeSession(data.dictionary.map((entry) => entry.id), "due");
    setData(next);
    setLastAction(null);
    setSessionFinished(false);
    setRevealed(false);
    setActiveView("study");
  }

  function exportProgress() {
    if (!data) return;
    download(
      `词汇复习进度-${new Date().toISOString().slice(0, 10)}.json`,
      JSON.stringify(data, null, 2),
      "application/json;charset=utf-8",
    );
  }

  async function exportWeakWordsPdf() {
    if (!data || pdfExporting) return;
    const candidates = data.dictionary.map((entry) => {
      const progress = data.progress[entry.id];
      return {
        word: entry.word,
        meaning: entry.meaning,
        familiarStreak: progress.familiarStreak,
        lastRating: progress.lastRating,
        reviewCount: progress.reviewCount,
      };
    });

    setPdfExporting(true);
    try {
      const [{ createWeakVocabularyPdf, selectWeakVocabularyEntries }, fontResponse] =
        await Promise.all([
          import("./vocabulary-pdf"),
          fetch(PDF_FONT_URL, { cache: "force-cache" }),
        ]);
      if (!fontResponse.ok) throw new Error("font");
      const entries = selectWeakVocabularyEntries(candidates);
      if (!entries.length) {
        window.alert("所有单词都已连续熟悉 3 次，暂时没有待加强词汇。");
        return;
      }
      const pdf = await createWeakVocabularyPdf(
        entries,
        await fontResponse.arrayBuffer(),
      );
      const date = new Date().toISOString().slice(0, 10);
      downloadBlob(
        `待加强词汇-${date}.pdf`,
        new Blob([pdf], { type: "application/pdf" }),
      );
    } catch {
      window.alert("PDF 生成失败，请检查网络后重试。你的词库和进度不会受影响。");
    } finally {
      setPdfExporting(false);
    }
  }

  async function importBackup(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as Partial<AppData>;
      const normalized = normalizeData(parsed);
      setData(normalized);
      setLastAction(null);
      setRevealed(false);
      setSessionFinished(false);
      window.alert("进度备份已恢复。当前复习位置也已保留。");
    } catch {
      window.alert("无法读取这份进度文件，请选择本程序导出的 JSON 备份。");
    }
  }

  async function importCsv(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !data) return;
    try {
      const imported = parseVocabularyCsv(await file.text());
      if (!imported.length) throw new Error("empty");
      const dictionaryMap = new Map(
        data.dictionary.map((entry) => [entry.id, entry] as const),
      );
      imported.forEach((entry) => dictionaryMap.set(entry.id, entry));
      const dictionary = [...dictionaryMap.values()];
      const progress = { ...data.progress };
      dictionary.forEach((entry) => {
        progress[entry.id] ??= blankProgress();
      });
      setData({ ...data, dictionary, progress, session: null });
      setLastAction(null);
      setSessionFinished(false);
      window.alert(`已导入 ${imported.length} 个词。重复单词的释义已更新。`);
    } catch {
      window.alert("未找到有效词条。CSV 请使用 word,meaning 两列，也支持“单词,释义”。");
    }
  }

  function closePhotoPanel() {
    if (ocrState === "reading") return;
    setPhotoPanelOpen(false);
    setOcrState("idle");
    setOcrProgress(0);
    setOcrMessage("等待选择照片");
    setOcrRawText("");
    setOcrCandidates([]);
    setPhotoPreview(null);
  }

  async function recognizePhoto(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 24 * 1024 * 1024) {
      window.alert("照片请控制在 24MB 以内。可以先裁剪到只保留词表区域再上传。");
      return;
    }

    setPhotoPanelOpen(true);
    setOcrState("reading");
    setOcrProgress(0.02);
    setOcrMessage("正在优化照片清晰度");
    setOcrCandidates([]);
    setOcrRawText("");
    setPhotoPreview(URL.createObjectURL(file));

    try {
      const prepared = await preparePhoto(file);
      const { createWorker, OEM, PSM } = await import("tesseract.js");
      const statusLabels: Record<string, string> = {
        "loading tesseract core": "正在准备本地识别引擎",
        "loading language traineddata": "正在加载中英文识别数据",
        "initializing tesseract": "正在初始化文字识别",
        "initializing api": "正在整理识别规则",
        "recognizing text": "正在读取照片中的单词",
      };
      const worker = await createWorker(["eng", "chi_sim"], OEM.LSTM_ONLY, {
        workerPath: "/tesseract/worker.min.js",
        corePath: "/tesseract-core",
        langPath: "/tessdata",
        gzip: true,
        logger: (message) => {
          setOcrProgress(Math.max(0.03, Math.min(1, message.progress || 0)));
          setOcrMessage(statusLabels[message.status] ?? "正在识别照片");
        },
      });

      try {
        await worker.setParameters({
          tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
          preserve_interword_spaces: "1",
        });
        const result = await worker.recognize(prepared);
        const text = result.data.text.trim();
        setOcrProgress(0.97);
        setOcrMessage("正在自动补全中文释义");
        const candidates = await enrichOcrCandidates(
          parseOcrText(text),
          data?.dictionary ?? vocabulary,
        );
        setOcrRawText(text);
        setOcrCandidates(candidates);
        setOcrState("review");
        setOcrProgress(1);
        setOcrMessage(
          candidates.length
            ? `识别到 ${candidates.length} 行，请检查后导入`
            : "没有自动整理出词条，可以在原始文字中修改后重试",
        );
      } finally {
        await worker.terminate();
      }
    } catch {
      setOcrState("error");
      setOcrMessage("识别没有完成，请换一张更清晰、光线更均匀的照片重试");
    }
  }

  async function rebuildOcrCandidates() {
    setOcrState("reading");
    setOcrProgress(0.95);
    setOcrMessage("正在重新整理并补全中文释义");
    const candidates = await enrichOcrCandidates(
      parseOcrText(ocrRawText),
      data?.dictionary ?? vocabulary,
    );
    setOcrCandidates(candidates);
    setOcrState("review");
    setOcrMessage(
      candidates.length
        ? `已重新整理出 ${candidates.length} 行`
        : "仍未找到词条，请确保每行以英文单词开头",
    );
  }

  async function autoFillMissingMeanings() {
    setOcrState("reading");
    setOcrProgress(0.96);
    setOcrMessage("正在为英文单词补全中文释义");
    const candidates = await enrichOcrCandidates(
      ocrCandidates,
      data?.dictionary ?? vocabulary,
    );
    setOcrCandidates(candidates);
    setOcrState("review");
    const filled = candidates.filter((candidate) => hasChinese(candidate.meaning)).length;
    setOcrMessage(`已为 ${filled} 行补全中文释义，请检查后导入`);
  }

  function updateOcrCandidate(
    id: string,
    field: "word" | "meaning" | "selected",
    value: string | boolean,
  ) {
    setOcrCandidates((current) =>
      current.map((candidate) =>
        candidate.id === id
          ? {
              ...candidate,
              [field]: value,
              ...(field === "meaning" ? { source: "manual" as const } : {}),
            }
          : candidate,
      ),
    );
  }

  function addOcrRow() {
    setOcrCandidates((current) => [
      ...current,
      {
        id: `manual-${Date.now()}`,
        word: "",
        meaning: "",
        selected: true,
        source: "manual",
      },
    ]);
  }

  function importOcrCandidates() {
    if (!data) return;
    const imported = sanitizeDictionary(
      ocrCandidates
        .filter(
          (candidate) =>
            candidate.selected &&
            candidate.word.trim() &&
            hasChinese(candidate.meaning),
        )
        .map((candidate) => ({
          word: candidate.word,
          meaning: candidate.meaning,
        })),
    );
    if (!imported.length) {
      window.alert("请至少保留一个同时包含英文和中文释义的词条。");
      return;
    }

    const dictionaryMap = new Map(
      data.dictionary.map((entry) => [entry.id, entry] as const),
    );
    imported.forEach((entry) => dictionaryMap.set(entry.id, entry));
    const dictionary = [...dictionaryMap.values()];
    const progress = { ...data.progress };
    dictionary.forEach((entry) => {
      progress[entry.id] ??= blankProgress();
    });
    setData({ ...data, dictionary, progress });
    setLastAction(null);
    closePhotoPanel();
    window.alert(`已把 ${imported.length} 个词加入词库。重复单词的释义已更新。`);
  }

  const visibleWords = useMemo(() => {
    if (!data) return [];
    const query = search.trim().toLowerCase();
    return data.dictionary.filter((entry) => {
      const progress = data.progress[entry.id];
      const matchesSearch =
        !query ||
        entry.word.toLowerCase().includes(query) ||
        entry.meaning.toLowerCase().includes(query);
      const matchesFilter =
        filter === "all" ||
        (filter === "due" && progress.nextDue !== null && progress.nextDue <= Date.now()) ||
        (filter === "mastered" && progress.step >= 5) ||
        (filter === "weak" &&
          (progress.lastRating === "fuzzy" || progress.lastRating === "unknown")) ||
        progress.lastRating === filter;
      return matchesSearch && matchesFilter;
    });
  }, [data, filter, search]);

  if (!data) {
    return (
      <main className="loading-shell" aria-live="polite">
        <div className="loading-mark">忆</div>
        <p>正在打开你的词库…</p>
      </main>
    );
  }

  const sessionTotal = data.session?.queue.length ?? 0;
  const sessionPosition = data.session ? data.session.index + 1 : 0;
  const masteredWords = data.dictionary.filter(
    (entry) => data.progress[entry.id].step >= 5,
  );
  const weakExportWordCount = data.dictionary.filter(
    (entry) => data.progress[entry.id].familiarStreak < 3,
  ).length;
  const activeWordCount = data.dictionary.length - masteredWords.length;
  const lastCompletedSession = data.sessionHistory[0] ?? null;
  const lastCompletedCounts = lastCompletedSession
    ? {
        familiar: lastCompletedSession.ratings.filter((item) => item.rating === "familiar").length,
        fuzzy: lastCompletedSession.ratings.filter((item) => item.rating === "fuzzy").length,
        unknown: lastCompletedSession.ratings.filter((item) => item.rating === "unknown").length,
      }
    : null;
  const weakWords = data.dictionary.filter((entry) => {
    const rating = data.progress[entry.id].lastRating;
    return rating === "fuzzy" || rating === "unknown";
  });
  const totalReviews = data.dictionary.reduce(
    (sum, entry) => sum + data.progress[entry.id].reviewCount,
    0,
  );
  const overallProgress = data.dictionary.length
    ? Math.round(
        (data.dictionary.reduce(
          (sum, entry) => sum + Math.min(5, data.progress[entry.id].step),
          0,
        ) /
          (data.dictionary.length * 5)) *
          100,
      )
    : 0;
  const dailyHistory = Array.from({ length: 7 }, (_, offset) => {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - (6 - offset));
    const key = dayKey(date);
    const ratings = data.dictionary.flatMap((entry) =>
      data.progress[entry.id].history.filter(
        (event) => dayKey(new Date(event.at)) === key,
      ),
    );
    return {
      key,
      label: offset === 6 ? "今天" : `${date.getMonth() + 1}/${date.getDate()}`,
      familiar: ratings.filter((event) => event.rating === "familiar").length,
      fuzzy: ratings.filter((event) => event.rating === "fuzzy").length,
      unknown: ratings.filter((event) => event.rating === "unknown").length,
      total: ratings.length,
    };
  });
  const maxDailyReviews = Math.max(1, ...dailyHistory.map((day) => day.total));
  const reviewStepLabels = REVIEW_STEPS.map((label, index) =>
    index === 0 && currentProgress?.step === 0 && currentProgress.reviewCount > 0
      ? "重新巩固"
      : label,
  );
  const currentStepLabel = currentProgress
    ? reviewStepLabels[Math.min(currentProgress.step, 4)]
    : REVIEW_STEPS[0];
  const selectedOcrCount = ocrCandidates.filter(
    (candidate) => candidate.selected,
  ).length;
  const importableOcrCount = ocrCandidates.filter(
    (candidate) =>
      candidate.selected && candidate.word.trim() && hasChinese(candidate.meaning),
  ).length;
  const autoFilledOcrCount = ocrCandidates.filter(
    (candidate) =>
      candidate.source === "existing" || candidate.source === "dictionary",
  ).length;

  return (
    <main className="app-shell">
      <header className="site-header">
        <button
          className="brand"
          type="button"
          onClick={() => setActiveView("study")}
          aria-label="返回回忆卡"
        >
          <span className="brand-mark">忆</span>
          <span>
            <strong>词汇回忆室</strong>
            <small>{data.dictionary.length} 词 · 本地间隔复习</small>
          </span>
        </button>
        <nav className="main-nav" aria-label="主导航">
          <button
            type="button"
            className={activeView === "study" ? "active" : ""}
            onClick={() => setActiveView("study")}
          >
            回忆卡
          </button>
          <button
            type="button"
            className={activeView === "library" ? "active" : ""}
            onClick={() => setActiveView("library")}
          >
            词库与进度
          </button>
          <button
            type="button"
            className={activeView === "history" ? "active" : ""}
            onClick={() => setActiveView("history")}
          >
            学习记录
          </button>
          <button
            type="button"
            className={activeView === "mastered" ? "active" : ""}
            onClick={() => setActiveView("mastered")}
          >
            长期记忆库
          </button>
        </nav>
      </header>

      {activeView === "study" ? (
        <section className="study-layout">
          <div className="study-heading">
            <div>
              <p className="eyebrow">ACTIVE RECALL</p>
              <h1>先想起来，再看答案。</h1>
              <p>不用追求完整释义。能在 2–3 秒内说出核心意思，就算熟悉。</p>
            </div>
            <div className="stats-strip" aria-label="复习概览">
              <div>
                <strong>{stats.due}</strong>
                <span>当前到期</span>
              </div>
              <div>
                <strong>{stats.reviewed}</strong>
                <span>已经回忆</span>
              </div>
              <div>
                <strong>{stats.mastered}</strong>
                <span>长期记忆</span>
              </div>
            </div>
          </div>

          {currentWord && currentProgress && data.session ? (
            <div className="study-stage">
              <aside className="session-panel">
                <div className="session-label">
                  <span>{SESSION_KIND_LABELS[data.session.kind]}</span>
                  <strong>{sessionPosition} / {sessionTotal}</strong>
                </div>
                <div className="session-progress" aria-hidden="true">
                  <span style={{ width: `${(data.session.index / sessionTotal) * 100}%` }} />
                </div>
                <button type="button" className="text-button" onClick={shuffleRemaining}>
                  打乱剩余顺序
                </button>
                <div className="streak-status">
                  <span>连续熟悉</span>
                  <strong>{Math.min(3, currentProgress.familiarStreak)} / 3</strong>
                  <small>{currentProgress.step >= 4 ? "保持连续即可入库" : "通过 7D 后方可入库"}</small>
                </div>
                <p className="privacy-note">进度只保存在这台设备的浏览器里。</p>
              </aside>

              <div className="card-column">
                <div className="step-track" aria-label={`当前复习节点：${currentStepLabel}`}>
                  {reviewStepLabels.map((label, index) => (
                    <div
                      key={label}
                      className={
                        currentProgress.step > index
                          ? "step complete"
                          : currentProgress.step === index
                            ? "step current"
                            : "step"
                      }
                    >
                      <span>{currentProgress.step > index ? "✓" : index + 1}</span>
                      <small>{label}</small>
                    </div>
                  ))}
                </div>

                <button
                  type="button"
                  className={`recall-card ${revealed ? "revealed" : ""}`}
                  onClick={revealAnswer}
                  aria-label={revealed ? `${currentWord.word}，${currentWord.meaning}` : `${currentWord.word}，点击显示中文释义`}
                >
                  <span className="card-kicker">
                    {currentSessionCard.retry ? "本轮再想一次" : "看到英文，回忆中文"}
                  </span>
                  <strong className="word">{currentWord.word}</strong>
                  <span className="meaning-area">
                    {revealed ? (
                      <span className="meaning">{currentWord.meaning}</span>
                    ) : (
                      <span className="reveal-prompt">想好后，点击显示答案</span>
                    )}
                  </span>
                  <span className="card-number">#{String(data.dictionary.findIndex((entry) => entry.id === currentWord.id) + 1).padStart(2, "0")}</span>
                </button>

                {revealed ? (
                  <>
                    <div className="rating-panel" aria-label="请选择回忆程度">
                      <button type="button" className="rating familiar" onClick={() => rate("familiar")}>
                        <span className="rating-key">1</span>
                        <strong>熟悉</strong>
                        <small>连续熟悉 +1</small>
                      </button>
                      <button type="button" className="rating fuzzy" onClick={() => rate("fuzzy")}>
                        <span className="rating-key">2</span>
                        <strong>模糊</strong>
                        <small>12 小时后再来</small>
                      </button>
                      <button type="button" className="rating unknown" onClick={() => rate("unknown")}>
                        <span className="rating-key">3</span>
                        <strong>不会</strong>
                        <small>本轮稍后再出现</small>
                      </button>
                    </div>
                    <p className="keyboard-safety">防误触：答案显示 1 秒后才启用数字键；点击按钮可直接评分。</p>
                  </>
                ) : (
                  <p className="keyboard-hint">按空格或回车显示答案</p>
                )}
              </div>
            </div>
          ) : (
            <div className="empty-state">
              <span className="completion-mark">{sessionFinished ? "✓" : "休"}</span>
              <p className="eyebrow">{sessionFinished ? "ROUND COMPLETE" : "ALL CLEAR"}</p>
              <h2>{sessionFinished ? "这一轮完成了。" : "现在没有到期词汇。"}</h2>
              <p>
                {stats.due > 0
                  ? `已有 ${stats.due} 个词到期，可以开始下一轮。`
                  : "可以先休息，到了复习时间再回来。也可以自由回忆全部词汇。"}
              </p>
              <div className="empty-actions">
                {stats.due > 0 && (
                  <button type="button" className="primary-button" onClick={() => startSession("due")}>
                    开始到期复习
                  </button>
                )}
                <button type="button" className="secondary-button" onClick={() => startSession("all")}>
                  随机回忆未掌握 {activeWordCount} 词
                </button>
              </div>
              {sessionFinished && lastCompletedSession && lastCompletedCounts && (
                <div className="round-summary" aria-label="本轮学习总结">
                  <div className="round-summary-head">
                    <strong>本轮记录已经保存</strong>
                    <span>{lastCompletedSession.ratings.length} 次作答</span>
                  </div>
                  <div className="round-counts">
                    <div className="familiar"><strong>{lastCompletedCounts.familiar}</strong><span>熟悉</span></div>
                    <div className="fuzzy"><strong>{lastCompletedCounts.fuzzy}</strong><span>模糊</span></div>
                    <div className="unknown"><strong>{lastCompletedCounts.unknown}</strong><span>不会</span></div>
                  </div>
                  {lastCompletedSession.mistakeIds.length > 0 ? (
                    <>
                      <p>
                        本轮需要加强：{lastCompletedSession.mistakeIds
                          .map((id) => data.dictionary.find((entry) => entry.id === id)?.word)
                          .filter(Boolean)
                          .slice(0, 8)
                          .join("、")}
                        {lastCompletedSession.mistakeIds.length > 8 ? "……" : ""}
                      </p>
                      <button
                        type="button"
                        className="primary-button"
                        onClick={() => startSession("mistakes", lastCompletedSession.mistakeIds)}
                      >
                        只复习本轮错词（{lastCompletedSession.mistakeIds.length}）
                      </button>
                    </>
                  ) : (
                    <p>这一轮没有模糊或不会的词，表现很稳。</p>
                  )}
                  <button type="button" className="text-button" onClick={() => setActiveView("history")}>
                    查看完整学习记录
                  </button>
                </div>
              )}
            </div>
          )}

          <div className="schedule-note">
            <span>复习节奏</span>
            <strong>初见 → 12H → 1D → 3D → 7D</strong>
            <p>通过 7D 且连续 3 次“熟悉”进入长期记忆库；“模糊”或“不会”会中断连续记录并继续强化。</p>
          </div>
        </section>
      ) : activeView === "library" ? (
        <section className="library-layout">
          <div className="library-heading">
            <div>
              <p className="eyebrow">YOUR {data.dictionary.length} WORDS</p>
              <h1>词库与进度</h1>
              <p>原始词表来自 Spaced_Repetition_Vocabulary-v2.pdf。</p>
            </div>
            <div className="library-actions">
              <label className="primary-button file-button camera-button">
                拍照识别词表
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  onChange={recognizePhoto}
                />
              </label>
              <button
                type="button"
                className="secondary-button pdf-export-button"
                onClick={exportWeakWordsPdf}
                disabled={pdfExporting || weakExportWordCount === 0}
                title="排除连续熟悉 3 次及以上的单词"
              >
                {pdfExporting
                  ? "正在生成 PDF…"
                  : `导出待加强 PDF（${weakExportWordCount}）`}
              </button>
              <button type="button" className="secondary-button" onClick={exportProgress}>
                导出进度备份
              </button>
              <label className="secondary-button file-button">
                恢复进度
                <input type="file" accept="application/json,.json" onChange={importBackup} />
              </label>
            </div>
          </div>

          <div className="library-toolbar">
            <label className="search-box">
              <span>查找</span>
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="输入英文或中文…"
              />
            </label>
            <div className="filter-row" aria-label="筛选词汇">
              {([
                ["all", "全部"],
                ["due", "已到期"],
                ["familiar", "熟悉"],
                ["fuzzy", "模糊"],
                ["unknown", "不会"],
                ["weak", "错词"],
                ["mastered", "长期记忆库"],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={filter === value ? "active" : ""}
                  onClick={() => setFilter(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="word-table" role="table" aria-label="词汇进度表">
            <div className="word-row word-header" role="row">
              <span role="columnheader">英文</span>
              <span role="columnheader">中文释义</span>
              <span role="columnheader">状态</span>
              <span role="columnheader">下次复习</span>
            </div>
            {visibleWords.map((entry) => {
              const progress = data.progress[entry.id];
              const status =
                progress.step >= 5
                  ? "已稳固"
                  : progress.lastRating
                    ? RATING_LABELS[progress.lastRating]
                    : "未回忆";
              return (
                <div className="word-row" role="row" key={entry.id}>
                  <strong role="cell">{entry.word}</strong>
                  <span role="cell">{entry.meaning}</span>
                  <span role="cell">
                    <span className={`status-pill ${progress.step >= 5 ? "mastered" : progress.lastRating ?? "new"}`}>
                      {status}
                    </span>
                  </span>
                  <span role="cell">{formatDue(progress.nextDue)}</span>
                </div>
              );
            })}
            {!visibleWords.length && (
              <p className="no-results">没有符合当前筛选条件的词。</p>
            )}
          </div>

          <details className="data-tools">
            <summary>导入其他词表与数据管理</summary>
            <div>
              <p>CSV 使用两列：<code>word,meaning</code>。重复单词会更新释义，新单词会加入词库。</p>
              <label className="secondary-button file-button">
                导入词表 CSV
                <input type="file" accept="text/csv,.csv,.txt" onChange={importCsv} />
              </label>
              <button type="button" className="danger-button" onClick={resetProgress}>
                清空全部复习记录
              </button>
            </div>
          </details>
        </section>
      ) : activeView === "history" ? (
        <section className="history-layout">
          <div className="history-heading">
            <div>
              <p className="eyebrow">LEARNING HISTORY</p>
              <h1>学习记录</h1>
              <p>每次作答都会自动保存在本机。这里能看到进步，也能随时捞出错词重练。</p>
            </div>
            {weakWords.length > 0 && (
              <button type="button" className="primary-button" onClick={() => startSession("mistakes")}>
                开始错词专项（{weakWords.length}）
              </button>
            )}
          </div>

          <div className="history-overview">
            <article className="mastery-card">
              <div className="mastery-ring" style={{ "--progress": `${overallProgress * 3.6}deg` } as CSSProperties}>
                <strong>{overallProgress}%</strong>
                <span>总体掌握</span>
              </div>
              <div className="mastery-copy">
                <span>五阶段总进度</span>
                <strong>{stats.mastered} 个词进入长期记忆库</strong>
                <div className="mastery-bar" aria-label={`总体掌握进度 ${overallProgress}%`}>
                  <span style={{ width: `${overallProgress}%` }} />
                </div>
                <small>按五阶段进度计算；通过 7D 且连续 3 次熟悉后正式入库。</small>
              </div>
            </article>
            <div className="history-metrics">
              <article><strong>{totalReviews}</strong><span>累计作答</span></article>
              <article><strong>{data.sessionHistory.length}</strong><span>完成轮次</span></article>
              <article><strong>{weakWords.length}</strong><span>当前错词</span></article>
              <article><strong>{stats.reviewed}</strong><span>接触词数</span></article>
            </div>
          </div>

          <article className="weekly-card">
            <div className="section-title-row">
              <div>
                <span>近 7 天</span>
                <strong>每日回忆记录</strong>
              </div>
              <div className="chart-legend" aria-label="图例">
                <span className="familiar">熟悉</span>
                <span className="fuzzy">模糊</span>
                <span className="unknown">不会</span>
              </div>
            </div>
            <div className="weekly-chart" role="img" aria-label="近七天每天的熟悉、模糊和不会次数">
              {dailyHistory.map((day) => (
                <div className="day-column" key={day.key}>
                  <strong>{day.total || "·"}</strong>
                  <div className="day-bar" style={{ height: `${Math.max(8, (day.total / maxDailyReviews) * 120)}px` }}>
                    {day.total > 0 && (
                      <>
                        <span className="familiar" style={{ height: `${(day.familiar / day.total) * 100}%` }} />
                        <span className="fuzzy" style={{ height: `${(day.fuzzy / day.total) * 100}%` }} />
                        <span className="unknown" style={{ height: `${(day.unknown / day.total) * 100}%` }} />
                      </>
                    )}
                  </div>
                  <small>{day.label}</small>
                </div>
              ))}
            </div>
          </article>

          <div className="history-columns">
            <article className="history-list-card">
              <div className="section-title-row">
                <div><span>最近完成</span><strong>每轮学习结果</strong></div>
              </div>
              {data.sessionHistory.length ? (
                <div className="session-history-list">
                  {data.sessionHistory.slice(0, 12).map((session) => {
                    const familiar = session.ratings.filter((item) => item.rating === "familiar").length;
                    const fuzzy = session.ratings.filter((item) => item.rating === "fuzzy").length;
                    const unknown = session.ratings.filter((item) => item.rating === "unknown").length;
                    return (
                      <div className="session-history-row" key={session.id}>
                        <div>
                          <strong>{SESSION_KIND_LABELS[session.kind]}</strong>
                          <span>{formatSessionDate(session.endedAt)} · {formatDuration(session.startedAt, session.endedAt)}</span>
                        </div>
                        <div className="session-result-bar" aria-label={`熟悉 ${familiar}，模糊 ${fuzzy}，不会 ${unknown}`}>
                          <span className="familiar">{familiar}</span>
                          <span className="fuzzy">{fuzzy}</span>
                          <span className="unknown">{unknown}</span>
                        </div>
                        {session.mistakeIds.length > 0 && (
                          <button type="button" className="text-button" onClick={() => startSession("mistakes", session.mistakeIds)}>
                            重练 {session.mistakeIds.length} 个错词
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="history-empty">从现在开始，每完成一轮都会在这里留下结果。你之前逐词完成的记录已经计入上方近 7 天图表。</p>
              )}
            </article>

            <article className="weak-list-card">
              <div className="section-title-row">
                <div><span>需要加强</span><strong>当前错词</strong></div>
                <button type="button" className="text-button" onClick={() => { setFilter("weak"); setActiveView("library"); }}>
                  查看全部
                </button>
              </div>
              {weakWords.length ? (
                <div className="weak-word-list">
                  {weakWords.slice(0, 10).map((entry) => (
                    <div key={entry.id}>
                      <span><strong>{entry.word}</strong><small>{entry.meaning}</small></span>
                      <span className={`status-pill ${data.progress[entry.id].lastRating}`}>
                        {RATING_LABELS[data.progress[entry.id].lastRating as Rating]}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="history-empty">暂时没有“模糊”或“不会”的词。</p>
              )}
            </article>
          </div>
        </section>
      ) : (
        <section className="mastered-layout">
          <div className="mastered-heading">
            <div>
              <p className="eyebrow">LONG-TERM MEMORY</p>
              <h1>长期记忆库</h1>
              <p>这些词已经通过长期检验，将不再出现在到期复习、随机回忆或错词专项中。</p>
            </div>
            <div className="mastered-count" aria-label={`长期记忆库共有 ${masteredWords.length} 个词`}>
              <strong>{masteredWords.length}</strong>
              <span>已稳固词汇</span>
            </div>
          </div>

          <article className="mastery-rule-card">
            <div className="rule-mark">稳</div>
            <div>
              <strong>入库标准</strong>
              <p>完成初见、12H、1D、3D、7D 的扩展间隔，并在通过 7D 时保持最近连续 3 次间隔回忆均为“熟悉”。一次“模糊”或“不会”都会中断连续记录，继续进入强化复习。</p>
            </div>
            <div className="rule-steps" aria-label="长期记忆入库流程">
              <span>通过 7D</span><b>＋</b><span>连续熟悉 × 3</span><b>＝</b><span>长期记忆</span>
            </div>
          </article>

          {masteredWords.length ? (
            <div className="mastered-grid">
              {masteredWords.map((entry) => {
                const progress = data.progress[entry.id];
                return (
                  <article className="mastered-word-card" key={entry.id}>
                    <span className="mastered-badge">已稳固</span>
                    <strong>{entry.word}</strong>
                    <p>{entry.meaning}</p>
                    <div>
                      <span>{formatMasteredAt(progress)}</span>
                      <span>共回忆 {progress.reviewCount} 次</span>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="mastered-empty">
              <span>芽</span>
              <h2>长期记忆正在生长。</h2>
              <p>目前还没有词达到入库标准。继续按时复习，第一个通过 7D 且连续稳定回忆的词会出现在这里。</p>
              <button type="button" className="primary-button" onClick={() => setActiveView("study")}>继续复习</button>
            </div>
          )}
        </section>
      )}

      {lastAction && (
        <aside className="undo-toast" role="status" aria-live="polite">
          <span>
            上一题 <strong>{lastAction.word}</strong> 已标记为“{RATING_LABELS[lastAction.rating]}”
          </span>
          <button type="button" onClick={undoLastRating}>撤销上一题</button>
        </aside>
      )}

      {photoPanelOpen && (
        <div className="photo-modal-backdrop" role="presentation">
          <section
            className="photo-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="photo-modal-title"
          >
            <header className="photo-modal-header">
              <div>
                <p className="eyebrow">LOCAL PHOTO OCR</p>
                <h2 id="photo-modal-title">拍照识别词表</h2>
                <p>只拍英文也可以：识别后会用本地英汉词典自动补全中文。照片只在当前浏览器中处理。</p>
              </div>
              <button
                type="button"
                className="modal-close"
                onClick={closePhotoPanel}
                disabled={ocrState === "reading"}
                aria-label="关闭拍照识词"
              >
                ×
              </button>
            </header>

            <div className="photo-workspace">
              <aside className="photo-preview-panel">
                {photoPreview ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={photoPreview} alt="等待识别的词表照片预览" />
                ) : (
                  <div className="photo-placeholder">照片预览</div>
                )}
                <div className="photo-tips">
                  <strong>拍得更准的小技巧</strong>
                  <span>只保留词表区域</span>
                  <span>镜头与纸面保持平行</span>
                  <span>英文单词尽量一行一个</span>
                </div>
              </aside>

              <div className="ocr-panel">
                {ocrState === "reading" ? (
                  <div className="ocr-loading" aria-live="polite">
                    <span className="ocr-spinner">识</span>
                    <strong>{ocrMessage}</strong>
                    <div className="ocr-progress" aria-label={`识别进度 ${Math.round(ocrProgress * 100)}%`}>
                      <span style={{ width: `${Math.max(4, ocrProgress * 100)}%` }} />
                    </div>
                    <small>{Math.round(ocrProgress * 100)}% · 首次识别可能需要十几秒</small>
                  </div>
                ) : ocrState === "error" ? (
                  <div className="ocr-error" role="alert">
                    <span>未</span>
                    <strong>{ocrMessage}</strong>
                    <label className="secondary-button file-button">
                      换一张照片重试
                      <input
                        type="file"
                        accept="image/*"
                        capture="environment"
                        onChange={recognizePhoto}
                      />
                    </label>
                  </div>
                ) : (
                  <>
                    <div className="ocr-summary">
                      <div>
                        <strong>{ocrMessage}</strong>
                        <span>
                          已选择 {selectedOcrCount} 行 · 自动补全 {autoFilledOcrCount} 行 · {importableOcrCount} 行可导入
                        </span>
                      </div>
                      <div className="ocr-summary-actions">
                        <button type="button" className="text-button" onClick={autoFillMissingMeanings}>
                          自动补全空白释义
                        </button>
                        <button type="button" className="text-button" onClick={addOcrRow}>
                          ＋ 添加一行
                        </button>
                      </div>
                    </div>

                    <div className="ocr-table" aria-label="识别结果编辑表">
                      <div className="ocr-row ocr-row-header">
                        <span>选</span>
                        <span>英文单词</span>
                        <span>中文释义</span>
                      </div>
                      {ocrCandidates.map((candidate) => (
                        <div className="ocr-row" key={candidate.id}>
                          <input
                            type="checkbox"
                            checked={candidate.selected}
                            onChange={(event) =>
                              updateOcrCandidate(
                                candidate.id,
                                "selected",
                                event.target.checked,
                              )
                            }
                            aria-label={`选择 ${candidate.word || "空白词条"}`}
                          />
                          <input
                            type="text"
                            value={candidate.word}
                            onChange={(event) =>
                              updateOcrCandidate(
                                candidate.id,
                                "word",
                                event.target.value,
                              )
                            }
                            placeholder="英文"
                            spellCheck={false}
                          />
                          <input
                            type="text"
                            value={candidate.meaning}
                            onChange={(event) =>
                              updateOcrCandidate(
                                candidate.id,
                                "meaning",
                                event.target.value,
                              )
                            }
                            className={
                              candidate.selected && !hasChinese(candidate.meaning)
                                ? "needs-meaning"
                                : ""
                            }
                            placeholder="请补充中文释义"
                            title={
                              candidate.source === "dictionary"
                                ? "由本地英汉词典自动补全"
                                : candidate.source === "existing"
                                  ? "由当前词库自动匹配"
                                  : candidate.source === "photo"
                                    ? "从照片中识别"
                                    : candidate.source === "manual"
                                      ? "已手动修改"
                                      : "尚未找到中文释义"
                            }
                          />
                        </div>
                      ))}
                      {!ocrCandidates.length && (
                        <p className="ocr-empty">暂时没有整理出的词条。可以修改下方原始文字，或手动添加一行。</p>
                      )}
                    </div>

                    <details className="ocr-raw-text">
                      <summary>查看或修改识别出的原始文字</summary>
                      <textarea
                        value={ocrRawText}
                        onChange={(event) => setOcrRawText(event.target.value)}
                        rows={7}
                        placeholder="每行建议写成：manuscript 手稿，原稿"
                      />
                      <button type="button" className="secondary-button" onClick={rebuildOcrCandidates}>
                        从修改后的文字重新整理
                      </button>
                    </details>
                  </>
                )}
              </div>
            </div>

            {ocrState === "review" && (
              <footer className="photo-modal-footer">
                <p>没有中文释义的行不会被导入，请先在表格中补充。</p>
                <div>
                  <button type="button" className="secondary-button" onClick={closePhotoPanel}>
                    取消
                  </button>
                  <button
                    type="button"
                    className="primary-button"
                    onClick={importOcrCandidates}
                    disabled={importableOcrCount === 0}
                  >
                    导入 {importableOcrCount} 个词
                  </button>
                </div>
              </footer>
            )}
          </section>
        </div>
      )}

      <footer>
        <span>数据留在本机</span>
        <span>·</span>
        <span>自动保存</span>
        <span>·</span>
        <span>支持进度备份</span>
      </footer>
    </main>
  );
}
