import React, { useState } from 'react';
import { PolishedVariant, Tone } from '../types';
import { Copy, Check, MessageSquare } from 'lucide-react';

// Brand Colors:
// Concise (Green): #9DC447
// Standard (Turquoise): #26B7BC
// Formal (Purple): #8188BC

export const ToneBadge: React.FC<{ tone: Tone }> = ({ tone }) => {
  // Using specific brand colors for badges with light backgrounds
  const styles = {
    [Tone.CONCISE]: "bg-[#9DC447]/10 text-[#9DC447] border-[#9DC447]/20",
    [Tone.STANDARD]: "bg-[#26B7BC]/10 text-[#005787] border-[#26B7BC]/20",
    [Tone.FORMAL]: "bg-[#8188BC]/10 text-[#8188BC] border-[#8188BC]/20",
  };

  const labels = {
    [Tone.CONCISE]: "精簡回覆 (Concise)",
    [Tone.STANDARD]: "標準回覆 (Standard)",
    [Tone.FORMAL]: "正式回覆 (Formal)",
  };

  return (
    <span className={`px-2.5 py-0.5 rounded-full text-xs font-bold border ${styles[tone]}`}>
      {labels[tone]}
    </span>
  );
};

export const VariantCard: React.FC<{ variant: PolishedVariant; className?: string }> = ({ variant, className = "" }) => {
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

  // Define border color based on tone
  const borderClass = {
    [Tone.CONCISE]: "border-l-[#9DC447]",
    [Tone.STANDARD]: "border-l-[#26B7BC]",
    [Tone.FORMAL]: "border-l-[#8188BC]",
  };

  return (
    <div className={`bg-white rounded-xl shadow-sm border border-gray-200 border-l-[6px] ${borderClass[variant.tone]} overflow-hidden hover:shadow-md transition-shadow duration-300 flex flex-col h-full ${className}`}>
      <div className="px-4 py-3 border-b border-gray-100 bg-white flex justify-between items-center">
        <ToneBadge tone={variant.tone} />
        <button
          onClick={handleCopy}
          className={`p-1.5 rounded-md transition-all ${
            copied 
              ? 'bg-[#9DC447]/20 text-[#9DC447]' 
              : 'text-[#898989] hover:text-[#26B7BC] hover:bg-[#26B7BC]/10'
          }`}
          title="複製到剪貼簿"
        >
          {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
        </button>
      </div>
      <div className="p-4 flex-1 flex flex-col">
        {variant.subject && (
          <div className="mb-3 pb-3 border-b border-gray-100 border-dashed">
             <p className="text-[10px] text-[#898989] uppercase tracking-wider mb-1 font-semibold">建議主旨</p>
             <p className="text-sm font-medium text-[#005787]">{variant.subject}</p>
          </div>
        )}
        <div className="flex-1">
            <p className="text-[10px] text-[#898989] uppercase tracking-wider mb-1 font-semibold">內文</p>
            <div className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">
            {variant.content}
            </div>
        </div>
        {variant.references && variant.references.length > 0 && (
          <div className="mt-4 pt-3 border-t border-gray-100">
            <p className="text-[10px] text-[#898989] uppercase tracking-wider mb-1 font-semibold">引用來源</p>
            <div className="space-y-1">
              {variant.references.map((reference, index) => (
                <p key={`${reference.source}-${reference.page}-${index}`} className="text-xs text-gray-500">
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
    <div className="h-full flex flex-col items-center justify-center text-[#898989] bg-[#26B7BC]/5 rounded-xl border border-dashed border-[#26B7BC]/30 p-8 min-h-[300px]">
      <div className="bg-white p-4 rounded-full mb-4 shadow-sm">
        <MessageSquare className="w-8 h-8 text-[#26B7BC]/50" />
      </div>
      <p className="text-center font-medium text-[#005787]">尚未產生內容</p>
      <p className="text-center text-sm mt-1">請在左側輸入內容並點擊「開始轉換」</p>
    </div>
  );
};
