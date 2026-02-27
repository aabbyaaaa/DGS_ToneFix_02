import React, { useEffect, useMemo, useRef, useState } from "react";
import { PolishedVariant, Tone } from "../types";
import { Check, Copy, MessageSquare } from "lucide-react";

export interface ManualHighlightRule {
  match: string;
  tag: string;
}

interface SelectionPopupState {
  visible: boolean;
  text: string;
  left: number;
  top: number;
}

export function splitVariantParagraphs(content: string): string[] {
  return content
    .split(/\n{2,}/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function normalizeForManualMatch(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[，。！？、；：「」『』（）()\[\]\s]/g, "")
    .trim();
}

export const ToneBadge: React.FC<{ tone: Tone }> = ({ tone }) => {
  const styles = {
    [Tone.CONCISE]: "bg-[#9DC447]/10 text-[#84a93a] border-[#9DC447]/30",
    [Tone.STANDARD]: "bg-[var(--brand-soft)] text-[var(--brand-primary)] border-[var(--brand-soft-border)]",
    [Tone.FORMAL]: "bg-[#8188BC]/15 text-[#868ee2] border-[#8188BC]/35",
  };

  const labels = {
    [Tone.CONCISE]: "精簡回覆 (Concise)",
    [Tone.STANDARD]: "標準回覆 (Standard)",
    [Tone.FORMAL]: "正式回覆 (Formal)",
  };

  return <span className={`px-2.5 py-0.5 rounded-full text-xs font-bold border ${styles[tone]}`}>{labels[tone]}</span>;
};

interface VariantCardProps {
  variant: PolishedVariant;
  className?: string;
  manualHighlightRules?: ManualHighlightRule[];
  onAddParagraph?: (tone: Tone, paragraph: string) => void;
}

export const VariantCard: React.FC<VariantCardProps> = ({ variant, className = "", manualHighlightRules = [], onAddParagraph }) => {
  const [copied, setCopied] = useState(false);
  const [addedIndices, setAddedIndices] = useState<Set<number>>(new Set());
  const [selectionPopup, setSelectionPopup] = useState<SelectionPopupState>({
    visible: false,
    text: "",
    left: 0,
    top: 0,
  });
  const cardRef = useRef<HTMLDivElement | null>(null);
  const popupRef = useRef<HTMLButtonElement | null>(null);
  const paragraphs = useMemo(() => splitVariantParagraphs(variant.content), [variant.content]);

  const toneClassName =
    variant.tone === Tone.STANDARD ? "standard" : variant.tone === Tone.CONCISE ? "concise" : "formal";

  useEffect(() => {
    const handleMouseUp = () => {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) {
        setSelectionPopup((prev) => ({ ...prev, visible: false }));
        return;
      }

      const selectedText = selection.toString().trim();
      if (selectedText.length < 2) {
        setSelectionPopup((prev) => ({ ...prev, visible: false }));
        return;
      }

      const range = selection.getRangeAt(0);
      const ancestor = range.commonAncestorContainer;
      const ancestorElement =
        ancestor.nodeType === Node.ELEMENT_NODE ? (ancestor as Element) : ancestor.parentElement;

      if (!ancestorElement || !cardRef.current?.contains(ancestorElement)) {
        setSelectionPopup((prev) => ({ ...prev, visible: false }));
        return;
      }

      const rect = range.getBoundingClientRect();
      if (!rect || rect.width === 0 || rect.height === 0) {
        setSelectionPopup((prev) => ({ ...prev, visible: false }));
        return;
      }

      setSelectionPopup({
        visible: true,
        text: selectedText,
        left: rect.left + rect.width / 2,
        top: rect.top - 34,
      });
    };

    const handleMouseDown = (event: MouseEvent) => {
      if (!selectionPopup.visible) return;
      if (popupRef.current?.contains(event.target as Node)) return;
      setSelectionPopup((prev) => ({ ...prev, visible: false }));
    };

    document.addEventListener("mouseup", handleMouseUp);
    document.addEventListener("mousedown", handleMouseDown);
    return () => {
      document.removeEventListener("mouseup", handleMouseUp);
      document.removeEventListener("mousedown", handleMouseDown);
    };
  }, [selectionPopup.visible]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(variant.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy text: ", err);
    }
  };

  const markAdded = (index: number) => {
    setAddedIndices((prev) => {
      const next = new Set(prev);
      next.add(index);
      return next;
    });

    window.setTimeout(() => {
      setAddedIndices((prev) => {
        const next = new Set(prev);
        next.delete(index);
        return next;
      });
    }, 1500);
  };

  const handleParagraphClick = (paragraph: string, index: number) => {
    if (!paragraph.trim()) return;
    if (window.getSelection()?.toString().trim()) return;
    onAddParagraph?.(variant.tone, paragraph);
    markAdded(index);
  };

  const handleAddSelection = () => {
    const text = selectionPopup.text.trim();
    if (!text) return;
    onAddParagraph?.(variant.tone, text);
    setSelectionPopup((prev) => ({ ...prev, visible: false }));
    window.getSelection()?.removeAllRanges();
  };

  const borderClass = {
    [Tone.CONCISE]: "border-l-[#9DC447]",
    [Tone.STANDARD]: "border-l-[#26B7BC]",
    [Tone.FORMAL]: "border-l-[#8188BC]",
  };

  return (
    <div
      ref={cardRef}
      className={`bg-[var(--surface-primary)] rounded-xl theme-panel border border-[var(--border-default)] border-l-[6px] ${borderClass[variant.tone]} overflow-hidden hover:shadow-md transition-shadow duration-300 flex flex-col h-full ${className}`}
      id={`card-${variant.tone}`}
    >
      <div className="px-4 py-3 border-b border-[var(--border-default)] bg-[var(--surface-primary)] flex justify-between items-center gap-2">
        <ToneBadge tone={variant.tone} />
        <button
          onClick={handleCopy}
          className={`p-1.5 rounded-md transition-all ${
            copied ? "bg-[#9DC447]/20 text-[#7f9f32]" : "text-[var(--text-muted)] hover:text-[var(--brand-accent)] hover:bg-[var(--brand-soft)]"
          }`}
          title="複製卡片全文"
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
        <div className="flex-1 space-y-1" id={`body-${variant.tone}`}>
          {paragraphs.map((paragraph, index) => {
            const normalizedParagraph = normalizeForManualMatch(paragraph);
            const matchedHighlight = manualHighlightRules.find((rule) =>
              normalizedParagraph.includes(normalizeForManualMatch(rule.match))
            );
            const addedClass = addedIndices.has(index) ? "added" : "";
            const highlightClass = matchedHighlight ? `hl-para hl-${toneClassName}` : "";
            return (
              <div
                key={`${variant.tone}-${index}`}
                className={`click-para text-sm text-[var(--text-secondary)] whitespace-pre-wrap leading-relaxed ${highlightClass} ${addedClass}`}
                onClick={() => handleParagraphClick(paragraph, index)}
              >
                {paragraph}
                {matchedHighlight && (
                  <span className={`hl-tag hl-tag-${toneClassName}`}>{matchedHighlight.tag}</span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {selectionPopup.visible && (
        <button
          ref={popupRef}
          type="button"
          className="sel-popup"
          style={{ left: `${selectionPopup.left}px`, top: `${selectionPopup.top}px` }}
          onClick={handleAddSelection}
        >
          + Add selection
        </button>
      )}
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
