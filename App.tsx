import React, { useEffect, useMemo, useRef, useState } from "react";
import Header, { ThemeMode } from "./components/Header";
import InputForm from "./components/InputForm";
import ClipboardComposer, { ComposerBlock } from "./components/ClipboardComposer";
import {
  EmptyState,
  ManualHighlightRule,
  VariantCard,
} from "./components/OutputDisplay";
import { polishText } from "./services/geminiService";
import { PolishRequest, PolishResponse, Tone, TokenRiskLevel } from "./types";
import { AlertCircle } from "lucide-react";

const THEME_MODE_STORAGE_KEY = "dgs-theme-mode";

const MANUAL_HIGHLIGHT_RULES: Record<Tone, ManualHighlightRule[]> = {
  [Tone.STANDARD]: [
    { match: "油霧過濾器", tag: "STD: filter urgency" },
  ],
  [Tone.CONCISE]: [
    { match: "庫存", tag: "CON: inventory note" },
    { match: "出貨", tag: "CON: lead time" },
  ],
  [Tone.FORMAL]: [
    { match: "更換週期", tag: "FML: maintenance emphasis" },
  ],
};

function isThemeMode(value: string | null): value is ThemeMode {
  return value === "light" || value === "dark" || value === "system";
}

function resolveTheme(mode: ThemeMode): "light" | "dark" {
  if (mode === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return mode;
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
  const blockIdRef = useRef(0);

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

  const getVariant = (tone: Tone) => response?.variants.find((variant) => variant.tone === tone);
  const standardVariant = getVariant(Tone.STANDARD);
  const conciseVariant = getVariant(Tone.CONCISE);
  const formalVariant = getVariant(Tone.FORMAL);
  const recommendations = response?.recommendedProducts ?? [];

  const riskBadgeClass = useMemo(
    () => (riskLevel: TokenRiskLevel) => {
      if (riskLevel === "high") return "bg-red-100 text-red-700 border-red-200";
      if (riskLevel === "medium") return "bg-yellow-100 text-yellow-700 border-yellow-200";
      return "bg-[var(--surface-secondary)] text-[var(--text-secondary)] border-[var(--border-default)]";
    },
    []
  );

  const confidenceBadgeClass = useMemo(
    () => (confidence: "high" | "medium" | "low") => {
      if (confidence === "high") return "bg-green-100 text-green-700 border-green-200";
      if (confidence === "medium") return "bg-yellow-100 text-yellow-700 border-yellow-200";
      return "bg-[var(--surface-secondary)] text-[var(--text-muted)] border-[var(--border-default)]";
    },
    []
  );

  const addParagraphToComposer = (tone: Tone, paragraph: string) => {
    const text = paragraph.trim();
    if (!text) return;
    blockIdRef.current += 1;
    setComposerBlocks((prev) => [...prev, { id: `block-${blockIdRef.current}`, tone, text }]);
  };

  const handleUpdateComposerBlock = (id: string, value: string) => {
    setComposerBlocks((prev) => prev.map((block) => (block.id === id ? { ...block, text: value } : block)));
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

  return (
    <div className="min-h-screen flex flex-col text-[var(--text-primary)]">
      <Header themeMode={themeMode} resolvedTheme={resolvedTheme} onThemeModeChange={setThemeMode} />

      <main className="flex-1 max-w-[1600px] w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {error && (
          <div
            className="mb-6 border px-4 py-3 rounded-lg flex items-center theme-panel"
            style={{ background: "var(--danger-surface)", borderColor: "var(--danger-border)", color: "var(--danger-text)" }}
          >
            <AlertCircle className="w-5 h-5 mr-2 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_360px] gap-6 pb-12">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="h-full">
              <InputForm onSubmit={handlePolishSubmit} isLoading={isLoading} />
            </div>

            <div className="h-full">
              {standardVariant ? (
                <VariantCard
                  variant={standardVariant}
                  manualHighlightRules={MANUAL_HIGHLIGHT_RULES[Tone.STANDARD]}
                  onAddParagraph={addParagraphToComposer}
                />
              ) : (
                <EmptyState />
              )}
            </div>

            {response && (
              <>
                <div className="h-full">
                  {conciseVariant && (
                    <VariantCard
                      variant={conciseVariant}
                      manualHighlightRules={MANUAL_HIGHLIGHT_RULES[Tone.CONCISE]}
                      onAddParagraph={addParagraphToComposer}
                    />
                  )}
                </div>
                <div className="h-full">
                  {formalVariant && (
                    <VariantCard
                      variant={formalVariant}
                      manualHighlightRules={MANUAL_HIGHLIGHT_RULES[Tone.FORMAL]}
                      onAddParagraph={addParagraphToComposer}
                    />
                  )}
                </div>
              </>
            )}
          </div>

          <div className="h-full xl:sticky xl:top-24 self-start">
            <ClipboardComposer
              blocks={composerBlocks}
              onClear={handleClearComposer}
              onRemoveBlock={handleRemoveComposerBlock}
              onUpdateBlock={handleUpdateComposerBlock}
              onReorderBlocks={handleReorderComposerBlocks}
            />
          </div>
        </div>

        {response && (
          <div className="mb-4 rounded-lg border px-4 py-3 text-sm theme-panel" style={{ borderColor: "var(--brand-soft-border)", background: "var(--brand-soft)", color: "var(--brand-primary)" }}>
            <div className="flex flex-wrap items-center gap-2 mb-1">
              <span>檢索模式：{response.knowledge.retrievalMode}</span>
              <span>知識來源：產品清單（JSON）</span>
              <span>可檢索商品：{response.knowledge.scopedItems}</span>
              <span>命中商品：{response.knowledge.matchedItems}</span>
              <span>TopK：{response.knowledge.retrievedTopK}</span>
              <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${riskBadgeClass(response.knowledge.tokenEstimate.riskLevel)}`}>
                ~{response.knowledge.tokenEstimate.estimatedTotalTokens} tokens ({response.knowledge.tokenEstimate.riskLevel})
              </span>
            </div>
            <div>
              配件意圖：{response.knowledge.queryDiagnostics.accessoryIntent ? "是" : "否"}，未命中說明：
              {response.knowledge.queryDiagnostics.noHitReason ?? "無"}
            </div>
            <div>
              input chars：{response.knowledge.tokenEstimate.inputChars}，input tokens：
              {response.knowledge.tokenEstimate.estimatedInputTokens}
            </div>
            {response.knowledge.tokenEstimate.warning && <div className="mt-2 text-red-600 font-medium">{response.knowledge.tokenEstimate.warning}</div>}
          </div>
        )}

        {response && (
          <div className="mb-6 rounded-lg border border-[var(--border-default)] bg-[var(--surface-primary)] p-4 theme-panel">
            <h3 className="text-sm font-semibold text-[var(--brand-primary)] mb-3">推薦產品卡（產品清單）</h3>
            {recommendations.length === 0 ? (
              <p className="text-sm text-[var(--text-muted)]">本次未產生可追溯推薦卡。</p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                {recommendations.map((item) => (
                  <div key={`${item.rank}-${item.name}-${item.finalCode}`} className="rounded-lg border border-[var(--border-default)] bg-[var(--surface-secondary)] p-3">
                    <div className="flex items-center justify-between mb-2 gap-2">
                      <p className="text-sm font-semibold text-[var(--brand-primary)]">{item.name}</p>
                      <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${confidenceBadgeClass(item.confidence)}`}>{item.confidence}</span>
                    </div>
                    <p className="text-xs text-[var(--text-secondary)] mb-1">最終貨號：{item.finalCode}</p>
                    <p className="text-xs text-[var(--text-secondary)] mb-1">帶頭貨號：{item.headCode}</p>
                    <p className="text-xs text-[var(--text-secondary)] mb-1">推薦原因：{item.reason}</p>
                    <p className="text-xs text-[var(--text-muted)] mb-2">命中證據：{item.evidenceExcerpt || "無"}</p>
                    <a href={item.productUrl} target="_blank" rel="noreferrer" className="text-xs text-[var(--brand-accent)] hover:underline">
                      來源：產品清單最終貨號網址
                    </a>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {response && (
          <details className="mb-6 rounded-lg border border-[var(--border-default)] bg-[var(--surface-primary)] theme-panel" open>
            <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-[var(--brand-primary)]">Debug 面板：產品清單命中（TopK）</summary>
            <div className="border-t border-[var(--border-default)] px-4 py-3 space-y-3">
              <div className="text-xs text-[var(--text-secondary)] rounded-md border border-[var(--border-default)] bg-[var(--surface-secondary)] p-3">
                <p>retrieval mode：{response.knowledge.retrievalMode}</p>
                <p>model tokens：{response.knowledge.queryDiagnostics.modelTokens.join(", ") || "無"}</p>
                <p>alnum tokens：{response.knowledge.queryDiagnostics.alphaNumTokens.join(", ") || "無"}</p>
                <p>chinese terms：{response.knowledge.queryDiagnostics.chineseTerms.join(", ") || "無"}</p>
              </div>

              {response.knowledge.topItems.length === 0 && <p className="text-sm text-[var(--text-muted)]">本次未命中產品清單項目。</p>}
              {response.knowledge.topItems.map((item, index) => (
                <div key={`${item.finalCode}-${item.headCode}-${index}`} className="rounded-md border border-[var(--border-default)] bg-[var(--surface-secondary)] p-3">
                  <p className="text-xs font-semibold text-[var(--brand-primary)] mb-1">
                    {index + 1}. {item.name} | head {item.headCode} | final {item.finalCode} | score {item.score} | chars {item.charCount}
                  </p>
                  <p className="text-xs text-[var(--text-muted)] mb-1">matched: {item.matchedTerms.join(", ") || "none"}</p>
                  <p className="text-xs text-[var(--text-secondary)] mb-1">{item.preview}</p>
                  <a href={item.productUrl} target="_blank" rel="noreferrer" className="text-xs text-[var(--brand-accent)] hover:underline">
                    source link
                  </a>
                </div>
              ))}
            </div>
          </details>
        )}
      </main>
    </div>
  );
};

export default App;
