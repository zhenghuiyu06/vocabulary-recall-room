export type OcrCandidate = {
  id: string;
  word: string;
  meaning: string;
  tickCount: number;
  selected: boolean;
  source: "photo" | "existing" | "dictionary" | "manual" | "missing";
};

function hasChinese(text: string): boolean {
  return /[\u3400-\u9fff]/.test(text);
}

export function countOcrTicks(text: string): number {
  let count = 0;
  let remaining = text;
  remaining = remaining.replace(
    /([✓✔√☑✅])\s*[x×*]\s*([2-9])/g,
    (_match, _mark: string, amount: string) => {
      count += Number(amount);
      return " ";
    },
  );
  count += (remaining.match(/[✓✔√☑✅]/g) ?? []).length;
  count += remaining
    .split(/[\s|]+/)
    .filter((token) => /^v$/i.test(token)).length;
  return Math.min(9, count);
}

export function stripOcrTicks(text: string): string {
  return text
    .replace(/[✓✔√☑✅](?:\s*[x×*]\s*[2-9])?/g, " ")
    .replace(/(?:^|[\s|])v(?=$|[\s|])/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function prioritizeExamMeaning(meaning: string): string {
  const domainMarker = /\[(?:医|经|计|化|机|法|军|植|电|地质|数)\]/;
  const rawGroups = meaning.split(/[；;]/);
  const generalGroups = rawGroups.filter((group) => !domainMarker.test(group));
  const groups = (generalGroups.length ? generalGroups : rawGroups)
    .map((group) => group.trim())
    .filter(Boolean)
    .map((group) => {
      const normalizedGroup = group.replace(domainMarker, "").replace(/\s+/g, " ").trim();
      const match = normalizedGroup.match(/^(vt\.|vi\.|v\.|n\.|a\.|adj\.|ad\.|adv\.|prep\.|conj\.)\s*(.*)$/i);
      const rawPart = match?.[1]?.toLowerCase() ?? "";
      const part =
        rawPart === "vt." || rawPart === "vi." || rawPart === "v."
          ? "v."
          : rawPart === "a."
            ? "adj."
            : rawPart === "ad."
              ? "adv."
              : rawPart;
      const senses = (match?.[2] ?? normalizedGroup)
        .split(/[,，]/)
        .map((sense) => sense.trim())
        .filter(Boolean)
        .slice(0, 3)
        .join("；");
      return `${part}${part ? " " : ""}${senses}`.trim();
    })
    .filter(Boolean)
    .slice(0, 2);
  return groups.join(" ");
}

export function parseOcrText(text: string): OcrCandidate[] {
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
      const tickCount = countOcrTicks(line);
      const meaning = stripOcrTicks(match[2])
        .replace(/^[\s|:：;；,，.。—–-]+/, "")
        .replace(/\s{2,}/g, " ")
        .trim();
      unique.set(word, {
        id: `${word}-${index}`,
        word,
        meaning,
        tickCount,
        selected: true,
        source: hasChinese(meaning) ? "photo" : "missing",
      });
    });

  return [...unique.values()];
}
