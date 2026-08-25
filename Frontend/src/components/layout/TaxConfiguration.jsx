import React, { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { DollarSign, Percent, Ban, Save, Loader2, Info } from 'lucide-react';
import axios from 'axios';
import { toast } from 'react-toastify';
import { useCurrency } from '../../contexts/CurrencyContext';
import { getAuthToken } from "../../utils/cookieHelper";
import {
  addCurrencyAmounts,
  percentageCurrencyAmount,
} from '../../utils/currencySafety';
import {
  parseTaxConfigurationValue,
  taxConfigurationResponseIsValid,
} from '../../utils/taxConfigurationSafety';

export default function TaxConfiguration() {
  const {
    currency: displayCurrency,
    currencies,
    convertAmount,
    exchangeRatesFallback,
    exchangeRatesLoading,
    formatAmount,
  } = useCurrency();
  const [taxType, setTaxType] = useState('none');
  const [taxValue, setTaxValue] = useState('');
  const [taxCurrency, setTaxCurrency] = useState('USD');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [loadError, setLoadError] = useState('');
  const requestRef = useRef({ id: 0, controller: null });

  const fetchTaxConfig = useCallback(async () => {
    const requestId = requestRef.current.id + 1;
    requestRef.current.controller?.abort();
    const controller = new AbortController();
    requestRef.current = { id: requestId, controller };
    setIsLoading(true);
    setLoadError('');
    setTaxValue('');
    try {
      const res = await axios.get(`${import.meta.env.VITE_API_URL}api/tax/config`, { signal: controller.signal });
      if (requestRef.current.id !== requestId) return;
      if (res.data?.success !== true || !taxConfigurationResponseIsValid(res.data.taxConfig)) {
        throw new Error('Tax configuration returned incomplete or invalid money data.');
      }
      setTaxType(res.data.taxConfig.type);
      setTaxValue(String(res.data.taxConfig.value));
      setTaxCurrency(res.data.taxConfig.currency);
    } catch (error) {
      if (controller.signal.aborted || error?.code === 'ERR_CANCELED' || error?.name === 'CanceledError') return;
      if (requestRef.current.id !== requestId) return;
      console.error('Error fetching tax config:', error);
      const message = error.response?.data?.msg || error.message || 'Failed to load tax configuration';
      setLoadError(message);
      toast.error(message);
    } finally {
      if (requestRef.current.id === requestId) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTaxConfig();
    return () => {
      requestRef.current.id += 1;
      requestRef.current.controller?.abort();
    };
  }, [fetchTaxConfig]);

  const handleSave = async () => {
    const parsed = parseTaxConfigurationValue(taxType, taxValue);
    if (!parsed.valid) { toast.error(parsed.error); return; }
    setIsSaving(true);
    try {
      const token = getAuthToken();
      const res = await axios.put(`${import.meta.env.VITE_API_URL}api/tax/config`, {
        type: taxType,
        value: parsed.value,
        currency: taxType === 'fixed' ? taxCurrency : 'USD',
      }, { headers: { Authorization: `Bearer ${token}` } });
      if (res.data.success) toast.success('Tax configuration updated successfully');
    } catch (error) { toast.error(error.response?.data?.msg || 'Failed to update tax configuration'); }
    finally { setIsSaving(false); }
  };

  if (isLoading) return <div className="flex justify-center items-center min-h-screen"><Loader2 className="w-8 h-8 animate-spin" style={{ color: 'hsl(var(--primary))' }} /></div>;

  if (loadError) return (
    <div className="min-h-[60vh] flex items-center justify-center px-4">
      <div className="glass-panel p-8 text-center max-w-md">
        <Info size={28} className="mx-auto mb-3" />
        <h2 className="font-bold" style={{ color: 'hsl(var(--foreground))' }}>Tax configuration unavailable</h2>
        <p className="text-sm mt-2" style={{ color: 'hsl(var(--muted-foreground))' }}>{loadError}</p>
        <button type="button" onClick={fetchTaxConfig} className="mt-4 glass-button px-4 py-2 rounded-xl">Retry</button>
      </div>
    </div>
  );

  const taxOptions = [
    { type: 'none', icon: <Ban className="w-6 h-6" />, title: 'No Tax', description: 'No tax will be applied to orders', color: 'hsl(var(--muted-foreground))' },
    { type: 'percentage', icon: <Percent className="w-6 h-6" />, title: 'Percentage Based Tax', description: 'Tax calculated as percentage of subtotal', color: 'hsl(260, 60%, 55%)' },
    { type: 'fixed', icon: <DollarSign className="w-6 h-6" />, title: 'Fixed Amount Tax', description: 'Fixed tax amount added to all orders', color: 'hsl(150, 60%, 45%)' },
  ];
  const taxSymbol = currencies[taxCurrency]?.symbol || taxCurrency;
  const parsedTax = parseTaxConfigurationValue(taxType, taxValue);
  const fixedPreviewUnavailable = taxType === 'fixed'
    && taxCurrency !== displayCurrency
    && (exchangeRatesLoading || exchangeRatesFallback);
  const fixedTaxForPreview = taxType === 'fixed' && parsedTax.valid && !fixedPreviewUnavailable
    ? (taxCurrency === displayCurrency
      ? parsedTax.value
      : convertAmount(parsedTax.value, taxCurrency, displayCurrency))
    : null;
  const previewSubtotal = 100;
  const previewTax = taxType === 'percentage' && parsedTax.valid
    ? percentageCurrencyAmount(previewSubtotal, parsedTax.value)
    : fixedTaxForPreview;
  const previewTotal = previewTax === null ? null : addCurrencyAmounts(previewSubtotal, previewTax);

  return (
    <div className="min-h-screen py-8 sm:py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-3xl mx-auto">
        <div className="glass-panel p-6 sm:p-8">
          <div className="mb-8">
            <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight" style={{ color: 'hsl(var(--foreground))' }}>Tax Configuration</h1>
            <p className="mt-2 text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>Configure platform-wide tax settings for all orders</p>
          </div>

          <div className="space-y-4">
            {taxOptions.map(opt => (
              <motion.div key={opt.type} whileHover={{ y: -2 }}
                className={`glass-card p-6 cursor-pointer transition-all`}
                style={taxType === opt.type ? { borderColor: opt.color, borderWidth: '2px', boxShadow: `0 0 20px -8px ${opt.color}40` } : {}}
                onClick={() => { setTaxType(opt.type); if (opt.type === 'none') setTaxValue(0); }}>
                <div className="flex items-center gap-4">
                  <div className="glass-inner p-3 rounded-xl" style={{ color: taxType === opt.type ? opt.color : 'hsl(var(--muted-foreground))' }}>{opt.icon}</div>
                  <div className="flex-1">
                    <h3 className="text-lg font-semibold" style={{ color: 'hsl(var(--foreground))' }}>{opt.title}</h3>
                    <p className="text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>{opt.description}</p>
                  </div>
                  <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center`} style={{ borderColor: taxType === opt.type ? opt.color : 'var(--glass-border-strong)' }}>
                    {taxType === opt.type && <div className="w-2.5 h-2.5 rounded-full" style={{ background: opt.color }} />}
                  </div>
                </div>

                {taxType === 'percentage' && opt.type === 'percentage' && (
                  <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="mt-4">
                    <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'hsl(var(--muted-foreground))' }}>Tax Percentage (0-100)</label>
                    <div className="relative">
                      <input type="number" min="0" max="100" step="0.000001" value={taxValue} onChange={(e) => setTaxValue(e.target.value)}
                        onClick={(e) => e.stopPropagation()} className="glass-input pr-10" placeholder="Enter percentage" />
                      <Percent className="absolute right-3 top-1/2 transform -translate-y-1/2 w-5 h-5" style={{ color: 'hsl(var(--muted-foreground))' }} />
                    </div>
                  </motion.div>
                )}

                {taxType === 'fixed' && opt.type === 'fixed' && (
                  <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="mt-4">
                    <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'hsl(var(--muted-foreground))' }}>
                      Fixed tax amount and native currency
                    </label>
                    <div className="grid grid-cols-[minmax(0,1fr)_8rem] gap-3">
                      <div className="relative">
                        <span className="absolute left-3 top-1/2 transform -translate-y-1/2 font-medium" style={{ color: 'hsl(var(--muted-foreground))' }}>{taxSymbol}</span>
                        <input type="number" min="0" step="0.01" value={taxValue}
                          onChange={(e) => setTaxValue(e.target.value)}
                          onClick={(e) => e.stopPropagation()} className="glass-input pl-10" placeholder="Enter fixed amount" />
                      </div>
                      <select
                        value={taxCurrency}
                        onChange={(e) => setTaxCurrency(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        className="glass-input"
                        aria-label="Fixed tax currency"
                      >
                        {Object.keys(currencies).map((code) => <option key={code} value={code}>{code}</option>)}
                      </select>
                    </div>
                    <p className="mt-2 text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>
                      This exact {taxCurrency} amount is converted to each order currency using the checkout rate snapshot.
                    </p>
                  </motion.div>
                )}
              </motion.div>
            ))}
          </div>

          {/* Save Button */}
          <div className="mt-8">
            <motion.button whileHover={{ scale: 1.01 }} whileTap={{ scale: 0.98 }} onClick={handleSave} disabled={isSaving || !parsedTax.valid}
              className="w-full py-3 rounded-xl font-semibold text-white disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(200, 80%, 50%))', boxShadow: '0 0 20px -4px hsl(220, 70%, 55%, 0.3)' }}>
              {isSaving ? <><Loader2 className="w-5 h-5 animate-spin" /> Saving...</> : <><Save className="w-5 h-5" /> Save Configuration</>}
            </motion.button>
          </div>

          {/* Preview */}
          <div className="mt-8 glass-inner rounded-xl p-4">
            <h4 className="font-semibold text-sm mb-2 flex items-center gap-2" style={{ color: 'hsl(var(--foreground))' }}><Info size={16} /> Preview</h4>
            <p className="text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>
              {taxType === 'none' && 'No tax will be applied to orders.'}
              {taxType === 'percentage' && (parsedTax.valid ? `${parsedTax.value}% tax will be calculated on order subtotal.` : parsedTax.error)}
              {taxType === 'fixed' && (parsedTax.valid ? `${formatAmount(parsedTax.value, { targetCurrency: taxCurrency, showCode: true })} tax will be converted into the order currency at checkout.` : parsedTax.error)}
            </p>
            {taxType !== 'none' && parsedTax.valid && (
              <div className="mt-3 text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>
                <p className="font-medium">Example (Subtotal: {formatAmount(previewSubtotal)}):</p>
                {previewTax === null ? (
                  <p>Live {displayCurrency} preview is unavailable until trusted exchange rates recover.</p>
                ) : <>
                  <p>Tax: {formatAmount(previewTax, { targetCurrency: displayCurrency, showCode: true })}</p>
                  <p className="font-semibold" style={{ color: 'hsl(var(--foreground))' }}>
                    Total: {formatAmount(previewTotal, { targetCurrency: displayCurrency, showCode: true })}
                  </p>
                </>}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
