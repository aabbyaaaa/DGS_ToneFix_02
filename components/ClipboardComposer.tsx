import React, { useState } from "react";
import { Tone } from "../types";
import { Check, Copy, Trash2 } from "lucide-react";

export interface ComposerBlock {
  id: string;
  tone: Tone;
  text: string;
}

interface ClipboardComposerProps {
  blocks: ComposerBlock[];
  onClear: () => void;
  onRemoveBlock: (id: string) => void;
  onUpdateBlock: (id: string, value: string) => void;
  onReorderBlocks: (fromIndex: number, toIndex: number) => void;
}

function toneLabel(tone: Tone): string {
  if (tone === Tone.CONCISE) return "精簡";
  if (tone === Tone.STANDARD) return "標準";
  return "正式";
}

function toneBadgeClass(tone: Tone): string {
  if (tone === Tone.CONCISE) return "bg-[#9DC447]/10 text-[#84a93a] border-[#9DC447]/30";
  if (tone === Tone.STANDARD) return "bg-[var(--brand-soft)] text-[var(--brand-primary)] border-[var(--brand-soft-border)]";
  return "bg-[#8188BC]/15 text-[#868ee2] border-[#8188BC]/35";
}

const ClipboardComposer: React.FC<ClipboardComposerProps> = ({
  blocks,
  onClear,
  onRemoveBlock,
  onUpdateBlock,
  onReorderBlocks,
}) => {
  const [copied, setCopied] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  const handleCopy = async () => {
    const text = blocks
      .map((block) => block.text.trim())
      .filter(Boolean)
      .join("\n\n");
    if (!text.trim()) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch (error) {
      console.error("Failed to copy composed content:", error);
    }
  };

  return (
    <div className="bg-[var(--surface-primary)] rounded-xl theme-panel border border-[var(--border-default)] overflow-hidden h-full flex flex-col">
      <div className="p-4 border-b border-[var(--border-default)] bg-[var(--brand-soft)] flex justify-between items-center">
        <div className="flex items-center gap-2">
          <h2 className="font-semibold text-[var(--brand-primary)]">剪貼區（Clipboard Composer）</h2>
          <span className="text-xs rounded-full px-2 py-0.5 border border-[var(--border-default)] text-[var(--text-muted)]">
            {blocks.length}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onClear}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold border border-[var(--border-default)] text-red-400 hover:bg-red-500/10 transition-colors"
            title="清空"
          >
            <span className="inline-flex items-center gap-1">
              <Trash2 className="w-3 h-3" />
              Clear
            </span>
          </button>
        </div>
      </div>

      <div className="p-4 flex-1 flex flex-col gap-3 min-h-[320px]">
        <div className="flex-1 overflow-auto space-y-2 pr-1">
          {blocks.length === 0 ? (
            <div className="rounded-lg border border-dashed border-[var(--brand-soft-border)] bg-[var(--brand-soft)] p-4 text-sm text-[var(--text-muted)]">
              Click paragraphs or select text to add.
            </div>
          ) : (
            blocks.map((block, index) => (
              <div
                key={block.id}
                className={`clip-item ${dragIndex === index ? "dragging" : ""} ${dragOverIndex === index ? "drag-over" : ""}`}
                draggable
                onDragStart={() => setDragIndex(index)}
                onDragEnd={() => {
                  setDragIndex(null);
                  setDragOverIndex(null);
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                  setDragOverIndex(index);
                }}
                onDragLeave={() => {
                  if (dragOverIndex === index) {
                    setDragOverIndex(null);
                  }
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  if (dragIndex !== null && dragIndex !== index) {
                    onReorderBlocks(dragIndex, index);
                  }
                  setDragIndex(null);
                  setDragOverIndex(null);
                }}
              >
                <div className="clip-item-header">
                  <div className="flex items-center gap-2">
                    <span style={{ color: "var(--text-muted)", cursor: "grab" }}>&#9776;</span>
                    <span className={`tone-badge text-[10px] px-2 py-0.5 ${toneBadgeClass(block.tone)}`}>
                      {toneLabel(block.tone)}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => onRemoveBlock(block.id)}
                    className="w-6 h-6 flex items-center justify-center rounded text-[var(--text-muted)] hover:text-red-400 hover:bg-red-500/10 transition-colors text-sm"
                    title="刪除"
                  >
                    &#10005;
                  </button>
                </div>
                <div
                  className="clip-item-content"
                  contentEditable
                  suppressContentEditableWarning
                  onInput={(event) => onUpdateBlock(block.id, event.currentTarget.textContent ?? "")}
                >
                  {block.text}
                </div>
              </div>
            ))
          )}
        </div>

        <button
          type="button"
          onClick={handleCopy}
          className={`w-full rounded-lg border px-3 py-2 text-sm font-semibold transition-colors ${
            copied
              ? "border-[#9DC447]/40 bg-[#9DC447]/10 text-[#7f9f32]"
              : "border-[var(--brand-soft-border)] bg-[var(--brand-soft)] text-[var(--brand-primary)] hover:bg-[var(--surface-secondary)]"
          }`}
        >
          {copied ? (
            <span className="inline-flex items-center gap-1">
              <Check className="w-4 h-4" />
              Copied!
            </span>
          ) : (
            <span className="inline-flex items-center gap-1">
              <Copy className="w-4 h-4" />
              Copy All
            </span>
          )}
        </button>
      </div>
    </div>
  );
};

export default ClipboardComposer;
