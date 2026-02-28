import React, { useEffect, useMemo, useRef, useState } from "react";
import { ClipboardList, AlertCircle } from "lucide-react";
import Header, { ThemeMode } from "./components/Header";
import InputForm from "./components/InputForm";
import ClipboardComposer, { ComposerBlock } from "./components/ClipboardComposer";
import {
  EmptyState,
  isBulletLine,
  ManualHighlightRule,
  normalizeForManualMatch,
  splitVariantParagraphs,
  VariantCard,
} from "./components/OutputDisplay";
import { polishText } from "./services/geminiService";
import { PolishRequest, PolishResponse, Tone } from "./types";

const THEME_MODE_STORAGE_KEY = "dgs-theme-mode";

const AUTO_UNIQUE_TAG: Record<Tone, string> = {
  [Tone.STANDARD]: "STD: auto unique",
  [Tone.CONCISE]: "CON: auto unique",
  [Tone.FORMAL]: "FML: auto unique",
};

const UNIQUE_SIMILARITY_THRESHOLD = 0.28;
const MIN_UNIQUE_PARAGRAPH_LENGTH = 14;
const MAX_UNIQUE_HIGHLIGHTS_PER_TONE = 2;

const RECOMMENDATION_BLOCK_PATTERN =
  /(推薦產品|https?:\/\/|catalog|型錄參考|來源：|source link)/i;
const COURTESY_ONLY_PATTERN =
  /(您好|感謝|敬啟|敬祝|順頌|歡迎|聯繫|來函|垂詢|竭誠|商祺)/;
const MODEL_PATTERN = /\b[A-Z]{1,}[A-Z0-9-]{2,}\b/;
const NUMBER_OR_UNIT_PATTERN =
  /(\d+(?:\.\d+)?\s?(?:pH|Torr|mbar|bar|Pa|L\/min|ml|min|kg|V|A|Hz|RPM|%|°C|℃))/i;
const FACT_SIGNAL_PATTERN =
  /(耐酸鹼|真空|抽氣|化學|材質|PTFE|腐蝕|甲醇|溶劑|規格|流量|極限|風險|更換週期|污染|冷凝|濾器|庫存|出貨|交期|操作環境|真空度)/;

function createEmptyHighlightRules(): Record<Tone, ManualHighlightRule[]> {
  return {
    [Tone.STANDARD]: [],
    [Tone.CONCISE]: [],
    [Tone.FORMAL]: [],
  };
}

function createEmptyCandidateMap(): Record<
  Tone,
  Array<{ raw: string; normalized: string; grams: Set<string>; index: number }>
> {
  return {
    [Tone.STANDARD]: [],
    [Tone.CONCISE]: [],
    [Tone.FORMAL]: [],
  };
}

function buildBigrams(text: string): Set<string> {
  if (text.length < 2) {
    return new Set(text ? [text] : []);
  }

  const grams = new Set<string>();
  for (let index = 0; index < text.length - 1; index += 1) {
    grams.add(text.slice(index, index + 2));
  }
  return grams;
}

function calcJaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) {
      intersection += 1;
    }
  }

  const union = a.size + b.size - intersection;
  return union <= 0 ? 0 : intersection / union;
}

function isHighValueUniqueCandidate(raw: string): boolean {
  const text = raw.trim();
  if (!text || RECOMMENDATION_BLOCK_PATTERN.test(text)) {
    return false;
  }

  const hasModel = MODEL_PATTERN.test(text);
  const hasNumberOrUnit = NUMBER_OR_UNIT_PATTERN.test(text);
  const hasFactSignal = FACT_SIGNAL_PATTERN.test(text);
  const hasCourtesySignal = COURTESY_ONLY_PATTERN.test(text);

  if (hasCourtesySignal && !hasNumberOrUnit && !hasFactSignal) {
    return false;
  }

  if (hasNumberOrUnit || hasFactSignal) {
    return true;
  }

  return hasModel && hasFactSignal;
}

function buildAutoUniqueRules(
  variants: PolishResponse["variants"] | undefined
): Record<Tone, ManualHighlightRule[]> {
  if (!variants || variants.length === 0) {
    return createEmptyHighlightRules();
  }

  const tones: Tone[] = [Tone.STANDARD, Tone.CONCISE, Tone.FORMAL];
  const candidatesByTone = tones.reduce<
    Record<
      Tone,
      Array<{ raw: string; normalized: string; grams: Set<string>; index: number }>
    >
  >(
    (accumulator, tone) => {
      const variant = variants.find((item) => item.tone === tone);
      const paragraphs = variant ? splitVariantParagraphs(variant.content) : [];

      accumulator[tone] = paragraphs
        .map((paragraph, index) => {
          const normalized = normalizeForManualMatch(paragraph);
          return {
            raw: paragraph,
            normalized,
            grams: buildBigrams(normalized),
            index,
          };
        })
        .filter(
          (item) =>
            isBulletLine(item.raw) &&
            item.normalized.length >= MIN_UNIQUE_PARAGRAPH_LENGTH &&
            isHighValueUniqueCandidate(item.raw)
        );

      return accumulator;
    },
    createEmptyCandidateMap()
  );

  const rules = createEmptyHighlightRules();

  tones.forEach((tone) => {
    const currentCandidates = candidatesByTone[tone];
    const otherCandidates = tones
      .filter((otherTone) => otherTone !== tone)
      .flatMap((otherTone) => candidatesByTone[otherTone]);

    const uniqueCandidates: Array<{
      raw: string;
      normalized: string;
      highestSimilarity: number;
      index: number;
    }> = [];

    currentCandidates.forEach((candidate) => {
      let highestSimilarity = 0;

      for (const other of otherCandidates) {
        if (candidate.normalized === other.normalized) {
          highestSimilarity = 1;
          break;
        }

        const similarity = calcJaccardSimilarity(candidate.grams, other.grams);
        if (similarity > highestSimilarity) {
          highestSimilarity = similarity;
        }
      }

      if (highestSimilarity < UNIQUE_SIMILARITY_THRESHOLD) {
        uniqueCandidates.push({
          raw: candidate.raw,
          normalized: candidate.normalized,
          highestSimilarity,
          index: candidate.index,
        });
      }
    });

    const selected = uniqueCandidates
      .sort((a, b) => {
        if (a.highestSimilarity !== b.highestSimilarity) {
          return a.highestSimilarity - b.highestSimilarity;
        }
        if (b.normalized.length !== a.normalized.length) {
          return b.normalized.length - a.normalized.length;
        }
        return a.index - b.index;
      })
      .slice(0, MAX_UNIQUE_HIGHLIGHTS_PER_TONE);

    const seen = new Set<string>();
    selected.forEach((item) => {
      if (seen.has(item.normalized)) {
        return;
      }
      seen.add(item.normalized);
      rules[tone].push({
        match: item.raw,
        tag: AUTO_UNIQUE_TAG[tone],
      });
    });
  });

  return rules;
}

function isThemeMode(value: string | null): value is ThemeMode {
  return value === "light" || value === "dark" || value === "system";
}

function resolveTheme(mode: ThemeMode): "light" | "dark" {
  if (mode === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  return mode;
}

function toneTitle(tone: Tone): string {
  if (tone === Tone.STANDARD) return "標準回覆 (Standard)";
  if (tone === Tone.CONCISE) return "精簡回覆 (Concise)";
  return "正式回覆 (Formal)";
}

const App: React.FC = () => {
  const [isLoading, setIsLoading] = useState(false);
  const [response, setResponse] = useState<PolishResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    if (typeof window === "undefined") {
      return "dark";
    }
    const stored = window.localStorage.getItem(THEME_MODE_STORAGE_KEY);
    return isThemeMode(stored) ? stored : "dark";
  });
  const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">(() => {
    if (typeof window === "undefined") {
      return "dark";
    }
    const stored = window.localStorage.getItem(THEME_MODE_STORAGE_KEY);
    return resolveTheme(isThemeMode(stored) ? stored : "dark");
  });
  const [composerBlocks, setComposerBlocks] = useState<ComposerBlock[]>([]);
  const [isClipboardOpen, setIsClipboardOpen] = useState(false);
  const blockIdRef = useRef(0);
  const autoUniqueHighlightRules = useMemo(
    () => buildAutoUniqueRules(response?.variants),
    [response?.variants]
  );

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const root = window.document.documentElement;
    const applyTheme = () => {
      const theme = resolveTheme(themeMode);
      root.setAttribute("data-theme", theme);
      root.setAttribute("data-theme-mode", themeMode);
      setResolvedTheme(theme);
    };

    applyTheme();
    window.localStorage.setItem(THEME_MODE_STORAGE_KEY, themeMode);

    if (themeMode !== "system") {
      return;
    }

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleThemeChange = () => applyTheme();
    mediaQuery.addEventListener("change", handleThemeChange);
    return () => mediaQuery.removeEventListener("change", handleThemeChange);
  }, [themeMode]);

  useEffect(() => {
    setComposerBlocks([]);
    blockIdRef.current = 0;
  }, [response?.variants]);

  const handlePolishSubmit = async (data: PolishRequest) => {
    setIsLoading(true);
    setError(null);
    setResponse(null);

    try {
      const result = await polishText(data);
      setResponse(result);
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : "";
      if (rawMessage.includes("技術回覆內容最多")) {
        setError(rawMessage);
      } else if (rawMessage.includes("Proxy API Error")) {
        setError(`LLM API 呼叫失敗：${rawMessage}`);
      } else if (rawMessage) {
        setError(`處理失敗：${rawMessage}`);
      } else {
        setError("處理您的請求時發生錯誤。請確認網路連線或稍後再試。");
      }
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  const getVariant = (tone: Tone) =>
    response?.variants.find((variant) => variant.tone === tone);

  const addParagraphToComposer = (tone: Tone, paragraph: string) => {
    const text = paragraph.trim();
    if (!text) return;
    blockIdRef.current += 1;
    setComposerBlocks((prev) => [
      ...prev,
      { id: `block-${blockIdRef.current}`, tone, text },
    ]);
    setIsClipboardOpen(true);
  };

  const handleUpdateComposerBlock = (id: string, value: string) => {
    setComposerBlocks((prev) =>
      prev.map((block) => (block.id === id ? { ...block, text: value } : block))
    );
  };

  const handleRemoveComposerBlock = (id: string) => {
    setComposerBlocks((prev) => prev.filter((block) => block.id !== id));
  };

  const handleClearComposer = () => {
    setComposerBlocks([]);
  };

  const handleReorderComposerBlocks = (fromIndex: number, toIndex: number) => {
    setComposerBlocks((prev) => {
      if (
        fromIndex < 0 ||
        toIndex < 0 ||
        fromIndex >= prev.length ||
        toIndex >= prev.length
      ) {
        return prev;
      }
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
  };

  const renderReplyCards = () => {
    const tones: Tone[] = [Tone.CONCISE, Tone.STANDARD, Tone.FORMAL];

    return tones.map((tone) => {
      const variant = getVariant(tone);
      if (!variant) {
        return (
          <div
            key={tone}
            className="rounded-xl border border-dashed border-[var(--border-default)] bg-[var(--surface-primary)] p-6 flex items-center justify-center min-h-0"
          >
            <p className="text-sm text-[var(--text-muted)]">
              {toneTitle(tone)} 尚未生成
            </p>
          </div>
        );
      }

      return (
        <VariantCard
          key={tone}
          variant={variant}
          className="h-full min-h-0"
          manualHighlightRules={autoUniqueHighlightRules[tone]}
          onAddParagraph={addParagraphToComposer}
        />
      );
    });
  };

  return (
    <div className="min-h-screen h-screen flex flex-col text-[var(--text-primary)] overflow-hidden">
      <Header
        themeMode={themeMode}
        resolvedTheme={resolvedTheme}
        onThemeModeChange={setThemeMode}
      />

      <main className="relative flex-1 min-h-0 px-4 sm:px-6 lg:px-8 py-4 flex flex-col gap-3 overflow-hidden">
        {error && (
          <div
            className="border px-4 py-3 rounded-lg flex items-center theme-panel flex-shrink-0"
            style={{
              background: "var(--danger-surface)",
              borderColor: "var(--danger-border)",
              color: "var(--danger-text)",
            }}
          >
            <AlertCircle className="w-5 h-5 mr-2 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex-shrink-0">
          <InputForm onSubmit={handlePolishSubmit} isLoading={isLoading} />
        </div>

        <section className="flex-1 min-h-0">
          {response ? (
            <div className="h-full min-h-0 grid grid-cols-1 lg:grid-cols-3 gap-3">
              {renderReplyCards()}
            </div>
          ) : (
            <EmptyState />
          )}
        </section>

        <button
          type="button"
          onClick={() => setIsClipboardOpen((prev) => !prev)}
          className="absolute right-5 bottom-5 z-50 w-16 h-16 rounded-full bg-[var(--cta-bg)] hover:bg-[var(--cta-bg-hover)] text-white shadow-xl flex items-center justify-center transition-transform hover:scale-105"
          title="開啟剪貼區"
        >
          <ClipboardList className="w-6 h-6" />
          {composerBlocks.length > 0 && (
            <span className="absolute -top-1 -right-1 min-w-[20px] h-[20px] px-1 rounded-full bg-red-500 text-white text-[11px] font-bold flex items-center justify-center border-2 border-[var(--bg-body)]">
              {composerBlocks.length}
            </span>
          )}
        </button>

        <div
          className={`absolute inset-0 z-30 bg-black/35 transition-opacity duration-200 ${
            isClipboardOpen
              ? "opacity-100 pointer-events-auto"
              : "opacity-0 pointer-events-none"
          }`}
          onClick={() => setIsClipboardOpen(false)}
        />

        <aside
          className={`absolute top-0 right-0 bottom-0 z-40 w-[340px] max-w-full transform transition-transform duration-300 ease-out ${
            isClipboardOpen ? "translate-x-0" : "translate-x-full"
          }`}
        >
          <div className="h-full border-l border-[var(--border-default)] bg-[var(--surface-primary)] shadow-2xl">
            <ClipboardComposer
              blocks={composerBlocks}
              onClear={handleClearComposer}
              onRemoveBlock={handleRemoveComposerBlock}
              onUpdateBlock={handleUpdateComposerBlock}
              onReorderBlocks={handleReorderComposerBlocks}
              onClose={() => setIsClipboardOpen(false)}
              drawerMode
            />
          </div>
        </aside>
      </main>
    </div>
  );
};

export default App;
