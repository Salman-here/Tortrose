import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Banknote, Clock, RefreshCw, TrendingUp } from 'lucide-react';
import axios from 'axios';
import { useAuth } from '../../contexts/AuthContext';
import { useCurrency } from '../../contexts/CurrencyContext';
import { getAuthToken } from '../../utils/cookieHelper';
import { inspectSellerProductCurrencyState } from '../../utils/productFormCurrency';
import { inspectSellerRevenueOverview } from '../../utils/sellerRevenueOverview';

export default function SellerRevenueOverview() {
  const { currentUser } = useAuth();
  const { formatAmount } = useCurrency();
  const sellerId = currentUser?.role === 'seller' ? String(currentUser._id || currentUser.id || '') : '';
  const [overview, setOverview] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const requestRef = useRef({ id: 0, controller: null });

  const refresh = useCallback(async () => {
    const requestId = requestRef.current.id + 1;
    requestRef.current.controller?.abort();
    const controller = new AbortController();
    requestRef.current = { id: requestId, controller };
    setOverview(null);
    setError('');
    setLoading(true);
    if (!sellerId) { setLoading(false); return; }
    const options = { headers: { Authorization: `Bearer ${getAuthToken()}` }, signal: controller.signal };
    try {
      const response = await axios.get(`${import.meta.env.VITE_API_URL}api/stores/product-currency`, options);
      if (requestRef.current.id !== requestId) return;
      const state = inspectSellerProductCurrencyState(response.data?.productCurrency);
      if (!state.valid || !state.hasStore) throw new Error('Your store currency could not be verified.');
      const totals = await axios.get(`${import.meta.env.VITE_API_URL}api/payments/seller/summary?currency=${encodeURIComponent(state.activeCurrency)}`, options);
      if (requestRef.current.id !== requestId) return;
      const next = inspectSellerRevenueOverview(totals.data, sellerId, state.activeCurrency);
      if (!next) throw new Error('Revenue totals could not be verified. Please retry.');
      setOverview(next);
    } catch (failure) {
      if (failure.code === 'ERR_CANCELED' || failure.name === 'CanceledError' || requestRef.current.id !== requestId) return;
      setError(failure.response?.data?.msg || failure.message || 'Revenue totals are unavailable.');
    } finally {
      if (requestRef.current.id === requestId) setLoading(false);
    }
  }, [sellerId]);

  useEffect(() => {
    refresh();
    return () => { requestRef.current.id += 1; requestRef.current.controller?.abort(); };
  }, [refresh]);

  const active = overview?.sellerId === sellerId ? overview : null;
  const cards = active ? [
    { label: 'Delivered COD Revenue', value: active.codDeliveredRevenue, icon: Banknote,
      description: 'Delivered COD sales collected directly by you.', color: 'hsl(30,90%,50%)', bg: 'rgba(249,115,22,0.12)' },
    { label: 'Total Delivered Revenue', value: active.totalDeliveredRevenue, icon: TrendingUp,
      description: 'Delivered Safepay, Wallet and COD sales.', color: 'hsl(220,70%,55%)', bg: 'rgba(99,102,241,0.12)' },
    { label: 'Estimated Revenue', value: active.estimatedRevenue, icon: Clock,
      description: 'Delivered sales plus pending online and COD orders.', color: 'hsl(200,80%,50%)', bg: 'rgba(14,165,233,0.12)' },
  ] : [];

  return (
    <section aria-label="All-time revenue" className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold">All-time revenue</h2>
          <p className="text-xs text-muted-foreground mt-1">Gross sales totals{active ? ` in ${active.currency}` : ''}. Independent of the chart period; not your withdrawable balance.</p>
        </div>
        <button type="button" aria-label="Refresh all-time revenue" onClick={refresh} disabled={loading}
          className="glass-inner rounded-xl p-2 disabled:opacity-50"><RefreshCw size={16} className={loading ? 'animate-spin' : ''} /></button>
      </div>
      {loading ? <div role="status" className="glass-panel rounded-2xl p-5 text-sm text-muted-foreground">Loading revenue totals…</div>
        : active ? <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">{cards.map(({ icon: Icon, ...card }) => (
          <div key={card.label} className="glass-card water-shimmer p-4 sm:p-5 min-w-0">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0"><p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{card.label}</p>
                <p className="text-xl sm:text-2xl font-extrabold mt-2 break-words">{formatAmount(card.value, { targetCurrency: active.currency, showCode: true })}</p></div>
              <div className="p-3 rounded-2xl shrink-0" style={{ background: card.bg, color: card.color }}><Icon size={22} /></div>
            </div>
            <p className="text-xs text-muted-foreground mt-2 leading-relaxed">{card.description}</p>
          </div>
        ))}</div> : <div role="alert" className="glass-panel rounded-2xl p-5 text-sm">{error || 'Sign in as a seller to view revenue totals.'}</div>}
    </section>
  );
}
