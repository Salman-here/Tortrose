import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { MessageSquare, Search, AlertCircle, Clock, CheckCircle, Loader2, User, Package, ShoppingBag, Bug, Lightbulb, HelpCircle, Bot, Store, Star } from 'lucide-react';
import axios from 'axios';
import { toast } from 'react-toastify';
import Loader from '../common/Loader';
import { getAuthToken } from "../../utils/cookieHelper";

const CATEGORIES = [
    { value: '', label: 'All Categories' },
    { value: 'product_issue', label: 'Product Issue', icon: <Package size={14} /> },
    { value: 'order_issue', label: 'Order Issue', icon: <ShoppingBag size={14} /> },
    { value: 'delivery', label: 'Delivery', icon: <ShoppingBag size={14} /> },
    { value: 'refund', label: 'Refund', icon: <AlertCircle size={14} /> },
    { value: 'seller_complaint', label: 'Seller Complaint', icon: <User size={14} /> },
    { value: 'website_bug', label: 'Website Bug', icon: <Bug size={14} /> },
    { value: 'suggestion', label: 'Suggestion', icon: <Lightbulb size={14} /> },
    { value: 'ai_response', label: 'AI Response Report', icon: <Bot size={14} /> },
    { value: 'review_report', label: 'Review Report', icon: <Star size={14} /> },
    { value: 'store_report', label: 'Store Report', icon: <Store size={14} /> },
    { value: 'other', label: 'Other', icon: <HelpCircle size={14} /> },
];

const STATUSES = [
    { value: '', label: 'All Status' },
    { value: 'open', label: 'Open' },
    { value: 'in_progress', label: 'In Progress' },
    { value: 'resolved', label: 'Resolved' },
    { value: 'closed', label: 'Closed' },
];

const statusColors = {
    open: { bg: 'rgba(239,68,68,0.12)', color: 'hsl(0,72%,55%)' },
    in_progress: { bg: 'rgba(245,158,11,0.12)', color: 'hsl(45,80%,40%)' },
    resolved: { bg: 'rgba(16,185,129,0.12)', color: 'hsl(150,60%,45%)' },
    closed: { bg: 'rgba(107,114,128,0.12)', color: 'hsl(var(--muted-foreground))' },
};

const priorityColors = {
    low: { bg: 'rgba(107,114,128,0.12)', color: 'hsl(var(--muted-foreground))' },
    medium: { bg: 'rgba(99,102,241,0.12)', color: 'hsl(220,70%,55%)' },
    high: { bg: 'rgba(245,158,11,0.12)', color: 'hsl(45,80%,40%)' },
    urgent: { bg: 'rgba(239,68,68,0.12)', color: 'hsl(0,72%,55%)' },
};

const ComplaintsManagement = () => {
    const [complaints, setComplaints] = useState([]);
    const [loading, setLoading] = useState(true);
    const [category, setCategory] = useState('');
    const [status, setStatus] = useState('');
    const [search, setSearch] = useState('');
    const [selectedComplaint, setSelectedComplaint] = useState(null);
    const [adminResponse, setAdminResponse] = useState('');
    const [updatingId, setUpdatingId] = useState(null);
    const [stats, setStats] = useState({ categoryStats: {}, statusStats: {} });

    const fetchComplaints = async () => {
        setLoading(true);
        try {
            const token = getAuthToken();
            const params = new URLSearchParams();
            if (category) params.append('category', category);
            if (status) params.append('status', status);
            const res = await axios.get(`${import.meta.env.VITE_API_URL}api/chatbot/complaints?${params}`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            setComplaints(res.data.complaints);
            setStats({ categoryStats: res.data.categoryStats, statusStats: res.data.statusStats });
        } catch (err) {
            toast.error('Failed to fetch complaints');
        } finally { setLoading(false); }
    };

    useEffect(() => { fetchComplaints(); }, [category, status]);

    const handleUpdate = async (id, updates) => {
        setUpdatingId(id);
        try {
            const token = getAuthToken();
            await axios.put(`${import.meta.env.VITE_API_URL}api/chatbot/complaint/${id}`, updates, {
                headers: { Authorization: `Bearer ${token}` }
            });
            toast.success('Complaint updated');
            fetchComplaints();
            if (selectedComplaint?._id === id) {
                setSelectedComplaint(prev => ({ ...prev, ...updates }));
            }
        } catch (err) {
            toast.error('Failed to update');
        } finally { setUpdatingId(null); }
    };

    const totalOpen = stats.statusStats?.open || 0;
    const totalInProgress = stats.statusStats?.in_progress || 0;
    const totalResolved = stats.statusStats?.resolved || 0;

    const filteredComplaints = search
        ? complaints.filter(c => c.subject.toLowerCase().includes(search.toLowerCase()) || c.message.toLowerCase().includes(search.toLowerCase()))
        : complaints;

    if (loading && complaints.length === 0) return <div className="flex justify-center items-center h-64"><Loader /></div>;

    return (
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="p-4 md:p-6 max-w-6xl mx-auto">
            {/* Header */}
            <div className="mb-6">
                <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight flex items-center gap-2" style={{ color: 'hsl(var(--foreground))' }}>
                    <MessageSquare size={28} /> Complaints & Feedback
                </h1>
                <p className="text-sm mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>Manage customer complaints, suggestions, and support requests</p>
            </div>

            {/* Stats */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
                {[
                    { label: 'Open', value: totalOpen, cs: statusColors.open, icon: <AlertCircle size={18} /> },
                    { label: 'In Progress', value: totalInProgress, cs: statusColors.in_progress, icon: <Clock size={18} /> },
                    { label: 'Resolved', value: totalResolved, cs: statusColors.resolved, icon: <CheckCircle size={18} /> },
                    { label: 'Total', value: complaints.length, cs: { bg: 'rgba(99,102,241,0.12)', color: 'hsl(220,70%,55%)' }, icon: <MessageSquare size={18} /> },
                ].map((s, i) => (
                    <div key={i} className="glass-card p-4">
                        <div className="glass-inner inline-flex p-2 rounded-xl mb-2" style={{ color: s.cs.color }}>{s.icon}</div>
                        <p className="text-xs font-medium" style={{ color: 'hsl(var(--muted-foreground))' }}>{s.label}</p>
                        <p className="text-2xl font-extrabold" style={{ color: 'hsl(var(--foreground))' }}>{s.value}</p>
                    </div>
                ))}
            </div>

            {/* Category Stats */}
            {Object.keys(stats.categoryStats).length > 0 && (
                <div className="glass-panel p-4 mb-6">
                    <p className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: 'hsl(var(--muted-foreground))' }}>By Category</p>
                    <div className="flex flex-wrap gap-2">
                        {Object.entries(stats.categoryStats).map(([cat, count]) => {
                            const catInfo = CATEGORIES.find(c => c.value === cat);
                            return (
                                <button key={cat} onClick={() => setCategory(category === cat ? '' : cat)}
                                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all"
                                    style={category === cat
                                        ? { background: 'hsl(220,70%,55%)', color: 'white' }
                                        : { background: 'rgba(99,102,241,0.08)', color: 'hsl(220,70%,55%)' }}>
                                    {catInfo?.icon} {catInfo?.label || cat} ({count})
                                </button>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* Filters */}
            <div className="glass-panel p-4 mb-6">
                <div className="flex flex-col sm:flex-row gap-3">
                    <div className="search-input-wrapper flex-1">
                        <div className="search-input-icon"><Search size={16} /></div>
                        <input type="text" placeholder="Search complaints..." value={search}
                            onChange={e => setSearch(e.target.value)} className="glass-input glass-input-search" />
                    </div>
                    <select value={status} onChange={e => setStatus(e.target.value)} className="glass-input cursor-pointer font-medium w-full sm:w-40">
                        {STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                    </select>
                </div>
            </div>

            {/* Complaints List */}
            <div className="space-y-3">
                {filteredComplaints.length === 0 ? (
                    <div className="glass-panel p-8 text-center">
                        <MessageSquare size={40} className="mx-auto mb-3" style={{ color: 'hsl(var(--muted-foreground))' }} />
                        <p className="text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>No complaints found</p>
                    </div>
                ) : (
                    filteredComplaints.map(c => {
                        const sc = statusColors[c.status] || statusColors.open;
                        const pc = priorityColors[c.priority] || priorityColors.medium;
                        return (
                            <motion.div key={c._id} layout className="glass-panel p-4 cursor-pointer hover:scale-[1.005] transition-transform"
                                onClick={() => setSelectedComplaint(selectedComplaint?._id === c._id ? null : c)}>
                                <div className="flex items-start gap-3">
                                    <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0" style={{ background: sc.bg, color: sc.color }}>
                                        {c.status === 'open' ? <AlertCircle size={16} /> : c.status === 'in_progress' ? <Clock size={16} /> : <CheckCircle size={16} />}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2 flex-wrap mb-1">
                                            <p className="text-sm font-semibold truncate" style={{ color: 'hsl(var(--foreground))' }}>{c.subject}</p>
                                            <span className="text-[10px] px-2 py-0.5 rounded-full font-medium" style={{ background: sc.bg, color: sc.color }}>{c.status.replace('_', ' ')}</span>
                                            <span className="text-[10px] px-2 py-0.5 rounded-full font-medium" style={{ background: pc.bg, color: pc.color }}>{c.priority}</span>
                                        </div>
                                        <p className="text-xs truncate" style={{ color: 'hsl(var(--muted-foreground))' }}>{c.message}</p>
                                        <div className="flex items-center gap-3 mt-2 text-[11px]" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                            <span className="flex items-center gap-1"><User size={11} /> {c.user?.username || 'Anonymous'}</span>
                                            <span>{CATEGORIES.find(cat => cat.value === c.category)?.label || c.category}</span>
                                            <span>{new Date(c.createdAt).toLocaleDateString()}</span>
                                        </div>
                                    </div>
                                </div>

                                {/* Expanded detail */}
                                <AnimatePresence>
                                    {selectedComplaint?._id === c._id && (
                                        <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
                                            className="mt-4 pt-4 overflow-hidden" style={{ borderTop: '1px solid var(--glass-border)' }}>
                                            <div className="glass-inner rounded-xl p-3 mb-3">
                                                <p className="text-xs font-semibold mb-1" style={{ color: 'hsl(var(--foreground))' }}>Full Message:</p>
                                                <p className="text-sm whitespace-pre-line" style={{ color: 'hsl(var(--muted-foreground))' }}>{c.message}</p>
                                            </div>
                                            {c.report?.kind && (
                                                <div className="glass-inner rounded-xl p-3 mb-3">
                                                    <div className="flex flex-wrap gap-2 mb-2">
                                                        <span className="text-[10px] px-2 py-1 rounded-full font-bold uppercase" style={{ background: 'rgba(99,102,241,0.12)', color: 'hsl(220,70%,55%)' }}>
                                                            {c.report.kind.replace('_', ' ')}
                                                        </span>
                                                        <span className="text-[10px] px-2 py-1 rounded-full font-bold uppercase" style={{ background: 'rgba(245,158,11,0.12)', color: 'hsl(45,80%,40%)' }}>
                                                            {c.report.reason}
                                                        </span>
                                                        <span className="text-[10px] px-2 py-1 rounded-full font-bold uppercase" style={{ background: 'rgba(107,114,128,0.12)', color: 'hsl(var(--muted-foreground))' }}>
                                                            {c.report.reporterType}
                                                        </span>
                                                    </div>
                                                    {c.report.targetUser?.username && <p className="text-xs mb-2" style={{ color: 'hsl(var(--muted-foreground))' }}>Reported account: <strong style={{ color: 'hsl(var(--foreground))' }}>{c.report.targetUser.username}</strong></p>}
                                                    {c.report.contentSnapshot && <p className="text-xs whitespace-pre-line break-words" style={{ color: 'hsl(var(--muted-foreground))' }}>{c.report.contentSnapshot}</p>}
                                                </div>
                                            )}
                                            {c.user?.email && (
                                                <p className="text-xs mb-3" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                                    Email: <span className="font-medium" style={{ color: 'hsl(var(--foreground))' }}>{c.user.email}</span>
                                                </p>
                                            )}
                                            {c.adminResponse && (
                                                <div className="glass-inner rounded-xl p-3 mb-3" style={{ borderLeft: '3px solid hsl(220,70%,55%)' }}>
                                                    <p className="text-xs font-semibold mb-1" style={{ color: 'hsl(220,70%,55%)' }}>Admin Response:</p>
                                                    <p className="text-sm" style={{ color: 'hsl(var(--foreground))' }}>{c.adminResponse}</p>
                                                </div>
                                            )}
                                            <div className="flex flex-col sm:flex-row gap-2">
                                                <input type="text" placeholder="Write admin response..."
                                                    value={adminResponse} onChange={e => setAdminResponse(e.target.value)}
                                                    className="glass-input text-sm flex-1" onClick={e => e.stopPropagation()} />
                                                <div className="flex gap-2">
                                                    <button onClick={(e) => { e.stopPropagation(); handleUpdate(c._id, { adminResponse, status: 'in_progress' }); setAdminResponse(''); }}
                                                        disabled={!adminResponse.trim() || updatingId === c._id}
                                                        className="px-3 py-2 rounded-xl text-xs font-semibold text-white disabled:opacity-50"
                                                        style={{ background: 'hsl(220,70%,55%)' }}>
                                                        {updatingId === c._id ? <Loader2 size={12} className="animate-spin" /> : 'Respond'}
                                                    </button>
                                                    <select value={c.status} onClick={e => e.stopPropagation()}
                                                        onChange={e => { e.stopPropagation(); handleUpdate(c._id, { status: e.target.value }); }}
                                                        className="glass-input text-xs py-2 w-28 cursor-pointer">
                                                        <option value="open">Open</option>
                                                        <option value="in_progress">In Progress</option>
                                                        <option value="resolved">Resolved</option>
                                                        <option value="closed">Closed</option>
                                                    </select>
                                                </div>
                                            </div>
                                        </motion.div>
                                    )}
                                </AnimatePresence>
                            </motion.div>
                        );
                    })
                )}
            </div>
        </motion.div>
    );
};

export default ComplaintsManagement;
