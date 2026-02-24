import React from 'react';
import { Zap, Cpu } from 'lucide-react';
import { MODEL_NAME } from '../services/geminiService';

const Header: React.FC = () => {
  return (
    <header className="bg-white border-b border-gray-200 sticky top-0 z-10">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-20 flex items-center justify-between">
        <div className="flex items-center space-x-4">
          {/* Dogger Instruments Logo */}
          <img 
            src="https://dgs.com.tw/img/header/logo.svg" 
            alt="Dogger Instruments" 
            className="h-10 w-auto" // Adjusted height for better visibility
          />
          <div className="h-8 w-px bg-gray-200 mx-2 hidden sm:block"></div>
          <div>
            <h1 className="text-lg font-bold text-[#005787] tracking-tight flex items-center">
              工程師客服回覆禮貌化工具
              <span className="ml-2 text-[10px] font-medium text-[#26B7BC] bg-[#26B7BC]/10 px-2 py-0.5 rounded-full border border-[#26B7BC]/20">MVP</span>
            </h1>
            <p className="text-xs text-[#898989] hidden sm:block">
              保留專業術語，自動潤飾語氣
            </p>
          </div>
        </div>
        
        {/* Right side info: Model & Contact */}
        <div className="flex flex-col items-end space-y-1">
            <div className="flex items-center text-[10px] font-medium text-gray-500 bg-gray-100 px-2 py-0.5 rounded-full border border-gray-200">
              <Cpu className="w-3 h-3 mr-1 text-gray-400" />
              <span>Model: {MODEL_NAME}</span>
            </div>
            <div className="flex items-center text-xs text-[#898989]">
              <Zap className="h-3 w-3 mr-1 text-[#F7EDA2] fill-[#F7EDA2] stroke-gray-400" />
              <span className="hidden sm:inline">如有問題請洽分機124 陳宛均Abby</span>
            </div>
        </div>
      </div>
    </header>
  );
};

export default Header;