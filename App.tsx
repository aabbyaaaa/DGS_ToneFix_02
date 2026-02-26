import React, { useEffect, useMemo, useState } from 'react';
import Header, { ThemeMode } from './components/Header';
import InputForm from './components/InputForm';
import { VariantCard, EmptyState } from './components/OutputDisplay';
import { polishText } from './services/geminiService';
import { PolishRequest, PolishResponse, Tone, TokenRiskLevel } from './types';
import { AlertCircle } from 'lucide-react';

const THEME_MODE_STORAGE_KEY = 'dgs-theme-mode';

function isThemeMode(value: string | null): value is ThemeMode {
  return value === 'light' || value === 'dark' || value === 'system';
}

function resolveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return mode;
}

const App: React.FC = () => {
  const [isLoading, setIsLoading] = useState(false);
  const [response, setResponse] = useState<PolishResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    if (typeof window === 'undefined') {
      return 'dark';
    }
    const stored = window.localStorage.getItem(THEME_MODE_STORAGE_KEY);
    return isThemeMode(stored) ? stored : 'dark';
  });
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>(() => {
    if (typeof window === 'undefined') {
      return 'dark';
    }
    return resolveTheme(isThemeMode(window.localStorage.getItem(THEME_MODE_STORAGE_KEY)) ? (window.localStorage.getItem(THEME_MODE_STORAGE_KEY) as ThemeMode) : 'dark');
  });

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const root = window.document.documentElement;

    const applyTheme = () => {
      const theme = resolveTheme(themeMode);
      root.setAttribute('data-theme', theme);
      root.setAttribute('data-theme-mode', themeMode);
      setResolvedTheme(theme);
    };

    applyTheme();
    window.localStorage.setItem(THEME_MODE_STORAGE_KEY, themeMode);

    if (themeMode !== 'system') {
      return;
    }

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleThemeChange = () => applyTheme();

    mediaQuery.addEventListener('change', handleThemeChange);
    return () => {
      mediaQuery.removeEventListener('change', handleThemeChange);
    };
  }, [themeMode]);

  const handlePolishSubmit = async (data: PolishRequest) => {
    setIsLoading(true);
    setError(null);
    setResponse(null);

    try {
      const result = await polishText(data);
      setResponse(result);
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : '';
      if (rawMessage.includes('技術回覆內容最多')) {
        setError(rawMessage);
      } else if (rawMessage.includes('Proxy API Error')) {
        setError(`LLM API 呼叫失敗：${rawMessage}`);
      } else if (rawMessage) {
        setError(`處理失敗：${rawMessage}`);
      } else {
        setError('處理您的請求時發生錯誤。請確認網路連線或稍後再試。');
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
  const rejectedCount = response?.knowledge?.validation.rejectedProducts.length ?? 0;

  const riskBadgeClass = useMemo(
    () => (riskLevel: TokenRiskLevel) => {
      if (riskLevel === 'high') return 'bg-red-100 text-red-700 border-red-200';
      if (riskLevel === 'medium') return 'bg-yellow-100 text-yellow-700 border-yellow-200';
      return 'bg-[var(--surface-secondary)] text-[var(--text-secondary)] border-[var(--border-default)]';
    },
    []
  );

  const confidenceBadgeClass = useMemo(
    () => (confidence: 'high' | 'medium' | 'low') => {
      if (confidence === 'high') return 'bg-green-100 text-green-700 border-green-200';
      if (confidence === 'medium') return 'bg-yellow-100 text-yellow-700 border-yellow-200';
      return 'bg-[var(--surface-secondary)] text-[var(--text-muted)] border-[var(--border-default)]';
    },
    []
  );

  const sourceBadgeClass = useMemo(
    () => (source: 'catalog' | 'product_list' | 'both') => {
      if (source === 'both') return 'bg-indigo-100 text-indigo-700 border-indigo-200';
      if (source === 'product_list') return 'bg-teal-100 text-teal-700 border-teal-200';
      return 'bg-sky-100 text-sky-700 border-sky-200';
    },
    []
  );

  return (
    <div className="min-h-screen flex flex-col text-[var(--text-primary)]">
      <Header themeMode={themeMode} resolvedTheme={resolvedTheme} onThemeModeChange={setThemeMode} />

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {error && (
          <div className="mb-6 border px-4 py-3 rounded-lg flex items-center theme-panel" style={{ background: 'var(--danger-surface)', borderColor: 'var(--danger-border)', color: 'var(--danger-text)' }}>
            <AlertCircle className="w-5 h-5 mr-2 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 pb-12">
          <div className="h-full">
            <InputForm onSubmit={handlePolishSubmit} isLoading={isLoading} />
          </div>

          <div className="h-full">{standardVariant ? <VariantCard variant={standardVariant} /> : <EmptyState />}</div>

          {response && (
            <>
              <div className="h-full">{conciseVariant && <VariantCard variant={conciseVariant} />}</div>
              <div className="h-full">{formalVariant && <VariantCard variant={formalVariant} />}</div>
            </>
          )}
        </div>

        {response?.knowledge && (
          <div className="mb-4 rounded-lg border px-4 py-3 text-sm theme-panel" style={{ borderColor: 'var(--brand-soft-border)', background: 'var(--brand-soft)', color: 'var(--brand-primary)' }}>
            <div className="flex flex-wrap items-center gap-2 mb-1">
              <span>檢索模式：{response.knowledge.retrievalMode}</span>
              <span>套用型錄知識：{response.knowledge.enabled ? '是' : '否'}</span>
              <span>分區：{response.knowledge.selectedSections.length > 0 ? response.knowledge.selectedSections.join(', ') : '無'}</span>
              <span>可檢索段落：{response.knowledge.scopedChunks}</span>
              <span>命中段落：{response.knowledge.matchedChunks}</span>
              <span>型錄命中：{response.knowledge.sourceStats.catalogMatched}</span>
              <span>清單命中：{response.knowledge.sourceStats.productListMatched}</span>
              <span>TopK：{response.knowledge.retrievedTopK}</span>
              <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${riskBadgeClass(response.knowledge.tokenEstimate.riskLevel)}`}>
                ~{response.knowledge.tokenEstimate.estimatedTotalTokens} tokens ({response.knowledge.tokenEstimate.riskLevel})
              </span>
            </div>
            <div>
              頁碼：{response.knowledge.matchedPages.length > 0 ? response.knowledge.matchedPages.join(', ') : '無'}，
              fallback：{response.knowledge.queryDiagnostics.fallbackUsed ? '已啟用' : '未啟用'}，
              雙路檢索：{response.knowledge.productList?.enabled ? '已啟用' : '未啟用'}，
              通過驗證產品：{response.knowledge.validation.acceptedProducts}，
              剔除產品：{rejectedCount}
            </div>
            <div>
              input chars：{response.knowledge.tokenEstimate.inputChars}，context chars：{response.knowledge.tokenEstimate.contextChars}，
              input tokens：{response.knowledge.tokenEstimate.estimatedInputTokens}
            </div>
            {response.knowledge.queryDiagnostics.noHitReason && (
              <div className="mt-2 font-medium">未命中說明：{response.knowledge.queryDiagnostics.noHitReason}</div>
            )}
            {response.knowledge.tokenEstimate.warning && <div className="mt-2 text-red-600 font-medium">{response.knowledge.tokenEstimate.warning}</div>}
          </div>
        )}

        {response && (
          <div className="mb-6 rounded-lg border border-[var(--border-default)] bg-[var(--surface-primary)] p-4 theme-panel">
            <h3 className="text-sm font-semibold text-[var(--brand-primary)] mb-3">推薦產品卡（LLM版，嚴格可追溯）</h3>
            {recommendations.length === 0 ? (
              <p className="text-sm text-[var(--text-muted)]">本次未產生可追溯推薦卡。</p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                {recommendations.map((item) => (
                  <div key={`${item.rank}-${item.name}-${item.finalCode ?? item.page ?? 'x'}`} className="rounded-lg border border-[var(--border-default)] bg-[var(--surface-secondary)] p-3">
                    <div className="flex items-center justify-between mb-2 gap-2">
                      <p className="text-sm font-semibold text-[var(--brand-primary)]">{item.name}</p>
                      <div className="flex items-center gap-1">
                        <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${sourceBadgeClass(item.source)}`}>{item.source}</span>
                        <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${confidenceBadgeClass(item.confidence)}`}>{item.confidence}</span>
                      </div>
                    </div>
                    <p className="text-xs text-[var(--text-secondary)] mb-1">型號：{item.models.length > 0 ? item.models.join('、') : '未提供'}</p>
                    {item.finalCode && <p className="text-xs text-[var(--text-secondary)] mb-1">最終貨號：{item.finalCode}</p>}
                    {item.headCode && <p className="text-xs text-[var(--text-secondary)] mb-1">帶頭貨號：{item.headCode}</p>}
                    <p className="text-xs text-[var(--text-secondary)] mb-1">推薦原因：{item.reason}</p>
                    <p className="text-xs text-[var(--text-muted)] mb-1">命中證據：{item.evidenceExcerpt || '無'}</p>
                    <p className="text-xs text-[var(--text-muted)] mb-2">來源語氣：{item.tones.join(', ')}</p>
                    {item.productUrl ? (
                      <a href={item.productUrl} target="_blank" rel="noreferrer" className="text-xs text-[var(--brand-accent)] hover:underline">
                        來源：產品清單最終貨號網址
                      </a>
                    ) : item.catalogUrl ? (
                      <a href={item.catalogUrl} target="_blank" rel="noreferrer" className="text-xs text-[var(--brand-accent)] hover:underline">
                        來源：{item.section ?? '-'} 區，第 {item.page ?? '-'} 頁
                      </a>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {response?.knowledge?.enabled && (
          <details className="mb-6 rounded-lg border border-[var(--border-default)] bg-[var(--surface-primary)] theme-panel" open>
            <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-[var(--brand-primary)]">Debug 面板：命中 Context（TopK）</summary>
            <div className="border-t border-[var(--border-default)] px-4 py-3 space-y-3">
              <div className="text-xs text-[var(--text-secondary)] rounded-md border border-[var(--border-default)] bg-[var(--surface-secondary)] p-3">
                <p>retrieval mode：{response.knowledge.retrievalMode}</p>
                <p>fallback：{response.knowledge.queryDiagnostics.fallbackUsed ? '已啟用' : '未啟用'}</p>
                <p>no-hit reason：{response.knowledge.queryDiagnostics.noHitReason ?? '無'}</p>
                <p>model tokens：{response.knowledge.queryDiagnostics.modelTokens.join(', ') || '無'}</p>
                <p>alnum tokens：{response.knowledge.queryDiagnostics.alphaNumTokens.join(', ') || '無'}</p>
                <p>chinese terms：{response.knowledge.queryDiagnostics.chineseTerms.join(', ') || '無'}</p>
                <p>
                  validation：accepted {response.knowledge.validation.acceptedProducts} / rejected {rejectedCount}
                </p>
                <p>
                  source stats：catalog {response.knowledge.sourceStats.catalogMatched} / product-list {response.knowledge.sourceStats.productListMatched}
                </p>
              </div>

              {response.knowledge.mergedContext.length === 0 && <p className="text-sm text-[var(--text-muted)]">本次未命中雙路檢索 context。</p>}
              {response.knowledge.mergedContext.map((item, index) => (
                <div key={`${item.source}-${item.url}-${index}`} className="rounded-md border border-[var(--border-default)] bg-[var(--surface-secondary)] p-3">
                  <p className="text-xs font-semibold text-[var(--brand-primary)] mb-1">
                    M{index + 1} | source {item.source} | score {item.score} | chars {item.charCount}
                    {item.page ? ` | page ${item.page}` : ''}
                    {item.finalCode ? ` | final ${item.finalCode}` : ''}
                  </p>
                  <p className="text-xs text-[var(--text-muted)] mb-1">matched: {item.matchedTerms.length > 0 ? item.matchedTerms.join(', ') : 'none'}</p>
                  <p className="text-xs text-[var(--text-secondary)] whitespace-pre-wrap leading-relaxed mb-1">{item.preview}</p>
                  <a href={item.url} target="_blank" rel="noreferrer" className="text-xs text-[var(--brand-accent)] hover:underline">
                    source link
                  </a>
                </div>
              ))}

              {rejectedCount > 0 && (
                <div className="rounded-md border border-red-300 bg-red-100/80 p-3 text-red-800">
                  <p className="text-xs font-semibold mb-1">被剔除的推薦產品</p>
                  {response.knowledge.validation.rejectedProducts.map((item, index) => (
                    <p key={`${item.name}-${item.page}-${index}`} className="text-xs">
                      {item.name}（p.{item.page}）：{item.reason}
                    </p>
                  ))}
                </div>
              )}

              {response.knowledge.topChunks.length === 0 && <p className="text-sm text-[var(--text-muted)]">本次未命中型錄 chunk。</p>}
              {response.knowledge.topChunks.map((chunk, index) => (
                <div key={chunk.id} className="rounded-md border border-[var(--border-default)] bg-[var(--surface-secondary)] p-3">
                  <p className="text-xs font-semibold text-[var(--brand-primary)] mb-1">
                    Chunk {index + 1} | section {chunk.section || '-'} | page {chunk.page} | score {chunk.score} | chars {chunk.charCount}
                  </p>
                  <p className="text-xs text-[var(--text-muted)] mb-1">matched: {chunk.matchedTerms.length > 0 ? chunk.matchedTerms.join(', ') : 'none'}</p>
                  <p className="text-xs text-[var(--text-secondary)] whitespace-pre-wrap leading-relaxed">{chunk.text}</p>
                </div>
              ))}

              {response.knowledge.productList && response.knowledge.productList.topItems.length > 0 && (
                <div className="rounded-md border border-[var(--border-default)] bg-[var(--surface-secondary)] p-3">
                  <p className="text-xs font-semibold text-[var(--brand-primary)] mb-2">產品清單命中（TopK）</p>
                  {response.knowledge.productList.topItems.map((item, index) => (
                    <p key={`${item.finalCode}-${item.headCode}-${index}`} className="text-xs text-[var(--text-secondary)] mb-1">
                      {index + 1}. {item.name} | final {item.finalCode} | head {item.headCode} | score {item.score} | matched {item.matchedTerms.join(', ') || 'none'} |{' '}
                      <a href={item.productUrl} target="_blank" rel="noreferrer" className="text-[var(--brand-accent)] hover:underline">
                        link
                      </a>
                    </p>
                  ))}
                </div>
              )}
            </div>
          </details>
        )}
      </main>
    </div>
  );
};

export default App;



