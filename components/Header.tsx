import React from 'react';
import { Zap, Cpu, Sun, Moon, Monitor } from 'lucide-react';
import { MODEL_NAME } from '../services/geminiService';

export type ThemeMode = 'light' | 'dark' | 'system';

interface HeaderProps {
  themeMode: ThemeMode;
  resolvedTheme: 'light' | 'dark';
  onThemeModeChange: (mode: ThemeMode) => void;
}

const themeOptions: Array<{ mode: ThemeMode; label: string; icon: React.ReactNode }> = [
  { mode: 'light', label: '淺色', icon: <Sun className="h-3.5 w-3.5" /> },
  { mode: 'dark', label: '深色', icon: <Moon className="h-3.5 w-3.5" /> },
  { mode: 'system', label: '系統', icon: <Monitor className="h-3.5 w-3.5" /> },
];

const Header: React.FC<HeaderProps> = ({ themeMode, resolvedTheme, onThemeModeChange }) => {
  const logoUrl =
    resolvedTheme === 'dark'
      ? 'https://cdn.shopify.com/s/files/1/0204/3327/2854/files/LOGO.png?v=1771934252'
      : 'https://dgs.com.tw/img/header/logo.svg';

  return (
    <header className="bg-[var(--surface-primary)] border-b border-[var(--border-default)] sticky top-0 z-10 backdrop-blur">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex items-center justify-between gap-3">
        <div className="flex items-center space-x-3 min-w-0">
          <img src={logoUrl} alt="Dogger Instruments" className="h-10 w-auto" />
          <div className="h-8 w-px bg-[var(--border-default)] mx-1 hidden sm:block"></div>
          <div className="min-w-0">
            <h1 className="text-base sm:text-lg font-bold text-[var(--brand-primary)] tracking-tight flex items-center gap-2 truncate">
              工程師客服回覆禮貌化工具_產品清單版
              <span className="text-[10px] font-medium text-[var(--brand-primary)] bg-[var(--brand-soft)] px-2 py-0.5 rounded-full border border-[var(--brand-soft-border)]">
                v1.2
              </span>
            </h1>
            <p className="text-xs text-[var(--text-muted)] hidden sm:block">僅使用產品清單檢索與推薦（最終貨號網址）</p>
          </div>
        </div>

        <div className="flex flex-col items-end gap-1">
          <div className="flex items-center gap-1 rounded-full border border-[var(--border-default)] bg-[var(--surface-secondary)] p-1">
            {themeOptions.map((option) => {
              const selected = themeMode === option.mode;
              return (
                <button
                  key={option.mode}
                  type="button"
                  onClick={() => onThemeModeChange(option.mode)}
                  className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors"
                  style={{
                    background: selected ? 'var(--brand-soft)' : 'transparent',
                    color: selected ? 'var(--brand-primary)' : 'var(--text-muted)',
                  }}
                >
                  {option.icon}
                  <span className="hidden sm:inline">{option.label}</span>
                </button>
              );
            })}
          </div>

          <div className="flex items-center text-[10px] font-medium text-[var(--text-muted)] bg-[var(--surface-secondary)] px-2 py-0.5 rounded-full border border-[var(--border-default)]">
            <Cpu className="w-3 h-3 mr-1" />
            <span>Model: {MODEL_NAME}</span>
          </div>

          <div className="flex items-center text-xs text-[var(--text-muted)]">
            <Zap className="h-3 w-3 mr-1 text-[#facc15] fill-[#facc15] stroke-[#facc15]" />
            <span className="hidden sm:inline">如有問題請洽分機124 陳宛均Abby</span>
          </div>
        </div>
      </div>
    </header>
  );
};

export default Header;
