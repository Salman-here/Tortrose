import { useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Globe, Search, Eye, ShoppingBag, DollarSign, CheckCircle, Lock, Clock, Loader2, Edit3, Save, X, ExternalLink, Users, BarChart3, AlertTriangle, Filter } from 'lucide-react';
import axios from 'axios';
import { toast } from 'react-toastify';
import { useCurrency } from '../../contexts/CurrencyContext';
import Loader from '../common/Loader';
import { getStoreSubdomainUrl } from '../../utils/subdomainHelper';
import { getAuthToken } from "../../utils/cookieHelper";
import { normalizeCurrencyCode } from '../../utils/currencySafety';
import { inspectAdminSubdomainResponse } from '../../utils/subdomainAnalyticsSafety';

const AdminSubdomainManagement = () => {
    const { formatPrice, currency } = useCurrency();
    const [loading, setLoading] = useState(true);
    const [stores, setStores] = useState([]);
    const [summary, setSummary] = useState(null);
    const [pagination, setPagination] = useState(null);
    const [responseCurrency, setResponseCurrency] = useState(null);
    const [loadError, setLoadError] = useState('');
    const [search, setSearch] = useState('');
    const [statusFilter, setStatusFilter] = useState('all');
    const [page, setPage] = useState(1);
    const [editingStore, setEditingStore] = useState(null);
    const [editSlug, setEditSlug] = useState('');
    const [savingSlug, setSavingSlug] = useState(false);
    const requestRef = useRef({ id: 0, controller: null });

    const clearData = useCallback(() => {
        setStores([]);
        setSummary(null);
        setPagination(null);
        setResponseCurrency(null);
    }, []);

    const fetchData = useCallback(async () => {
        requestRef.current.controller?.abort();
        const controller = new AbortController();
        const requestId = requestRef.current.id + 1;
        requestRef.current = { id: requestId, controller };
        try {
            setLoading(true);
            setLoadError('');
            clearData();
            const requestedCurrency = normalizeCurrencyCode(currency, '');
            if (!requestedCurrency) throw new Error('Choose a supported display currency before loading revenue.');
            const token = getAuthToken();
            const params = new URLSearchParams();
            if (search) params.append('search', search);
            if (statusFilter !== 'all') params.append('status', statusFilter);
            params.append('currency', requestedCurrency);
            params.append('page', page);
            params.append('limit', 15);

            const res = await axios.get(`${import.meta.env.VITE_API_URL}api/subdomain/admin/all?${params}`, {
                headers: { Authorization: `Bearer ${token}` },
                signal: controller.signal,
            });
            const inspected = inspectAdminSubdomainResponse(res.data, requestedCurrency, {
                expectedPage: page,
                expectedLimit: 15,
            });
            if (!inspected.valid) {
                throw new Error('Subdomain data contains invalid or inconsistent revenue, currency, count, identity, or pagination fields.');
            }
            if (requestRef.current.id !== requestId) return;
            setStores(inspected.stores);
            setSummary(inspected.summary);
            setPagination(inspected.pagination);
            setResponseCurrency(inspected.currency);
        } catch (error) {
            if (controller.signal.aborted || error?.code === 'ERR_CANCELED' || error?.name === 'CanceledError') return;
            if (requestRef.current.id !== requestId) return;
            clearData();
            const message = error.response?.data?.msg || error.message || 'Failed to load subdomain data';
            setLoadError(message);
            toast.error(message);
        } finally {
            if (requestRef.current.id === requestId) setLoading(false);
        }
    }, [clearData, currency, page, search, statusFilter]);

    useEffect(() => {
        requestRef.current.controller?.abort();
        requestRef.current.id += 1;
        clearData();
        setLoadError('');
        setLoading(true);
        const timer = setTimeout(fetchData, search ? 400 : 0);
        return () => {
            clearTimeout(timer);
            requestRef.current.controller?.abort();
            requestRef.current.id += 1;
        };
    }, [clearData, fetchData, search]);

    const handleUpdateSlug = async (storeId) => {
        if (!editSlug || editSlug.length < 3) { toast.error('Subdomain must be at least 3 characters'); return; }
        try {
            setSavingSlug(true);
            const token = getAuthToken();
            await axios.put(`${import.meta.env.VITE_API_URL}api/subdomain/admin/${storeId}/update-slug`, { newSlug: editSlug }, {
                headers: { Authorization: `Bearer ${token}` }
            });
            toast.success('Subdomain updated!');
            setEditingStore(null);
            fetchData();
        } catch (error) {
            toast.error(error.response?.data?.msg || 'Failed to update');
        } finally { setSavingSlug(false); }
    };

    const handleToggleVerification = async (store) => {
        try {
            const token = getAuthToken();
            if (store.verification?.isVerified) {
                await axios.put(`${import.meta.env.VITE_API_URL}api/stores/verification/${store._id}/remove`, { reason: 'Admin action' }, {
                    headers: { Authorization: `Bearer ${token}` }
                });
                toast.success('Verification removed');
            } else {
                await axios.put(`${import.meta.env.VITE_API_URL}api/stores/verification/${store._id}/approve`, {}, {
                    headers: { Authorization: `Bearer ${token}` }
                });
                toast.success('Store verified');
            }
            fetchData();
        } catch (error) {
            toast.error(error.response?.data?.msg || 'Action failed');
        }
    };

    const summaryCards = [
        { label: 'Total Stores', value: summary ? summary.totalStores : '—', icon: <Globe size={18} />, color: 'hsl(220, 70%, 55%)' },
        { label: 'Live Subdomains', value: summary ? summary.activeSubdomains : '—', icon: <CheckCircle size={18} />, color: 'hsl(150, 60%, 45%)' },
        { label: 'Inactive', value: summary ? summary.inactiveSubdomains : '—', icon: <Lock size={18} />, color: 'hsl(45, 80%, 45%)' },
        { label: 'Pending Verification', value: summary ? summary.pendingVerifications : '—', icon: <Clock size={18} />, color: 'hsl(30, 90%, 50%)' },
        { label: 'Total Views', value: summary ? summary.totalViews : '—', icon: <Eye size={18} />, color: 'hsl(280, 60%, 55%)' },
    ];

    const statusTabs = [
        { key: 'all', label: 'All' },
        { key: 'active', label: 'Active' },
        { key: 'inactive', label: 'Inactive' },
        { key: 'pending', label: 'Pending' },
    ];

    const getStatusBadge = (store) => {
        if (store.isSubdomainActive) {
            return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold" style={{ background: 'rgba(34,197,94,0.12)', color: 'hsl(150, 60%, 40%)' }}><CheckCircle size={10} /> Active</span>;
        }
        if (store.verification?.status === 'pending') {
            return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold" style={{ background: 'rgba(234,179,8,0.12)', color: 'hsl(45, 80%, 40%)' }}><Clock size={10} /> Pending</span>;
        }
        return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold" style={{ background: 'rgba(107,114,128,0.12)', color: 'hsl(var(--muted-foreground))' }}><Lock size={10} /> Inactive</span>;
    };

    return (
        <div className="p-4 md:p-6 max-w-6xl mx-auto">
            {/* Header */}
            <div className="mb-6">
                <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight flex items-center gap-2" style={{ color: 'hsl(var(--foreground))' }}>
                    <Globe size={28} />
                    Subdomain Management
                </h1>
                <p className="text-sm mt-2" style={{ color: 'hsl(var(--muted-foreground))' }}>
                    View and manage store subdomains, traffic, and verification status
                </p>
            </div>

            {/* Summary Cards */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
                {summaryCards.map((card, i) => (
                    <motion.div key={i} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}
                        whileHover={{ y: -3 }} className="glass-card p-4">
                        <div className="glass-inner inline-flex p-2 rounded-xl mb-2" style={{ color: card.color }}>{card.icon}</div>
                        <p className="text-[10px] font-medium uppercase tracking-wider" style={{ color: 'hsl(var(--muted-foreground))' }}>{card.label}</p>
                        <p className="text-xl font-extrabold" style={{ color: 'hsl(var(--foreground))' }}>{card.value}</p>
                    </motion.div>
                ))}
            </div>

            {/* Filters */}
            <div className="glass-panel p-4 mb-6">
                <div className="flex flex-col md:flex-row gap-3">
                    {/* Search */}
                    <div className="flex-1 relative">
                        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'hsl(var(--muted-foreground))' }} />
                        <input type="text" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                            className="glass-input pl-10" placeholder="Search by store name or subdomain..." />
                    </div>
                    {/* Status tabs */}
                    <div className="flex gap-1 p-1 rounded-xl" style={{ background: 'var(--glass-bg)' }}>
                        {statusTabs.map(tab => (
                            <button key={tab.key} onClick={() => { setStatusFilter(tab.key); setPage(1); }}
                                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${statusFilter === tab.key ? 'text-white shadow-sm' : ''}`}
                                style={statusFilter === tab.key
                                    ? { background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(200, 80%, 50%))' }
                                    : { color: 'hsl(var(--muted-foreground))' }}>
                                {tab.label}
                            </button>
                        ))}
                    </div>
                </div>
            </div>

            {/* Stores Table */}
            {loading ? (
                <div className="flex justify-center py-16"><Loader /></div>
            ) : loadError ? (
                <div className="glass-panel p-10 text-center">
                    <AlertTriangle size={36} style={{ color: 'hsl(0, 72%, 55%)' }} className="mx-auto mb-3" />
                    <p className="text-sm font-semibold" style={{ color: 'hsl(var(--foreground))' }}>Subdomain data is unavailable</p>
                    <p className="text-xs mt-2" style={{ color: 'hsl(var(--muted-foreground))' }}>{loadError}</p>
                    <button type="button" onClick={fetchData} className="mt-4 px-4 py-2 rounded-xl glass-inner text-xs font-semibold">
                        Retry
                    </button>
                </div>
            ) : stores.length === 0 ? (
                <div className="glass-panel p-12 text-center">
                    <Globe size={40} style={{ color: 'hsl(var(--muted-foreground))' }} className="mx-auto mb-3 opacity-40" />
                    <p className="text-sm font-medium" style={{ color: 'hsl(var(--muted-foreground))' }}>No stores found</p>
                </div>
            ) : (
                <div className="space-y-3">
                    {stores.map((store, i) => (
                        <motion.div key={store._id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: i * 0.03 }} className="glass-panel p-4 md:p-5">
                            <div className="flex flex-col lg:flex-row lg:items-center gap-4">
                                {/* Store Info */}
                                <div className="flex items-center gap-3 flex-1 min-w-0">
                                    {store.logo ? (
                                        <img src={store.logo} alt="" className="w-10 h-10 rounded-xl object-cover shrink-0" style={{ border: '2px solid var(--glass-border)' }} />
                                    ) : (
                                        <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ background: 'var(--glass-bg-strong)', color: 'hsl(var(--muted-foreground))' }}>
                                            <Globe size={18} />
                                        </div>
                                    )}
                                    <div className="min-w-0">
                                        <div className="flex items-center gap-2">
                                            <p className="text-sm font-bold truncate" style={{ color: 'hsl(var(--foreground))' }}>{store.storeName}</p>
                                            {getStatusBadge(store)}
                                        </div>
                                        {editingStore === store._id ? (
                                            <div className="flex items-center gap-1 mt-1">
                                                <input type="text" value={editSlug} onChange={(e) => setEditSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                                                    className="text-xs font-mono px-2 py-1 rounded-lg bg-transparent outline-none" style={{ border: '1px solid var(--glass-border)', color: 'hsl(var(--foreground))' }}
                                                    placeholder="new-slug" />
                                                <span className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>.rozare.com</span>
                                                <button onClick={() => handleUpdateSlug(store._id)} disabled={savingSlug}
                                                    className="p-1 rounded-lg" style={{ color: 'hsl(150, 60%, 45%)' }}>
                                                    {savingSlug ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                                                </button>
                                                <button onClick={() => setEditingStore(null)} className="p-1 rounded-lg" style={{ color: 'hsl(0, 72%, 55%)' }}>
                                                    <X size={14} />
                                                </button>
                                            </div>
                                        ) : (
                                            <div className="flex items-center gap-1 mt-0.5">
                                                <span className="text-xs font-mono" style={{ color: 'hsl(var(--primary))' }}>{store.subdomainUrl}</span>
                                                <button onClick={() => { setEditingStore(store._id); setEditSlug(store.storeSlug); }}
                                                    className="p-0.5 rounded hover:bg-white/10">
                                                    <Edit3 size={10} style={{ color: 'hsl(var(--muted-foreground))' }} />
                                                </button>
                                            </div>
                                        )}
                                        <p className="text-[10px] mt-0.5" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                            {store.seller?.username} · {store.seller?.email}
                                        </p>
                                    </div>
                                </div>

                                {/* Metrics */}
                                <div className="flex flex-wrap gap-4 lg:gap-6">
                                    <div className="text-center">
                                        <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>Views</p>
                                        <p className="text-sm font-bold" style={{ color: 'hsl(var(--foreground))' }}>{store.views}</p>
                                    </div>
                                    <div className="text-center">
                                        <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>Products</p>
                                        <p className="text-sm font-bold" style={{ color: 'hsl(var(--foreground))' }}>{store.productCount}</p>
                                    </div>
                                    <div className="text-center">
                                        <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>Orders</p>
                                        <p className="text-sm font-bold" style={{ color: 'hsl(var(--foreground))' }}>{store.totalOrders}</p>
                                    </div>
                                    <div className="text-center">
                                        <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>Revenue</p>
                                        <p className="text-sm font-bold" style={{ color: 'hsl(var(--foreground))' }}>{formatPrice(store.totalRevenue, { sourceCurrency: responseCurrency })}</p>
                                    </div>
                                    <div className="text-center">
                                        <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>Trust</p>
                                        <p className="text-sm font-bold" style={{ color: 'hsl(var(--foreground))' }}>{store.trustCount}</p>
                                    </div>
                                </div>

                                {/* Actions */}
                                <div className="flex items-center gap-2 shrink-0">
                                    <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.97 }}
                                        onClick={() => handleToggleVerification(store)}
                                        className="px-3 py-1.5 rounded-lg text-xs font-semibold text-white"
                                        style={{ background: store.verification?.isVerified ? 'hsl(0, 72%, 55%)' : 'hsl(150, 60%, 45%)' }}>
                                        {store.verification?.isVerified ? 'Remove Verification' : 'Verify Store'}
                                    </motion.button>
                                    <a href={getStoreSubdomainUrl(store.storeSlug)} target="_blank" rel="noreferrer"
                                        className="p-1.5 rounded-lg glass-inner" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                        <ExternalLink size={14} />
                                    </a>
                                </div>
                            </div>
                        </motion.div>
                    ))}
                </div>
            )}

            {/* Pagination */}
            {pagination?.pages > 1 && (
                <div className="flex justify-center gap-2 mt-6">
                    {Array.from({ length: pagination.pages }, (_, i) => (
                        <button key={i} onClick={() => setPage(i + 1)}
                            className={`w-8 h-8 rounded-lg text-xs font-semibold transition-all ${page === i + 1 ? 'text-white' : 'glass-inner'}`}
                            style={page === i + 1 ? { background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(200, 80%, 50%))' } : { color: 'hsl(var(--muted-foreground))' }}>
                            {i + 1}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
};

export default AdminSubdomainManagement;
