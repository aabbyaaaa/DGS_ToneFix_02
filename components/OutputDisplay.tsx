import React, { useState } from 'react';
import { PolishedVariant, Tone } from '../types';
import { Copy, Check, MessageSquare } from 'lucide-react';

export const ToneBadge: React.FC<{ tone: Tone }> = ({ tone }) => {
  const styles = {
    [Tone.CONCISE]: 'bg-[#9DC447]/10 text-[#84a93a] border-[#9DC447]/30',
    [Tone.STANDARD]: 'bg-[var(--brand-soft)] text-[var(--brand-primary)] border-[var(--brand-soft-border)]',
    [Tone.FORMAL]: 'bg-[#8188BC]/15 text-[#868ee2] border-[#8188BC]/35',
  };

  const labels = {
    [Tone.CONCISE]: '精簡回覆 (Concise)',
    [Tone.STANDARD]: '標準回覆 (Standard)',
    [Tone.FORMAL]: '正式回覆 (Formal)',
  };

  return <span className={`px-2.5 py-0.5 rounded-full text-xs font-bold border ${styles[tone]}`}>{labels[tone]}</span>;
};

export const VariantCard: React.FC<{ variant: PolishedVariant; className?: string }> = ({ variant, className = '' }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(variant.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy text: ', err);
    }
  };

  const borderClass = {
    [Tone.CONCISE]: 'border-l-[#9DC447]',
    [Tone.STANDARD]: 'border-l-[#26B7BC]',
    [Tone.FORMAL]: 'border-l-[#8188BC]',
  };

  return (
    <div
      className={`bg-[var(--surface-primary)] rounded-xl theme-panel border border-[var(--border-default)] border-l-[6px] ${borderClass[variant.tone]} overflow-hidden hover:shadow-md transition-shadow duration-300 flex flex-col h-full ${className}`}
    >
      <div className="px-4 py-3 border-b border-[var(--border-default)] bg-[var(--surface-primary)] flex justify-between items-center">
        <ToneBadge tone={variant.tone} />
        <button
          onClick={handleCopy}
          className={`p-1.5 rounded-md transition-all ${
            copied ? 'bg-[#9DC447]/20 text-[#7f9f32]' : 'text-[var(--text-muted)] hover:text-[var(--brand-accent)] hover:bg-[var(--brand-soft)]'
          }`}
          title="複製到剪貼簿"
        >
          {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
        </button>
      </div>
      <div className="p-4 flex-1 flex flex-col">
        {variant.subject && (
          <div className="mb-3 pb-3 border-b border-[var(--border-default)] border-dashed">
            <p className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider mb-1 font-semibold">建議主旨</p>
            <p className="text-sm font-medium text-[var(--brand-primary)]">{variant.subject}</p>
          </div>
        )}
        <div className="flex-1">
          <p className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider mb-1 font-semibold">內文</p>
          <div className="text-sm text-[var(--text-secondary)] whitespace-pre-wrap leading-relaxed">{variant.content}</div>
        </div>
        {variant.references && variant.references.length > 0 && (
          <div className="mt-4 pt-3 border-t border-[var(--border-default)]">
            <p className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider mb-1 font-semibold">引用來源</p>
            <div className="space-y-1">
              {variant.references.map((reference, index) => (
                <p key={`${reference.source}-${reference.page}-${index}`} className="text-xs text-[var(--text-muted)]">
                  {reference.source} p.{reference.page}
                </p>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export const EmptyState: React.FC = () => {
  return (
    <div className="h-full flex flex-col items-center justify-center text-[var(--text-muted)] bg-[var(--brand-soft)] rounded-xl border border-dashed border-[var(--brand-soft-border)] p-8 min-h-[300px] theme-panel">
      <div className="bg-[var(--surface-primary)] p-4 rounded-full mb-4 shadow-sm">
        <MessageSquare className="w-8 h-8 text-[var(--brand-accent)]/60" />
      </div>
      <p className="text-center font-medium text-[var(--brand-primary)]">尚未產生內容</p>
      <p className="text-center text-sm mt-1 text-[var(--text-muted)]">請在左側輸入內容並點擊「開始轉換」</p>
    </div>
  );
};
