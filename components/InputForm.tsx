import React, { useRef, useState } from 'react';
import { PolishRequest } from '../types';
import { ImagePlus, LoaderCircle, Sparkles, Trash2, Upload } from 'lucide-react';
import { extractTextFromImage } from '../services/ocrService';

const MAX_SOURCE_TEXT_LENGTH = 1000;
const SOURCE_TEXT_WARNING_THRESHOLD = 900;
const ACCEPTED_IMAGE_TYPES = 'image/png,image/jpeg,image/jpg,image/webp';

interface InputFormProps {
  onSubmit: (data: PolishRequest) => void;
  isLoading: boolean;
}

const InputForm: React.FC<InputFormProps> = ({ onSubmit, isLoading }) => {
  const [sourceText, setSourceText] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [customerTitle, setCustomerTitle] = useState('');
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
      const combined = current.trim() ? `${current.trimEnd()}\n\n${normalizedOcrText}` : normalizedOcrText;
      setIsSourceTextTruncated(combined.length > MAX_SOURCE_TEXT_LENGTH);
      return combined.slice(0, MAX_SOURCE_TEXT_LENGTH);
    });
  };

  const runOcr = async (file: File, sourceLabel: string) => {
    setOcrError(null);
    setOcrStatus('OCR 辨識中...');
    setIsOcrLoading(true);

    try {
      const result = await extractTextFromImage(file);
      appendOcrText(result.text);
      setLastOcrImageName(file.name || sourceLabel);
      setOcrStatus(`OCR 完成：新增 ${result.charCount} 字`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'OCR 失敗，請稍後再試';
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
    handleImageSelect(file ?? null, '上傳圖片');
    event.target.value = '';
  };

  const handleTextareaPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(event.clipboardData.items ?? []);
    const imageItem = items.find((item) => item.type.startsWith('image/'));
    if (!imageItem) {
      return;
    }
    const file = imageItem.getAsFile();
    if (!file) {
      return;
    }
    event.preventDefault();
    handleImageSelect(file, '貼上圖片');
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragOver(false);
    const [file] = Array.from(event.dataTransfer.files ?? []);
    handleImageSelect(file ?? null, '拖拉圖片');
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!sourceText.trim()) return;
    onSubmit({
      sourceText,
      customerName,
      customerTitle,
    });
  };

  const handleClear = () => {
    setSourceText('');
    setCustomerName('');
    setCustomerTitle('');
    setIsSourceTextTruncated(false);
    setIsOcrLoading(false);
    setOcrStatus(null);
    setOcrError(null);
    setLastOcrImageName(null);
  };

  const sourceTextLength = sourceText.length;
  const sourceTextCounterClass =
    sourceTextLength >= MAX_SOURCE_TEXT_LENGTH
      ? 'text-red-500'
      : sourceTextLength >= SOURCE_TEXT_WARNING_THRESHOLD
        ? 'text-amber-500'
        : 'text-[var(--text-muted)]';

  return (
    <div className="bg-[var(--surface-primary)] rounded-xl theme-panel border border-[var(--border-default)] overflow-hidden h-full flex flex-col">
      <div className="p-4 border-b border-[var(--border-default)] bg-[var(--brand-soft)] flex justify-between items-center">
        <h2 className="font-semibold text-[var(--brand-primary)] flex items-center">
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--brand-accent)] mr-2"></span>
          原始輸入
        </h2>
        <button
          onClick={handleClear}
          type="button"
          className="text-xs text-[var(--text-muted)] hover:text-red-500 flex items-center transition-colors"
        >
          <Trash2 className="w-3 h-3 mr-1" />
          清空
        </button>
      </div>

      <form onSubmit={handleSubmit} className="p-5 flex-1 flex flex-col space-y-4">
        <div className="flex flex-col sm:flex-row gap-4">
          <div className="flex-1">
            <label htmlFor="customerName" className="block text-sm font-medium text-[var(--brand-primary)] mb-1">
              客戶姓氏 (選填)
            </label>
            <input
              type="text"
              id="customerName"
              value={customerName}
              onChange={(e) => setCustomerName(e.target.value)}
              placeholder="例如: 王"
              className="w-full rounded-lg border border-[var(--border-default)] bg-[var(--surface-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none transition-all placeholder:text-[var(--text-muted)]"
              disabled={isLoading}
            />
          </div>
          <div className="flex-1">
            <label htmlFor="customerTitle" className="block text-sm font-medium text-[var(--brand-primary)] mb-1">
              稱謂 (選填)
            </label>
            <input
              type="text"
              id="customerTitle"
              value={customerTitle}
              onChange={(e) => setCustomerTitle(e.target.value)}
              placeholder="例如: 經理 / 小姐"
              className="w-full rounded-lg border border-[var(--border-default)] bg-[var(--surface-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none transition-all placeholder:text-[var(--text-muted)]"
              disabled={isLoading}
            />
          </div>
        </div>

        <div className="flex-1 flex flex-col min-h-[200px]">
          <div className="mb-1 flex items-center justify-between gap-2">
            <label htmlFor="sourceText" className="block text-sm font-medium text-[var(--brand-primary)]">
              技術回覆內容 (必填)
            </label>
            <span className={`text-xs font-medium ${sourceTextCounterClass}`}>
              {sourceTextLength}/{MAX_SOURCE_TEXT_LENGTH}
            </span>
          </div>
          <textarea
            id="sourceText"
            value={sourceText}
            onChange={(e) => handleSourceTextChange(e.target.value)}
            onPaste={handleTextareaPaste}
            maxLength={MAX_SOURCE_TEXT_LENGTH}
            placeholder="請貼上您要回覆的技術內容。例如：
關於 ABC-1234 的問題，我們檢測後發現是電壓異常(240V)。建議更換保險絲，規格為 5A。"
            className="flex-1 w-full rounded-lg border border-[var(--border-default)] bg-[var(--surface-secondary)] px-4 py-3 text-sm text-[var(--text-primary)] leading-relaxed outline-none resize-none transition-all placeholder:text-[var(--text-muted)]"
            disabled={isLoading}
            required
          />
          <p className={`mt-1 text-xs ${isSourceTextTruncated ? 'text-red-500' : 'text-[var(--text-muted)]'}`}>
            {isSourceTextTruncated
              ? '已超過 1000 字，系統已自動截斷。'
              : '最多 1000 字（剛好 1000 字可送出）。'}
          </p>
        </div>

        <div
          className={`rounded-lg border border-dashed p-3 transition-colors ${
            isDragOver ? 'border-[var(--brand-accent)] bg-[var(--brand-soft)]' : 'border-[var(--border-default)] bg-[var(--surface-secondary)]'
          }`}
          onDragOver={(event) => {
            event.preventDefault();
            setIsDragOver(true);
          }}
          onDragLeave={() => setIsDragOver(false)}
          onDrop={handleDrop}
        >
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleChooseFile}
              disabled={isLoading || isOcrLoading}
              className="inline-flex items-center gap-1 rounded-md border border-[var(--border-default)] bg-[var(--surface-primary)] px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--brand-primary)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Upload className="h-3.5 w-3.5" />
              上傳圖片 OCR
            </button>
            <span className="text-xs text-[var(--text-muted)]">也可把圖片直接貼到上方文字框，或拖拉到此區</span>
          </div>
          <input ref={fileInputRef} type="file" accept={ACCEPTED_IMAGE_TYPES} onChange={handleFileChange} className="hidden" />

          <div className="mt-2 min-h-5 text-xs">
            {isOcrLoading && (
              <p className="flex items-center gap-1 text-[var(--brand-primary)]">
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                OCR 辨識中，請稍候...
              </p>
            )}
            {!isOcrLoading && ocrStatus && (
              <p className="flex items-center gap-1 text-emerald-600">
                <ImagePlus className="h-3.5 w-3.5" />
                {ocrStatus}
                {lastOcrImageName ? `（${lastOcrImageName}）` : ''}
              </p>
            )}
            {ocrError && <p className="text-red-500">{ocrError}</p>}
          </div>
        </div>

        <div className="rounded-lg border border-[var(--border-default)] bg-[var(--surface-secondary)] p-3 text-xs text-[var(--text-secondary)]">
          產品推薦檢索固定使用產品清單資料（`product_list_index.json`），不再依賴型錄分區。
        </div>

        <button
          type="submit"
          disabled={isLoading || isOcrLoading || !sourceText.trim()}
          className={`w-full py-3 px-4 rounded-lg text-white font-medium flex items-center justify-center space-x-2 transition-all shadow-md hover:shadow-lg ${
            isLoading || isOcrLoading || !sourceText.trim() ? 'bg-slate-400 cursor-not-allowed shadow-none' : 'submit-btn active:transform active:scale-[0.99]'
          }`}
        >
          {isLoading ? (
            <>
              <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              <span>正在進行禮貌化轉換...</span>
            </>
          ) : (
            <>
              <Sparkles className="w-5 h-5" />
              <span>開始轉換</span>
            </>
          )}
        </button>
      </form>
    </div>
  );
};

export default InputForm;
