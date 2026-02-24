import React, { useState } from 'react';
import { PolishRequest } from '../types';
import { Sparkles, Trash2 } from 'lucide-react';

const CATALOG_SECTION_OPTIONS = [
  { section: 'A', label: 'A: 14-176' },
  { section: 'B', label: 'B: 178-229' },
  { section: 'C', label: 'C: 232-252' },
  { section: 'D', label: 'D: 254-307' },
  { section: 'E', label: 'E: 310-600' },
  { section: 'F', label: 'F: 602-627' },
] as const;

interface InputFormProps {
  onSubmit: (data: PolishRequest) => void;
  isLoading: boolean;
}

const InputForm: React.FC<InputFormProps> = ({ onSubmit, isLoading }) => {
  const [sourceText, setSourceText] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [customerTitle, setCustomerTitle] = useState('');
  const [selectedSections, setSelectedSections] = useState<string[]>(['E']);

  const toggleSection = (section: string) => {
    setSelectedSections((prev) => {
      if (prev.includes(section)) {
        return prev.filter((item) => item !== section);
      }
      return [...prev, section].sort();
    });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!sourceText.trim()) return;
    onSubmit({
      sourceText,
      customerName,
      customerTitle,
      useCatalogKnowledge: selectedSections.length > 0,
      catalogSections: selectedSections,
      strictGrounding: true,
      enableFallbackRetrieval: true,
    });
  };

  const handleClear = () => {
    setSourceText('');
    setCustomerName('');
    setCustomerTitle('');
  };

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden h-full flex flex-col">
      <div className="p-4 border-b border-gray-100 bg-[#26B7BC]/5 flex justify-between items-center">
        <h2 className="font-semibold text-[#005787] flex items-center">
          <span className="w-1.5 h-1.5 rounded-full bg-[#26B7BC] mr-2"></span>
          原始輸入
        </h2>
        <button
          onClick={handleClear}
          type="button"
          className="text-xs text-[#898989] hover:text-red-500 flex items-center transition-colors"
        >
          <Trash2 className="w-3 h-3 mr-1" />
          清空
        </button>
      </div>

      <form onSubmit={handleSubmit} className="p-5 flex-1 flex flex-col space-y-4">
        <div className="flex flex-col sm:flex-row gap-4">
          <div className="flex-1">
            <label htmlFor="customerName" className="block text-sm font-medium text-[#005787] mb-1">
              客戶姓氏 (選填)
            </label>
            <input
              type="text"
              id="customerName"
              value={customerName}
              onChange={(e) => setCustomerName(e.target.value)}
              placeholder="例如: 王"
              className="w-full rounded-lg border-gray-300 border px-3 py-2 text-sm focus:ring-2 focus:ring-[#26B7BC] focus:border-transparent outline-none transition-all placeholder:text-gray-300"
              disabled={isLoading}
            />
          </div>
          <div className="flex-1">
            <label htmlFor="customerTitle" className="block text-sm font-medium text-[#005787] mb-1">
              稱謂 (選填)
            </label>
            <input
              type="text"
              id="customerTitle"
              value={customerTitle}
              onChange={(e) => setCustomerTitle(e.target.value)}
              placeholder="例如: 經理 / 小姐"
              className="w-full rounded-lg border-gray-300 border px-3 py-2 text-sm focus:ring-2 focus:ring-[#26B7BC] focus:border-transparent outline-none transition-all placeholder:text-gray-300"
              disabled={isLoading}
            />
          </div>
        </div>

        <div className="flex-1 flex flex-col min-h-[200px]">
          <label htmlFor="sourceText" className="block text-sm font-medium text-[#005787] mb-1">
            技術回覆內容 (必填)
          </label>
          <textarea
            id="sourceText"
            value={sourceText}
            onChange={(e) => setSourceText(e.target.value)}
            placeholder="請貼上您要回覆的技術內容。例如：
關於 ABC-1234 的問題，我們檢測後發現是電壓異常(240V)。建議更換保險絲，規格為 5A。"
            className="flex-1 w-full rounded-lg border-gray-300 border px-4 py-3 text-sm leading-relaxed focus:ring-2 focus:ring-[#26B7BC] focus:border-transparent outline-none resize-none transition-all placeholder:text-gray-300"
            disabled={isLoading}
            required
          />
        </div>

        <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
          <p className="text-sm font-medium text-[#005787] mb-2">套用電子型錄分區（勾哪個查哪個）</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {CATALOG_SECTION_OPTIONS.map((option) => (
              <label key={option.section} className="inline-flex items-center gap-2 text-xs text-[#005787]">
                <input
                  type="checkbox"
                  checked={selectedSections.includes(option.section)}
                  onChange={() => toggleSection(option.section)}
                  className="h-4 w-4 rounded border-gray-300 text-[#26B7BC] focus:ring-[#26B7BC]"
                  disabled={isLoading}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
          <p className="text-[11px] text-gray-500 mt-2">未勾選任何分區時，不會查型錄知識。</p>
        </div>

        <button
          type="submit"
          disabled={isLoading || !sourceText.trim()}
          className={`w-full py-3 px-4 rounded-lg text-white font-medium flex items-center justify-center space-x-2 transition-all shadow-md hover:shadow-lg ${
            isLoading || !sourceText.trim()
              ? 'bg-gray-300 cursor-not-allowed shadow-none'
              : 'bg-[#26B7BC] hover:bg-[#005787] active:transform active:scale-[0.99]'
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
