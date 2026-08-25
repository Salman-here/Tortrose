import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Truck, Zap, Gift, Save, Loader2, Clock, DollarSign, Info } from 'lucide-react';
import axios from 'axios';
import { toast } from 'react-toastify';
import { useCurrency } from '../../contexts/CurrencyContext';
import Loader from '../common/Loader';
import { getAuthToken } from "../../utils/cookieHelper";
import {
  validateDeliveryDaysInput,
  validateShippingCostInput,
} from '../../utils/sellerMoneySafety';

const SUPPORTED_STORE_CURRENCIES = new Set(['USD', 'PKR', 'EUR', 'GBP']);

const normalizeStoreCurrency = (value) => {
  const normalized = String(value || '').trim().toUpperCase();
  return SUPPORTED_STORE_CURRENCIES.has(normalized) ? normalized : null;
};

const defaultMethods = (currency) => [
  { type: 'free', cost: '0', currency, costCurrency: currency, costInputAmount: 0, deliveryDays: '5', isActive: true },
  { type: 'standard', cost: '', currency, costCurrency: currency, costInputAmount: 0, deliveryDays: '5', isActive: false },
  { type: 'fast', cost: '', currency, costCurrency: currency, costInputAmount: 0, deliveryDays: '2', isActive: false }
];

const normalizeMethodForDisplay = (method, fallbackCurrency) => {
  const nativeCurrency = normalizeStoreCurrency(method?.currency || method?.costCurrency) || fallbackCurrency;
  return {
    ...method,
    cost: method?.type === 'free' ? '0' : String(method?.cost ?? ''),
    currency: nativeCurrency,
    costCurrency: nativeCurrency,
    costInputAmount: method?.costInputAmount ?? method?.cost ?? 0,
    deliveryDays: String(method?.deliveryDays ?? ''),
    isActive: method?.isActive !== false,
  };
};

export default function ShippingConfiguration() {
  const { currency, currencies, formatPrice } = useCurrency();
  const [methods, setMethods] = useState([]);
  const [storeCurrency, setStoreCurrency] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => { fetchShippingMethods(); }, []);

  const methodCurrency = (method) => normalizeStoreCurrency(method?.currency || method?.costCurrency) || storeCurrency;
  const methodSymbol = (method) => currencies[methodCurrency(method)]?.symbol || methodCurrency(method) || '';

  const fetchShippingMethods = async () => {
    try {
      const userStr = localStorage.getItem('currentUser');
      if (!userStr) { toast.error('User not found. Please login again.'); setIsLoading(false); return; }
      const user = JSON.parse(userStr);
      const userId = user._id || user.id;
      if (!userId) { toast.error('Invalid user data.'); setIsLoading(false); return; }
      const token = getAuthToken();
      const [res, productCurrencyRes] = await Promise.all([
        axios.get(`${import.meta.env.VITE_API_URL}api/shipping/seller/${userId}`),
        axios.get(`${import.meta.env.VITE_API_URL}api/stores/product-currency`, {
          headers: { Authorization: `Bearer ${token}` }
        })
      ]);
      const activeCurrency = normalizeStoreCurrency(productCurrencyRes.data?.productCurrency?.activeCurrency);
      if (!activeCurrency) throw new Error('Your store product currency is unavailable.');
      setStoreCurrency(activeCurrency);
      if (res.data.success && res.data.shippingMethods.methods.length > 0) {
        setMethods(res.data.shippingMethods.methods.map(method => (
          normalizeMethodForDisplay(method, activeCurrency)
        )));
      } else {
        setMethods(defaultMethods(activeCurrency));
      }
      setLoadError('');
    } catch (error) {
      console.error('Error fetching shipping methods:', error);
      setLoadError(error.response?.data?.msg || error.message || 'Failed to load shipping methods');
      toast.error('Failed to load shipping methods');
    }
    finally { setIsLoading(false); }
  };

  const handleMethodChange = (type, field, value) => {
    setMethods(methods.map(method => {
      if (method.type === type) {
        if (type === 'free' && field === 'cost') return method;
        if (field === 'cost') {
          const nativeCurrency = methodCurrency(method);
          return {
            ...method,
            cost: value,
            currency: nativeCurrency,
            costCurrency: nativeCurrency,
            costInputAmount: value,
          };
        }
        return { ...method, [field]: value };
      }
      return method;
    }));
  };

  const handleSave = async () => {
    if (!storeCurrency || loadError) {
      toast.error('Your store product currency must be loaded before shipping fees can be saved.');
      return;
    }
    const activeMethodsCount = methods.filter(m => m.isActive).length;
    if (activeMethodsCount === 0) { toast.error('At least one shipping method must be active'); return; }
    for (const method of methods) {
      const costValidation = validateShippingCostInput(method.type, method.cost, method.isActive);
      const deliveryValidation = validateDeliveryDaysInput(method.deliveryDays);
      if (!costValidation.valid) { toast.error(`${getMethodTitle(method.type)}: ${costValidation.error}`); return; }
      if (!deliveryValidation.valid) { toast.error(`${getMethodTitle(method.type)}: ${deliveryValidation.error}`); return; }
    }
    setIsSaving(true);
    try {
      const token = getAuthToken();
      const methodsToSave = methods.map((method) => {
        const nativeCurrency = methodCurrency(method);
        const costValidation = validateShippingCostInput(method.type, method.cost, method.isActive);
        const deliveryValidation = validateDeliveryDaysInput(method.deliveryDays);
        return {
          ...method,
          cost: costValidation.amount,
          currency: nativeCurrency,
          costCurrency: nativeCurrency,
          costInputAmount: costValidation.amount,
          deliveryDays: deliveryValidation.days,
        };
      });
      const res = await axios.put(`${import.meta.env.VITE_API_URL}api/shipping/methods`, { methods: methodsToSave, currency: storeCurrency }, { headers: { Authorization: `Bearer ${token}` } });
      if (res.data.success) {
        if (res.data.shippingMethods?.methods) {
          setMethods(res.data.shippingMethods.methods.map(method => (
            normalizeMethodForDisplay(method, storeCurrency)
          )));
        }
        toast.success('Shipping methods updated successfully');
      }
    } catch (error) { toast.error(error.response?.data?.msg || 'Failed to update'); }
    finally { setIsSaving(false); }
  };

  const getMethodIcon = (type) => {
    switch (type) {
      case 'free': return <Gift className="w-6 h-6" />;
      case 'standard': return <Truck className="w-6 h-6" />;
      case 'fast': return <Zap className="w-6 h-6" />;
      default: return <Truck className="w-6 h-6" />;
    }
  };

  const getMethodTitle = (type) => ({ free: 'Free Shipping', standard: 'Standard Shipping', fast: 'Fast Shipping' }[type] || type);
  const getMethodDescription = (type) => ({ free: 'No cost shipping option for customers', standard: 'Regular delivery with standard rates', fast: 'Express delivery for urgent orders' }[type] || '');
  const getMethodColor = (type) => ({ free: 'hsl(150, 60%, 45%)', standard: 'hsl(220, 70%, 55%)', fast: 'hsl(30, 90%, 50%)' }[type] || 'hsl(var(--primary))');
  const hasInvalidMethods = methods.some((method) => (
    !validateShippingCostInput(method.type, method.cost, method.isActive).valid
    || !validateDeliveryDaysInput(method.deliveryDays).valid
  ));

  if (isLoading) return <div className="flex justify-center items-center min-h-screen"><Loader text="Loading shipping methods..." /></div>;

  return (
    <div className="min-h-screen py-8 sm:py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-6xl mx-auto">
        <div className="glass-panel p-6 sm:p-8">
          <div className="mb-8">
            <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight" style={{ color: 'hsl(var(--foreground))' }}>Shipping Methods Configuration</h1>
            <p className="mt-2 text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>Configure shipping options for your products</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {methods.map((method) => {
              const costValidation = validateShippingCostInput(method.type, method.cost, method.isActive);
              const deliveryValidation = validateDeliveryDaysInput(method.deliveryDays);
              return (
              <motion.div key={method.type} whileHover={{ y: -4 }}
                className={`glass-card p-6 transition-all ${method.isActive ? '' : 'opacity-50'}`}
                style={method.isActive ? { borderColor: getMethodColor(method.type), borderWidth: '2px', boxShadow: `0 0 20px -8px ${getMethodColor(method.type)}40` } : {}}>
                
                <div className="flex items-center justify-between mb-4">
                  <div className="glass-inner p-3 rounded-xl" style={{ color: method.isActive ? getMethodColor(method.type) : 'hsl(var(--muted-foreground))' }}>
                    {getMethodIcon(method.type)}
                  </div>
                  <label className="flex items-center cursor-pointer gap-2">
                    <div className="relative">
                      <input type="checkbox" checked={method.isActive} onChange={(e) => handleMethodChange(method.type, 'isActive', e.target.checked)} className="sr-only peer" />
                      <div className="w-11 h-6 rounded-full peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:rounded-full after:h-5 after:w-5 after:transition-all"
                        style={{ background: method.isActive ? getMethodColor(method.type) : 'rgba(255,255,255,0.15)', border: '1px solid var(--glass-border)' }}>
                        <div className={`absolute top-[2px] ${method.isActive ? 'left-[22px]' : 'left-[2px]'} w-5 h-5 rounded-full bg-white shadow transition-all`} />
                      </div>
                    </div>
                    <span className="text-xs font-medium" style={{ color: 'hsl(var(--muted-foreground))' }}>Enable</span>
                  </label>
                </div>

                <div className="flex items-center gap-2 mb-1">
                  <h3 className="text-lg font-semibold" style={{ color: 'hsl(var(--foreground))' }}>{getMethodTitle(method.type)}</h3>
                  {method.type === 'free' && (
                    <span className="px-2 py-0.5 text-[10px] font-semibold rounded-full" style={{ background: 'rgba(16, 185, 129, 0.12)', color: 'hsl(150, 60%, 40%)' }}>Recommended</span>
                  )}
                </div>
                <p className="text-sm mb-4" style={{ color: 'hsl(var(--muted-foreground))' }}>{getMethodDescription(method.type)}</p>

                {/* Cost Input */}
                <div className="mb-4">
                  <label className="block text-xs font-semibold uppercase tracking-wider mb-2 flex items-center gap-2" style={{ color: 'hsl(var(--muted-foreground))' }}>
                    <DollarSign className="w-3.5 h-3.5" /> Shipping Cost ({methodCurrency(method)})
                  </label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 transform -translate-y-1/2 text-sm font-medium" style={{ color: 'hsl(var(--muted-foreground))' }}>{methodSymbol(method)}</span>
                    <input type="number" min="0" step="0.01"
                      value={method.type === 'free' ? 0 : method.cost}
                      onChange={(e) => handleMethodChange(method.type, 'cost', e.target.value)}
                      disabled={method.type === 'free'}
                      aria-invalid={!costValidation.valid}
                      className="glass-input pl-9 disabled:opacity-50 disabled:cursor-not-allowed" placeholder="Set a native-currency fee" />
                  </div>
                  {!costValidation.valid && (
                    <p className="text-xs mt-1.5" style={{ color: 'hsl(0, 72%, 55%)' }}>{costValidation.error}</p>
                  )}
                </div>

                {/* Delivery Days */}
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider mb-2 flex items-center gap-2" style={{ color: 'hsl(var(--muted-foreground))' }}>
                    <Clock className="w-3.5 h-3.5" /> Delivery Days
                  </label>
                  <input type="number" min="1" value={method.deliveryDays}
                    onChange={(e) => handleMethodChange(method.type, 'deliveryDays', e.target.value)}
                    aria-invalid={!deliveryValidation.valid}
                    className="glass-input disabled:opacity-50 disabled:cursor-not-allowed" placeholder="Enter days" />
                  {!deliveryValidation.valid && (
                    <p className="text-xs mt-1.5" style={{ color: 'hsl(0, 72%, 55%)' }}>{deliveryValidation.error}</p>
                  )}
                </div>

                {/* Preview */}
                {method.isActive && (
                  <div className="mt-4 glass-inner rounded-xl p-3">
                    <p className="text-xs font-medium mb-1" style={{ color: 'hsl(var(--muted-foreground))' }}>Preview:</p>
                    <p className="text-sm font-semibold" style={{ color: 'hsl(var(--foreground))' }}>
                      {costValidation.valid && deliveryValidation.valid
                        ? `${method.type === 'free' ? 'Free' : formatPrice(costValidation.amount, { sourceCurrency: methodCurrency(method) })} · ${deliveryValidation.days} ${deliveryValidation.days === 1 ? 'day' : 'days'}`
                        : 'Complete the valid cost and delivery fields to preview this method.'}
                    </p>
                    {methodCurrency(method) !== currency && (
                      <p className="text-[11px] mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                        Stored exactly in {methodCurrency(method)}; the {currency} preview is converted for display only.
                      </p>
                    )}
                  </div>
                )}
              </motion.div>
              );
            })}
          </div>

          {loadError && (
            <div className="mt-6 glass-inner rounded-xl p-4" style={{ borderLeft: '3px solid hsl(0, 72%, 55%)' }}>
              <p className="text-sm font-semibold" style={{ color: 'hsl(0, 72%, 55%)' }}>Shipping settings are read-only until the store currency can be verified.</p>
              <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>{loadError}</p>
            </div>
          )}

          {/* Save Button */}
          <div className="mt-8">
            <motion.button whileHover={{ scale: 1.01 }} whileTap={{ scale: 0.98 }} onClick={handleSave} disabled={isSaving || !storeCurrency || !!loadError || hasInvalidMethods}
              className="w-full py-3 rounded-xl font-semibold transition-all disabled:opacity-60 disabled:cursor-not-allowed text-white flex items-center justify-center gap-2"
              style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(200, 80%, 50%))', boxShadow: '0 0 20px -4px hsl(220, 70%, 55%, 0.3)' }}>
              {isSaving ? <><Loader2 className="w-5 h-5 animate-spin" /> Saving...</> : <><Save className="w-5 h-5" /> Save Shipping Methods</>}
            </motion.button>
          </div>

          {/* Info Box */}
          <div className="mt-6 glass-inner rounded-xl p-4" style={{ borderLeft: '3px solid hsl(220, 70%, 55%)' }}>
            <h4 className="font-semibold text-sm mb-2 flex items-center gap-2" style={{ color: 'hsl(var(--foreground))' }}><Info size={16} /> Important Notes</h4>
            <ul className="text-xs space-y-1 list-disc list-inside" style={{ color: 'hsl(var(--muted-foreground))' }}>
              <li>At least one shipping method must be active</li>
              <li>Free shipping must have zero cost</li>
              <li>Standard and Fast shipping must have cost greater than zero</li>
              <li>New shipping fees use your store product currency{storeCurrency ? ` (${storeCurrency})` : ''}</li>
              <li>Existing fees remain stored in their native currency; changing display currency never rewrites them</li>
              <li>Delivery days must be at least 1</li>
              <li>Customers will see these options at checkout</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
