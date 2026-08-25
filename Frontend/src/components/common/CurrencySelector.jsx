import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown } from 'lucide-react';
import { toast } from 'react-toastify';
import { useCurrency } from '../../contexts/CurrencyContext';

export default function CurrencySelector() {
  const { currency, currencies, changeCurrency, currencyPreferenceSaving } = useCurrency();
  const [isOpen, setIsOpen] = useState(false);

  const handleCurrencyChange = async (newCurrency) => {
    const saved = await changeCurrency(newCurrency);
    if (!saved) {
      toast.error('Currency preference could not be saved. Your previous currency is still active.');
      return;
    }
    setIsOpen(false);
  };

  return (
    <div className="relative">
      <motion.button onClick={() => setIsOpen(!isOpen)} disabled={currencyPreferenceSaving} whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}
        className="flex items-center gap-1 px-2 py-1 text-xs sm:text-sm glass-button rounded-xl disabled:opacity-60">
        <span className="font-medium">{currency}</span>
        <ChevronDown size={14} className={`transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </motion.button>

      <AnimatePresence>
        {isOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
            <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}
              className="absolute right-0 mt-1 w-44 glass-panel-strong z-50 overflow-hidden p-1">
              {Object.entries(currencies).map(([code, info]) => (
                <motion.button key={code} onClick={() => handleCurrencyChange(code)} disabled={currencyPreferenceSaving}
                  whileHover={{ backgroundColor: 'rgba(255,255,255,0.1)' }}
                  className={`w-full text-left px-2 py-1.5 rounded-xl transition-colors text-sm ${
                    currency === code ? 'glass-inner font-semibold' : ''
                  }`}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <span>{info.symbol}</span>
                      <span className="font-medium text-xs">{code}</span>
                    </div>
                    {currency === code && <div className="w-1.5 h-1.5 rounded-full" style={{ background: 'hsl(var(--primary))' }} />}
                  </div>
                </motion.button>
              ))}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
