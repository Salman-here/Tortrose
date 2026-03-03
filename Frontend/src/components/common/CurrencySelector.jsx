import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { DollarSign, ChevronDown } from 'lucide-react';
import { useCurrency } from '../../contexts/CurrencyContext';

export default function CurrencySelector() {
  const { currency, currencies, changeCurrency } = useCurrency();
  const [isOpen, setIsOpen] = useState(false);

  const handleCurrencyChange = (newCurrency) => {
    changeCurrency(newCurrency);
    setIsOpen(false);
  };

  return (
    <div className="relative">
      <motion.button
        onClick={() => setIsOpen(!isOpen)}
        whileHover={{ scale: 1.02 }}
        whileTap={{ scale: 0.98 }}
        className="flex items-center gap-1 px-2 py-1 text-xs sm:text-sm bg-gray-100 hover:bg-gray-200 border border-gray-300 rounded-md transition-colors"
      >
        <span className="font-medium text-gray-700">{currency}</span>
        <ChevronDown size={14} className={`text-gray-600 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </motion.button>

      <AnimatePresence>
        {isOpen && (
          <>
            {/* Backdrop */}
            <div 
              className="fixed inset-0 z-40" 
              onClick={() => setIsOpen(false)}
            />
            
            {/* Dropdown */}
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="absolute right-0 mt-1 w-44 bg-white border border-gray-200 rounded-md shadow-lg z-50 overflow-hidden"
            >
              <div className="p-1">
                {Object.entries(currencies).map(([code, info]) => (
                  <motion.button
                    key={code}
                    onClick={() => handleCurrencyChange(code)}
                    whileHover={{ backgroundColor: '#f3f4f6' }}
                    className={`w-full text-left px-2 py-1.5 rounded transition-colors ${
                      currency === code ? 'bg-blue-50 text-blue-600' : 'text-gray-700'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm">{info.symbol}</span>
                        <span className="font-medium text-xs">{code}</span>
                      </div>
                      {currency === code && (
                        <div className="w-1.5 h-1.5 bg-indigo-600 rounded-full" />
                      )}
                    </div>
                  </motion.button>
                ))}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
