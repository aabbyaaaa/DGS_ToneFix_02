import React, { useRef, useState } from "react";
import { PolishRequest } from "../types";
import { ImagePlus, LoaderCircle, Sparkles, Trash2, Upload } from "lucide-react";
import { extractTextFromImage } from "../services/ocrService";

const MAX_SOURCE_TEXT_LENGTH = 1000;
const SOURCE_TEXT_WARNING_THRESHOLD = 900;
const ACCEPTED_IMAGE_TYPES = "image/png,image/jpeg,image/jpg,image/webp";

interface InputFormProps {
  onSubmit: (data: PolishRequest) => void;
  isLoading: boolean;
}

const InputForm: React.FC<InputFormProps> = ({ onSubmit, isLoading }) => {
  const [sourceText, setSourceText] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [customerTitle, setCustomerTitle] = useState("");
  const [isSourceTextTruncated, setIsSourceTextTruncated] = useState(false);
  const [isOcrLoading, setIsOcrLoading] = useState(false);
  const [ocrStatus, setOcrStatus] = useState<string | null>(null);
  const [ocrError, setOcrError] = useState<string | null>(null);
  const [lastOcrImageName, setLastOcrImageName] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleSourceTextChange = (value: string) => {
    const trimmedValue = value.slice(0, MAX_SOURCE_TEXT_LENGTH);
    setSourceText(trimmedValue);
    setIsSourceTextTruncated(value.length > MAX_SOURCE_TEXT_LENGTH);
  };

  const appendOcrText = (ocrText: string) => {
    const normalizedOcrText = ocrText.trim();
    if (!normalizedOcrText) {
      return;
    }

    setSourceText((current) => {
      const combined = current.trim()
        ? `${current.trimEnd()}\n\n${normalizedOcrText}`
        : normalizedOcrText;
      setIsSourceTextTruncated(combined.length > MAX_SOURCE_TEXT_LENGTH);
      return combined.slice(0, MAX_SOURCE_TEXT_LENGTH);
    });
  };

  const runOcr = async (file: File, sourceLabel: string) => {
    setOcrError(null);
    setOcrStatus("OCR 辨識中...");
    setIsOcrLoading(true);

    try {
      const result = await extractTextFromImage(file);
      appendOcrText(result.text);
      setLastOcrImageName(file.name || sourceLabel);
      setOcrStatus(`OCR 完成：新增 ${result.charCount} 字`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "OCR 失敗，請稍後再試";
      setOcrError(message);
      setOcrStatus(null);
    } finally {
      setIsOcrLoading(false);
    }
  };

  const handleImageSelect = (file: File | null, sourceLabel: string) => {
    if (!file) {
      return;
    }
    void runOcr(file, sourceLabel);
  };

  const handleChooseFile = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const [file] = Array.from(event.target.files ?? []);
    handleImageSelect(file ?? null, "上傳圖片");
    event.target.value = "";
  };

  const handleTextareaPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(event.clipboardData.items ?? []);
    const imageItem = items.find((item) => item.type.startsWith("image/"));
    if (!imageItem) {
      return;
    }
    const file = imageItem.getAsFile();
    if (!file) {
      return;
    }
    event.preventDefault();
    handleImageSelect(file, "貼上圖片");
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragOver(false);
    const [file] = Array.from(event.dataTransfer.files ?? []);
    handleImageSelect(file ?? null, "拖拉圖片");
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!sourceText.trim()) return;
    onSubmit({
      sourceText,
      customerName,
      customerTitle,
    });
  };

  const handleClear = () => {
    setSourceText("");
    setCustomerName("");
    setCustomerTitle("");
    setIsSourceTextTruncated(false);
    setIsOcrLoading(false);
    setOcrStatus(null);
    setOcrError(null);
    setLastOcrImageName(null);
  };

  const sourceTextLength = sourceText.length;
  const sourceTextCounterClass =
    sourceTextLength >= MAX_SOURCE_TEXT_LENGTH
      ? "text-red-500"
      : sourceTextLength >= SOURCE_TEXT_WARNING_THRESHOLD
      ? "text-amber-500"
      : "text-[var(--text-muted)]";

  return (
    <div className="bg-[var(--surface-primary)] rounded-xl theme-panel border border-[var(--border-default)] px-3 py-3">
      <form onSubmit={handleSubmit} className="flex flex-col gap-2">
        <div className="flex items-stretch gap-2 min-w-0">
          <div className="w-[116px] shrink-0 flex flex-col gap-2">
            <input
              type="text"
              value={customerName}
              onChange={(event) => setCustomerName(event.target.value)}
              placeholder="客戶姓氏"
              className="h-[26px] rounded-md border border-[var(--border-default)] bg-[var(--surface-secondary)] px-2 text-xs text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
              disabled={isLoading || isOcrLoading}
            />
            <input
              type="text"
              value={customerTitle}
              onChange={(event) => setCustomerTitle(event.target.value)}
              placeholder="稱謂"
              className="h-[26px] rounded-md border border-[var(--border-default)] bg-[var(--surface-secondary)] px-2 text-xs text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
              disabled={isLoading || isOcrLoading}
            />
          </div>

          <div
            className={`flex-1 min-w-0 rounded-lg border p-2 transition-colors ${
              isDragOver
                ? "border-[var(--brand-accent)] bg-[var(--brand-soft)]"
                : "border-[var(--border-default)] bg-[var(--surface-secondary)]"
            }`}
            onDragOver={(event) => {
              event.preventDefault();
              setIsDragOver(true);
            }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={handleDrop}
          >
            <textarea
              value={sourceText}
              onChange={(event) => handleSourceTextChange(event.target.value)}
              onPaste={handleTextareaPaste}
              maxLength={MAX_SOURCE_TEXT_LENGTH}
              placeholder="請貼上技術回覆，可貼上/拖拉圖片做 OCR"
              className="w-full h-[60px] rounded-md border border-[var(--border-default)] bg-[var(--surface-primary)] px-3 py-2 text-sm text-[var(--text-primary)] leading-relaxed outline-none resize-none placeholder:text-[var(--text-muted)]"
              disabled={isLoading || isOcrLoading}
              required
            />
            <div className="mt-1 min-h-4 text-[11px]">
              {isOcrLoading && (
                <p className="flex items-center gap-1 text-[var(--brand-primary)]">
                  <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                  OCR 辨識中...
                </p>
              )}
              {!isOcrLoading && ocrStatus && (
                <p className="flex items-center gap-1 text-emerald-600">
                  <ImagePlus className="h-3.5 w-3.5" />
                  {ocrStatus}
                  {lastOcrImageName ? `（${lastOcrImageName}）` : ""}
                </p>
              )}
              {ocrError && <p className="text-red-500">{ocrError}</p>}
            </div>
          </div>

          <button
            type="button"
            onClick={handleChooseFile}
            disabled={isLoading || isOcrLoading}
            className="h-[60px] w-[68px] shrink-0 rounded-lg border border-[var(--border-default)] bg-[var(--surface-secondary)] text-[11px] text-[var(--text-secondary)] hover:text-[var(--brand-primary)] disabled:opacity-50 disabled:cursor-not-allowed flex flex-col items-center justify-center gap-1"
            title="上傳圖片 OCR"
          >
            <Upload className="h-3.5 w-3.5" />
            OCR
          </button>

          <button
            type="submit"
            disabled={isLoading || isOcrLoading || !sourceText.trim()}
            className={`h-[60px] w-[108px] shrink-0 rounded-lg text-white text-sm font-semibold flex flex-col items-center justify-center gap-1 transition-colors ${
              isLoading || isOcrLoading || !sourceText.trim()
                ? "bg-slate-400 cursor-not-allowed"
                : "submit-btn"
            }`}
          >
            {isLoading ? (
              <>
                <LoaderCircle className="h-4 w-4 animate-spin" />
                轉換中...
              </>
            ) : (
              <>
                <Sparkles className="h-4 w-4" />
                開始轉換
              </>
            )}
          </button>
        </div>

        <div className="flex items-center gap-3 text-xs">
          <span className={sourceTextCounterClass}>
            {sourceTextLength}/{MAX_SOURCE_TEXT_LENGTH} 字
          </span>
          <span className="text-[var(--text-muted)]">
            {isSourceTextTruncated
              ? "已超過 1000 字，系統已自動截斷。"
              : "可貼上技術文字、截圖或拖拉圖片。"}
          </span>
          <button
            type="button"
            onClick={handleClear}
            className="ml-auto inline-flex items-center gap-1 text-[var(--text-muted)] hover:text-red-500 transition-colors"
          >
            <Trash2 className="w-3 h-3" />
            清空
          </button>
        </div>
      </form>

      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPTED_IMAGE_TYPES}
        onChange={handleFileChange}
        className="hidden"
      />
    </div>
  );
};

export default InputForm;

