import React, { useCallback, useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, Truck, CheckCircle, XCircle, Clock, Package, RefreshCw, ShoppingBag, Filter, Sparkles, ArrowRight, MessageCircle, Download, Calendar, FileText, FileSpreadsheet, RotateCcw } from 'lucide-react';
import { openWhatsAppVerify, hasWhatsAppPhone, isOrderConfirmedByBuyer, getConfirmationSourceLabel } from '../../utils/whatsapp';
import axios from 'axios';
import { toast } from 'react-toastify';
import { Link, useSearchParams } from 'react-router-dom';
import Loader from '../common/Loader';
import { useAuth } from '../../contexts/AuthContext';
import { useCurrency } from '../../contexts/CurrencyContext';
import { getAuthToken } from "../../utils/cookieHelper";
import ReturnOrdersPanel from './ReturnOrdersPanel';
import { inspectOrderListMoney, inspectSellerOrderListMoney } from '../../utils/orderItems';
import { buildOrderExportQuery, orderExportErrorMessage } from '../../utils/orderExport';

const OrderManagement = () => {
    const { currentUser } = useAuth();
    const { formatPrice, currency } = useCurrency();
    const [orders, setOrders] = useState([]);
    const [searchTerm, setSearchTerm] = useState('');
    const [statusFilter, setStatusFilter] = useState('all');
    const [paymentFilter, setPaymentFilter] = useState('all');
    const [dateRange, setDateRange] = useState({ start: '', end: '' });
    const [loading, setLoading] = useState(true);
    const [exporting, setExporting] = useState(false);
    const [exportFormat, setExportFormat] = useState('pdf');
    const [searchParams, setSearchParams] = useSearchParams();
    const activeView = currentUser?.role === 'seller' && searchParams.get('tab') === 'returns' ? 'returns' : 'orders';

    const setActiveView = (view) => {
        const next = new URLSearchParams(searchParams);
        if (view === 'returns') next.set('tab', 'returns');
        else next.delete('tab');
        setSearchParams(next, { replace: true });
    };

    const serializeFilters = useCallback(() => {
        let params = new URLSearchParams();
        if (searchTerm) params.append('search', searchTerm);
        if (paymentFilter !== 'all') params.append('paymentStatus', paymentFilter);
        if (statusFilter !== 'all') params.append('status', statusFilter);
        if (dateRange.start && dateRange.end) { params.append('startDate', dateRange.start); params.append('endDate', dateRange.end); }
        return params.toString();
    }, [searchTerm, paymentFilter, statusFilter, dateRange]);

    const fetchOrders = useCallback(async () => {
        const token = getAuthToken();
        setLoading(true);
        try {
            const query = serializeFilters();
            const res = await axios.get(`${import.meta.env.VITE_API_URL}api/order/get?${query}`, { headers: { Authorization: `Bearer ${token}` } });
            if (!Array.isArray(res.data?.orders)) throw new Error('Order data is unavailable.');
            setOrders(res.data.orders);
        } catch (error) { console.error(error); setOrders([]); }
        finally { setLoading(false); }
    }, [serializeFilters]);

    useEffect(() => { fetchOrders(); }, [fetchOrders]);

    const handleExport = async () => {
        const token = getAuthToken();
        setExporting(true);
        try {
            const query = buildOrderExportQuery(serializeFilters(), exportFormat, currency);
            const res = await axios.get(`${import.meta.env.VITE_API_URL}api/order/export?${query}`, {
                headers: { Authorization: `Bearer ${token}` },
                responseType: 'blob',
            });
            const ext = exportFormat === 'excel' ? 'xlsx' : exportFormat;
            const url = window.URL.createObjectURL(new Blob([res.data]));
            const link = document.createElement('a');
            link.href = url;
            link.setAttribute('download', `orders-${new Date().toISOString().split('T')[0]}.${ext}`);
            document.body.appendChild(link);
            link.click();
            link.remove();
            window.URL.revokeObjectURL(url);
            toast.success(`Orders exported as ${ext.toUpperCase()}`);
        } catch (error) {
            console.error('Export failed:', error);
            toast.error(await orderExportErrorMessage(error.response?.data));
        } finally {
            setExporting(false);
        }
    };

    const getStatusIcon = (status) => {
        const icons = { pending: <Clock className="w-3.5 h-3.5" />, confirmed: <CheckCircle className="w-3.5 h-3.5" />, processing: <RefreshCw className="w-3.5 h-3.5" />, shipped: <Truck className="w-3.5 h-3.5" />, delivered: <CheckCircle className="w-3.5 h-3.5" />, cancelled: <XCircle className="w-3.5 h-3.5" /> };
        return icons[status] || <Package className="w-3.5 h-3.5" />;
    };

    const getStatusStyle = (status) => {
        const styles = {
            pending: { bg: 'rgba(249, 115, 22, 0.12)', color: 'hsl(30, 90%, 50%)' },
            confirmed: { bg: 'rgba(16, 185, 129, 0.12)', color: 'hsl(150, 60%, 40%)' },
            processing: { bg: 'rgba(99, 102, 241, 0.12)', color: 'hsl(220, 70%, 55%)' },
            shipped: { bg: 'rgba(14, 165, 233, 0.12)', color: 'hsl(200, 80%, 50%)' },
            delivered: { bg: 'rgba(16, 185, 129, 0.12)', color: 'hsl(150, 60%, 40%)' },
            cancelled: { bg: 'rgba(239, 68, 68, 0.12)', color: 'hsl(0, 72%, 55%)' }
        };
        return styles[status] || { bg: 'rgba(255,255,255,0.08)', color: 'hsl(var(--muted-foreground))' };
    };

    const formatBuyerOrderedAmount = (money) => {
        const buyerCurrency = String(money.buyerCurrency).trim().toUpperCase();
        const buyerAmount = formatPrice(money.buyerTotal, {
            sourceCurrency: buyerCurrency,
            targetCurrency: buyerCurrency,
        });

        return `Buyer ordered in ${buyerCurrency}: ${buyerAmount}`;
    };

    const pendingCount = orders.filter(o => o.orderStatus === 'pending').length;
    const confirmedCount = orders.filter(o => o.orderStatus === 'confirmed').length;
    const processingCount = orders.filter(o => o.orderStatus === 'processing').length;
    const shippedCount = orders.filter(o => o.orderStatus === 'shipped').length;
    const deliveredCount = orders.filter(o => o.orderStatus === 'delivered').length;
    const cancelledCount = orders.filter(o => o.orderStatus === 'cancelled').length;

    return (
        <div className="w-full min-w-0 p-4 sm:p-6 max-w-7xl mx-auto">
            {/* Header */}
            <div className="mb-6">
                <div className="tag-pill mb-3">
                    <Sparkles size={12} /> Order Center
                </div>
                <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight" style={{ color: 'hsl(var(--foreground))' }}>
                    Order Management
                </h1>
                <p className="text-sm mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                    View and manage all customer orders
                </p>
            </div>

            {currentUser?.role === 'seller' && (
                <div className="glass-panel p-1.5 mb-6 grid grid-cols-2 gap-1.5" role="tablist" aria-label="Order views">
                    <button type="button" onClick={() => setActiveView('orders')} role="tab" aria-selected={activeView === 'orders'}
                        className="px-4 py-2.5 rounded-xl text-sm font-semibold inline-flex items-center justify-center gap-2 transition-all"
                        style={activeView === 'orders' ? { background: 'hsl(var(--primary))', color: 'white' } : { color: 'hsl(var(--muted-foreground))' }}>
                        <ShoppingBag size={15} /> Orders
                    </button>
                    <button type="button" onClick={() => setActiveView('returns')} role="tab" aria-selected={activeView === 'returns'}
                        className="px-4 py-2.5 rounded-xl text-sm font-semibold inline-flex items-center justify-center gap-2 transition-all"
                        style={activeView === 'returns' ? { background: 'hsl(150, 60%, 40%)', color: 'white' } : { color: 'hsl(var(--muted-foreground))' }}>
                        <RotateCcw size={15} /> Return Orders
                    </button>
                </div>
            )}

            {activeView === 'returns' ? (
                <ReturnOrdersPanel formatPrice={formatPrice} />
            ) : (
                <>

            {/* Quick Stats */}
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-3 mb-6">
                {[
                    { label: 'Pending', count: pendingCount, color: 'hsl(30, 90%, 50%)', icon: Clock },
                    { label: 'Confirmed', count: confirmedCount, color: 'hsl(150, 60%, 40%)', icon: CheckCircle },
                    { label: 'Processing', count: processingCount, color: 'hsl(220, 70%, 55%)', icon: RefreshCw },
                    { label: 'Shipped', count: shippedCount, color: 'hsl(200, 80%, 50%)', icon: Truck },
                    { label: 'Delivered', count: deliveredCount, color: 'hsl(150, 60%, 45%)', icon: Package },
                    { label: 'Cancelled', count: cancelledCount, color: 'hsl(0, 72%, 55%)', icon: XCircle },
                ].map((item, i) => {
                    const Icon = item.icon;
                    return (
                        <motion.div key={item.label} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: i * 0.03 }} className="glass-card p-3 text-center">
                            <Icon size={14} style={{ color: item.color, margin: '0 auto 4px' }} />
                            <p className="text-xl font-extrabold" style={{ color: item.color, letterSpacing: '-0.03em' }}>{item.count}</p>
                            <p className="text-[10px] font-medium mt-0.5" style={{ color: 'hsl(var(--muted-foreground))' }}>{item.label}</p>
                        </motion.div>
                    );
                })}
            </div>

            {/* Filters */}
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}
                className="glass-panel p-4 sm:p-5 mb-6">
                <div className="flex flex-col items-stretch gap-3 mb-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex min-w-0 items-center gap-2 sm:shrink-0">
                        <Filter size={14} style={{ color: 'hsl(var(--muted-foreground))' }} />
                        <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'hsl(var(--muted-foreground))' }}>Filters</span>
                    </div>
                    <div className="flex items-center gap-2">
                        {/* Format selector buttons */}
                        <div className="flex min-w-0 flex-1 rounded-lg overflow-hidden sm:flex-none" style={{ border: '1px solid var(--glass-border)' }}>
                            {[
                                { id: 'pdf', label: 'PDF', icon: FileText, color: 'hsl(0, 72%, 55%)' },
                                { id: 'excel', label: 'Excel', icon: FileSpreadsheet, color: 'hsl(150, 60%, 40%)' },
                                { id: 'csv', label: 'CSV', icon: FileText, color: 'hsl(220, 70%, 55%)' },
                            ].map(f => {
                                const Icon = f.icon;
                                const active = exportFormat === f.id;
                                return (
                                    <button key={f.id} onClick={() => setExportFormat(f.id)}
                                        className="flex-1 px-2.5 py-1.5 text-[10px] font-bold inline-flex items-center justify-center gap-1 transition-all sm:flex-none"
                                        style={{
                                            background: active ? `${f.color}1A` : 'transparent',
                                            color: active ? f.color : 'hsl(var(--muted-foreground))',
                                        }}>
                                        <Icon size={11} /> {f.label}
                                    </button>
                                );
                            })}
                        </div>
                        <motion.button
                            whileHover={{ scale: 1.03 }}
                            whileTap={{ scale: 0.97 }}
                            onClick={handleExport}
                            disabled={exporting || orders.length === 0}
                            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold text-white disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                            style={{ background: 'linear-gradient(135deg, hsl(150, 60%, 45%), hsl(170, 50%, 40%))' }}
                        >
                            {exporting ? <RefreshCw size={13} className="animate-spin" /> : <Download size={13} />}
                            {exporting ? 'Exporting…' : 'Download'}
                        </motion.button>
                    </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    <div className="search-input-wrapper sm:col-span-2 lg:col-span-3">
                        <div className="search-input-icon"><Search size={16} /></div>
                        <input type="text" placeholder="Search by ID or name" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} className="glass-input glass-input-search" />
                    </div>
                </div>

                {/* Status Filter Buttons */}
                <div className="mt-3">
                    <p className="text-[10px] font-bold uppercase tracking-wider mb-2" style={{ color: 'hsl(var(--muted-foreground))' }}>Status</p>
                    <div className="flex flex-wrap gap-2">
                        {[
                            { id: 'all', label: 'All', color: 'hsl(var(--foreground))', bg: 'rgba(255,255,255,0.08)' },
                            { id: 'pending', label: 'Pending', color: 'hsl(30, 90%, 50%)', bg: 'rgba(249, 115, 22, 0.12)' },
                            { id: 'confirmed', label: 'Confirmed', color: 'hsl(150, 60%, 40%)', bg: 'rgba(16, 185, 129, 0.12)' },
                            { id: 'processing', label: 'Processing', color: 'hsl(220, 70%, 55%)', bg: 'rgba(99, 102, 241, 0.12)' },
                            { id: 'shipped', label: 'Shipped', color: 'hsl(200, 80%, 50%)', bg: 'rgba(14, 165, 233, 0.12)' },
                            { id: 'delivered', label: 'Delivered', color: 'hsl(150, 60%, 45%)', bg: 'rgba(16, 185, 129, 0.12)' },
                            { id: 'cancelled', label: 'Cancelled', color: 'hsl(0, 72%, 55%)', bg: 'rgba(239, 68, 68, 0.12)' },
                        ].map(s => {
                            const active = statusFilter === s.id;
                            return (
                                <button key={s.id} onClick={() => setStatusFilter(s.id)}
                                    className="px-3 py-1.5 rounded-lg text-[11px] font-bold transition-all"
                                    style={{
                                        background: active ? s.bg : 'rgba(255,255,255,0.04)',
                                        color: active ? s.color : 'hsl(var(--muted-foreground))',
                                        border: `1px solid ${active ? s.color : 'transparent'}`,
                                    }}>
                                    {s.label}
                                </button>
                            );
                        })}
                    </div>
                </div>

                {/* Payment Filter Buttons */}
                <div className="mt-3">
                    <p className="text-[10px] font-bold uppercase tracking-wider mb-2" style={{ color: 'hsl(var(--muted-foreground))' }}>Payment</p>
                    <div className="flex flex-wrap gap-2">
                        {[
                            { id: 'all', label: 'All', color: 'hsl(var(--foreground))', bg: 'rgba(255,255,255,0.08)' },
                            { id: 'paid', label: 'Paid', color: 'hsl(150, 60%, 40%)', bg: 'rgba(16, 185, 129, 0.12)' },
                            { id: 'unpaid', label: 'Unpaid', color: 'hsl(0, 72%, 55%)', bg: 'rgba(239, 68, 68, 0.12)' },
                        ].map(p => {
                            const active = paymentFilter === p.id;
                            return (
                                <button key={p.id} onClick={() => setPaymentFilter(p.id)}
                                    className="px-3 py-1.5 rounded-lg text-[11px] font-bold transition-all"
                                    style={{
                                        background: active ? p.bg : 'rgba(255,255,255,0.04)',
                                        color: active ? p.color : 'hsl(var(--muted-foreground))',
                                        border: `1px solid ${active ? p.color : 'transparent'}`,
                                    }}>
                                    {p.label}
                                </button>
                            );
                        })}
                    </div>
                </div>
                {/* Date Range */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
                    <div>
                        <label className="text-[10px] font-bold uppercase tracking-wider mb-1 block flex items-center gap-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                            <Calendar size={10} /> From Date
                        </label>
                        <input type="date" value={dateRange.start} onChange={(e) => setDateRange(prev => ({ ...prev, start: e.target.value }))}
                            className="glass-input w-full px-3 py-2 rounded-xl text-sm" style={{ color: 'hsl(var(--foreground))' }} />
                    </div>
                    <div>
                        <label className="text-[10px] font-bold uppercase tracking-wider mb-1 block flex items-center gap-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                            <Calendar size={10} /> To Date
                        </label>
                        <input type="date" value={dateRange.end} onChange={(e) => setDateRange(prev => ({ ...prev, end: e.target.value }))}
                            className="glass-input w-full px-3 py-2 rounded-xl text-sm" style={{ color: 'hsl(var(--foreground))' }} />
                    </div>
                </div>
                {(dateRange.start || dateRange.end) && (
                    <button onClick={() => setDateRange({ start: '', end: '' })}
                        className="mt-2 text-[11px] font-medium px-3 py-1 rounded-lg transition-colors"
                        style={{ color: 'hsl(0, 72%, 55%)', background: 'rgba(239,68,68,0.08)' }}>
                        Clear date filter
                    </button>
                )}
            </motion.div>

            {/* Orders */}
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }}
                className="glass-panel overflow-hidden">
                {loading ? (
                    <div className="flex justify-center items-center h-[300px]"><Loader /></div>
                ) : orders.length === 0 ? (
                    <div className="text-center py-16">
                        <div className="glass-inner p-4 rounded-2xl inline-block mb-3"><ShoppingBag className="h-10 w-10" style={{ color: 'hsl(var(--muted-foreground))' }} /></div>
                        <p className="text-sm font-medium" style={{ color: 'hsl(var(--muted-foreground))' }}>No orders found matching your criteria</p>
                    </div>
                ) : (
                    <>
                        {/* Desktop Table */}
                        <div className="hidden 2xl:block overflow-x-auto">
                            <table className="w-full">
                                <thead>
                                    <tr style={{ borderBottom: '1px solid var(--glass-border)' }}>
                                        {['Order ID', 'Customer', 'Date', 'Payment', 'Status', 'Total', ''].map(h => (
                                            <th key={h} className="px-5 py-3.5 text-left text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'hsl(var(--muted-foreground))' }}>{h}</th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                     {orders.map((order, i) => {
                                         const ss = getStatusStyle(order.orderStatus);
                                         const money = currentUser?.role === 'seller'
                                             ? inspectSellerOrderListMoney(order)
                                             : inspectOrderListMoney(order);
                                        return (
                                            <motion.tr key={order._id} initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                                                transition={{ delay: i * 0.02 }}
                                                className="transition-colors hover:bg-white/5" style={{ borderBottom: '1px solid var(--glass-border-subtle)' }}>
                                                <td className="px-5 py-4 text-sm font-medium" style={{ color: 'hsl(var(--foreground))' }}>{order.orderId}</td>
                                                <td className="px-5 py-4 text-sm truncate max-w-[160px]" style={{ color: 'hsl(var(--muted-foreground))' }}>{order.shippingInfo.fullName}</td>
                                                <td className="px-5 py-4 text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>{new Date(order.createdAt).toLocaleDateString()}</td>
                                                <td className="px-5 py-4">
                                                    <span className="px-2.5 py-1 text-[10px] rounded-full font-semibold"
                                                        style={order.isPaid ? { background: 'rgba(16, 185, 129, 0.12)', color: 'hsl(150, 60%, 40%)' } : { background: 'rgba(239, 68, 68, 0.12)', color: 'hsl(0, 72%, 55%)' }}>
                                                        {order.isPaid ? "Paid" : "Unpaid"}
                                                    </span>
                                                </td>
                                                <td className="px-5 py-4">
                                                    <span className="px-2.5 py-1 text-[10px] rounded-full flex items-center gap-1 w-fit font-semibold" style={{ background: ss.bg, color: ss.color }}>
                                                        {getStatusIcon(order.orderStatus)}
                                                        {(order.orderStatus || 'unknown').charAt(0).toUpperCase() + (order.orderStatus || 'unknown').slice(1)}
                                                    </span>
                                                </td>
                                                <td className="px-5 py-4" style={{ color: 'hsl(var(--foreground))' }}>
                                                    <div className="text-sm font-bold" style={{ letterSpacing: '-0.03em' }}>
                                                        {money.valid
                                                            ? formatPrice(money.total, { sourceCurrency: money.currency, targetCurrency: money.currency, showCode: true })
                                                            : 'Money unavailable'}
                                                    </div>
                                                    {money.valid && money.buyerCurrency && money.buyerCurrency !== money.currency && (
                                                        <div className="text-[10px] mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                                            {formatBuyerOrderedAmount(money)}
                                                        </div>
                                                    )}
                                                </td>
                                                <td className="px-5 py-4">
                                                    <div className="flex items-center gap-3 justify-end">
                                                        {(() => {
                                                            const hasPhone = hasWhatsAppPhone(order);
                                                            const confirmed = isOrderConfirmedByBuyer(order);
                                                            const enabled = hasPhone && !confirmed && money.valid;
                                                            const title = !money.valid
                                                                ? 'Order money is unavailable; refresh before contacting the buyer'
                                                                : confirmed
                                                                ? `${getConfirmationSourceLabel(order) || 'Confirmed by buyer'}${order.confirmation?.confirmedAt ? ' · ' + new Date(order.confirmation.confirmedAt).toLocaleDateString() : ''}`
                                                                : (hasPhone ? 'Verify on WhatsApp' : 'No valid international WhatsApp destination');
                                                            return (
                                                                <button
                                                                    type="button"
                                                                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); if (enabled) openWhatsAppVerify(order, formatPrice); }}
                                                                    disabled={!enabled}
                                                                    title={title}
                                                                    className="inline-flex items-center justify-center w-8 h-8 rounded-full transition-all"
                                                                    style={{
                                                                        background: confirmed ? 'rgba(16, 185, 129, 0.18)' : (hasPhone ? 'rgba(37, 211, 102, 0.15)' : 'rgba(255,255,255,0.04)'),
                                                                        color: confirmed ? 'hsl(150, 60%, 40%)' : (hasPhone ? 'hsl(142, 70%, 45%)' : 'hsl(var(--muted-foreground))'),
                                                                        cursor: enabled ? 'pointer' : 'not-allowed',
                                                                        opacity: enabled ? 1 : 0.7,
                                                                    }}
                                                                >
                                                                    {confirmed ? <CheckCircle size={14} /> : <MessageCircle size={14} />}
                                                                </button>
                                                            );
                                                        })()}
                                                        {(() => {
                                                            const label = getConfirmationSourceLabel(order);
                                                            if (!label) return null;
                                                            const isCancel = label.toLowerCase().includes('cancel');
                                                            return (
                                                                <span className="text-[10px] font-semibold inline-flex items-center gap-1 px-2 py-0.5 rounded-full whitespace-nowrap"
                                                                    style={isCancel
                                                                        ? { background: 'rgba(239, 68, 68, 0.12)', color: 'hsl(0, 72%, 50%)', border: '1px solid rgba(239, 68, 68, 0.25)' }
                                                                        : { background: 'rgba(16, 185, 129, 0.15)', color: 'hsl(150, 60%, 38%)', border: '1px solid rgba(16, 185, 129, 0.3)' }
                                                                    }>
                                                                    {isCancel ? <XCircle size={10} /> : <CheckCircle size={10} />} {label}
                                                                </span>
                                                            );
                                                        })()}
                                                        <Link to={`/${currentUser?.role === 'seller' ? 'seller' : 'admin'}-dashboard/order/${order._id}`}>
                                                            <motion.span whileHover={{ x: 3 }} className="text-xs font-semibold flex items-center gap-1" style={{ color: 'hsl(var(--primary))' }}>
                                                                View <ArrowRight size={12} />
                                                            </motion.span>
                                                        </Link>
                                                    </div>
                                                </td>
                                            </motion.tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>

                        {/* Mobile Cards */}
                        <div className="2xl:hidden space-y-3 p-4">
                             {orders.map((order, i) => {
                                 const ss = getStatusStyle(order.orderStatus);
                                 const money = currentUser?.role === 'seller'
                                     ? inspectSellerOrderListMoney(order)
                                     : inspectOrderListMoney(order);
                                return (
                                    <motion.div key={order._id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
                                        transition={{ delay: i * 0.03 }}>
                                        <Link to={`/${currentUser?.role === 'seller' ? 'seller' : 'admin'}-dashboard/order/${order._id}`}>
                                            <div className="glass-inner rounded-xl p-4 hover:bg-white/5 transition-all cursor-pointer">
                                                <div className="flex justify-between items-start gap-2 mb-3">
                                                    <div className="min-w-0 flex-1">
                                                        <h2 className="font-semibold text-sm truncate" style={{ color: 'hsl(var(--foreground))' }}>{order.orderId}</h2>
                                                        <p className="text-xs mt-0.5" style={{ color: 'hsl(var(--muted-foreground))' }}>{order.shippingInfo.fullName}</p>
                                                    </div>
                                                    <span className="px-2 py-0.5 text-[10px] rounded-full flex items-center gap-1 font-semibold shrink-0" style={{ background: ss.bg, color: ss.color }}>
                                                        {getStatusIcon(order.orderStatus)}
                                                        {(order.orderStatus || 'unknown').charAt(0).toUpperCase() + (order.orderStatus || 'unknown').slice(1)}
                                                    </span>
                                                </div>
                                                {(() => {
                                                    const label = getConfirmationSourceLabel(order);
                                                    if (!label) return null;
                                                    const isCancel = label.toLowerCase().includes('cancel');
                                                    return (
                                                        <div className="mb-2">
                                                            <span className="text-[10px] font-semibold inline-flex items-center gap-1 px-2 py-0.5 rounded-full"
                                                                style={isCancel
                                                                    ? { background: 'rgba(239, 68, 68, 0.12)', color: 'hsl(0, 72%, 50%)', border: '1px solid rgba(239, 68, 68, 0.25)' }
                                                                    : { background: 'rgba(16, 185, 129, 0.15)', color: 'hsl(150, 60%, 38%)', border: '1px solid rgba(16, 185, 129, 0.3)' }
                                                                }>
                                                                {isCancel ? <XCircle size={10} /> : <CheckCircle size={10} />} {label}
                                                            </span>
                                                        </div>
                                                    );
                                                })()}
                                                <div className="flex justify-between items-center">
                                                    <div className="flex items-start gap-2">
                                                        <span className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>{new Date(order.createdAt).toLocaleDateString()}</span>
                                                        <span className="px-2 py-0.5 text-[10px] rounded-full font-medium"
                                                            style={order.isPaid ? { background: 'rgba(16, 185, 129, 0.12)', color: 'hsl(150, 60%, 40%)' } : { background: 'rgba(239, 68, 68, 0.12)', color: 'hsl(0, 72%, 55%)' }}>
                                                            {order.isPaid ? 'Paid' : 'Unpaid'}
                                                        </span>
                                                    </div>
                                                    <div className="flex items-center gap-2">
                                                        {(() => {
                                                            const hasPhone = hasWhatsAppPhone(order);
                                                            const confirmed = isOrderConfirmedByBuyer(order);
                                                            const enabled = hasPhone && !confirmed && money.valid;
                                                            return (
                                                                <button
                                                                    type="button"
                                                                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); if (enabled) openWhatsAppVerify(order, formatPrice); }}
                                                                    disabled={!enabled}
                                                                    aria-label={confirmed ? 'Confirmed via email' : (hasPhone ? 'Verify on WhatsApp' : 'No valid international WhatsApp destination')}
                                                                    className="inline-flex items-center justify-center w-7 h-7 rounded-full"
                                                                    style={{
                                                                        background: confirmed ? 'rgba(16, 185, 129, 0.18)' : (hasPhone ? 'rgba(37, 211, 102, 0.15)' : 'rgba(255,255,255,0.04)'),
                                                                        color: confirmed ? 'hsl(150, 60%, 40%)' : (hasPhone ? 'hsl(142, 70%, 45%)' : 'hsl(var(--muted-foreground))'),
                                                                        opacity: enabled ? 1 : 0.7,
                                                                    }}
                                                                >
                                                                    {confirmed ? <CheckCircle size={12} /> : <MessageCircle size={12} />}
                                                                </button>
                                                            );
                                                        })()}
                                                        <div className="text-right">
                                                            <span className="text-sm font-bold block" style={{ color: 'hsl(var(--foreground))' }}>
                                                                {money.valid
                                                                    ? formatPrice(money.total, { sourceCurrency: money.currency, targetCurrency: money.currency, showCode: true })
                                                                    : 'Money unavailable'}
                                                            </span>
                                                            {money.valid && money.buyerCurrency && money.buyerCurrency !== money.currency && (
                                                                <p className="text-[10px] mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                                                    {formatBuyerOrderedAmount(money)}
                                                                </p>
                                                            )}
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>
                                        </Link>
                                    </motion.div>
                                );
                            })}
                        </div>
                    </>
                )}
            </motion.div>
                </>
            )}
        </div>
    );
};

export default OrderManagement;
