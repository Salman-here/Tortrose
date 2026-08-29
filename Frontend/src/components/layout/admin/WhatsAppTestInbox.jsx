import React, { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { motion } from 'framer-motion';
import {
    Activity, CheckCircle2, Clock, Copy, Inbox, Loader2, MessageCircle,
    Phone, Power, RefreshCw, Send, ShieldCheck, TestTube2, Users, XCircle,
} from 'lucide-react';
import { toast } from 'react-toastify';
import { getAuthToken } from '../../../utils/cookieHelper';

const API = import.meta.env.VITE_API_URL;
const authHeaders = () => ({ Authorization: `Bearer ${getAuthToken()}` });

const formatTime = value => {
    if (!value) return 'Never';
    try { return new Date(value).toLocaleString(); } catch { return 'Unknown'; }
};

const formatNumber = number => {
    const digits = String(number || '').replace(/\D/g, '');
    if (digits.length === 11 && digits.startsWith('1')) {
        return `+1 ${digits.slice(1, 4)}-${digits.slice(4, 7)}-${digits.slice(7)}`;
    }
    return digits ? `+${digits}` : '—';
};

const StatCard = ({ icon: Icon, label, value, note, color }) => (
    <div className="glass-panel-strong rounded-2xl p-4">
        <div className="flex items-center justify-between gap-3">
            <div>
                <div className="text-[10px] font-bold uppercase tracking-wider" style={{ color: 'hsl(var(--muted-foreground))' }}>{label}</div>
                <div className="text-2xl font-extrabold mt-1" style={{ color: 'hsl(var(--foreground))' }}>{value}</div>
            </div>
            <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: `${color}18`, color }}>
                <Icon size={19} />
            </div>
        </div>
        {note && <div className="text-[10px] mt-2" style={{ color: 'hsl(var(--muted-foreground))' }}>{note}</div>}
    </div>
);

const WhatsAppTestInbox = () => {
    const [numbers, setNumbers] = useState([]);
    const [targetCount, setTargetCount] = useState(50);
    const [messages, setMessages] = useState([]);
    const [totalMessages, setTotalMessages] = useState(0);
    const [numberFilter, setNumberFilter] = useState('');
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [provisioning, setProvisioning] = useState(false);
    const [actingMessageId, setActingMessageId] = useState('');
    const [inboundText, setInboundText] = useState('');
    const [sendingInbound, setSendingInbound] = useState(false);

    const fetchNumbers = useCallback(async () => {
        const { data } = await axios.get(`${API}api/whatsapp/test-inbox/numbers`, { headers: authHeaders() });
        setNumbers(data.data || []);
        setTargetCount(data.targetCount || 50);
    }, []);

    const fetchMessages = useCallback(async () => {
        const query = new URLSearchParams({ limit: '100' });
        if (numberFilter) query.set('number', numberFilter);
        const { data } = await axios.get(
            `${API}api/whatsapp/test-inbox/messages?${query.toString()}`,
            { headers: authHeaders() }
        );
        setMessages(data.data || []);
        setTotalMessages(data.total || 0);
    }, [numberFilter]);

    const refresh = useCallback(async ({ quiet = false } = {}) => {
        if (!quiet) setRefreshing(true);
        try {
            await Promise.all([fetchNumbers(), fetchMessages()]);
        } catch (error) {
            if (!quiet) toast.error(error.response?.data?.msg || 'Failed to load the WhatsApp test inbox.');
        } finally {
            setLoading(false);
            if (!quiet) setRefreshing(false);
        }
    }, [fetchMessages, fetchNumbers]);

    useEffect(() => { refresh(); }, [refresh]);
    useEffect(() => {
        const timer = setInterval(() => refresh({ quiet: true }), 5000);
        return () => clearInterval(timer);
    }, [refresh]);

    const provision = async () => {
        setProvisioning(true);
        try {
            const { data } = await axios.post(
                `${API}api/whatsapp/test-inbox/provision`,
                {},
                { headers: authHeaders() }
            );
            toast.success(data.msg || 'WhatsApp test pool provisioned.');
            await refresh({ quiet: true });
        } catch (error) {
            toast.error(error.response?.data?.msg || 'Failed to provision the WhatsApp test pool.');
        } finally {
            setProvisioning(false);
        }
    };

    const toggleNumber = async number => {
        try {
            await axios.patch(
                `${API}api/whatsapp/test-inbox/numbers/${number._id}`,
                { isActive: !number.isActive },
                { headers: authHeaders() }
            );
            await fetchNumbers();
        } catch (error) {
            toast.error(error.response?.data?.msg || 'Failed to update the test number.');
        }
    };

    const copyText = async value => {
        try {
            await navigator.clipboard.writeText(value);
            toast.success('Copied.');
        } catch {
            toast.error('Could not copy this value.');
        }
    };

    const applyAction = async (message, action) => {
        const approved = window.confirm(
            `Process “${action.label}” for ${formatNumber(message.number)} through the live WhatsApp decision path?`
        );
        if (!approved) return;
        setActingMessageId(message._id);
        try {
            const { data } = await axios.post(
                `${API}api/whatsapp/test-inbox/messages/${message._id}/action`,
                { actionId: action.id },
                { headers: authHeaders() }
            );
            toast.success(data.msg || 'WhatsApp action processed.');
            await refresh({ quiet: true });
        } catch (error) {
            toast.error(error.response?.data?.msg || 'WhatsApp action failed.');
        } finally {
            setActingMessageId('');
        }
    };

    const activeNumbers = numbers.filter(number => number.isActive).length;
    const assignedNumbers = numbers.filter(number => number.assignments?.length).length;
    const otpMessages = messages.filter(message => message.otp).length;
    const selectedNumber = useMemo(
        () => numbers.find(number => number.number === numberFilter),
        [numberFilter, numbers]
    );

    const sendInboundText = async event => {
        event.preventDefault();
        const text = inboundText.trim();
        if (!selectedNumber || !text || sendingInbound) return;
        setSendingInbound(true);
        try {
            const { data } = await axios.post(
                `${API}api/whatsapp/test-inbox/numbers/${selectedNumber._id}/inbound-text`,
                { text },
                { headers: authHeaders() }
            );
            setInboundText('');
            toast.success(data.msg || 'Inbound WhatsApp text processed.');
            await refresh({ quiet: true });
        } catch (error) {
            toast.error(error.response?.data?.msg || 'Inbound WhatsApp text failed.');
            await fetchMessages().catch(() => null);
        } finally {
            setSendingInbound(false);
        }
    };

    if (loading) {
        return <div className="min-h-[55vh] flex items-center justify-center"><Loader2 className="animate-spin" size={34} /></div>;
    }

    return (
        <div className="p-3 sm:p-5 lg:p-7 max-w-[1500px] mx-auto space-y-5">
            <div className="glass-panel-strong rounded-3xl p-5 sm:p-6">
                <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                    <div>
                        <div className="flex items-center gap-3">
                            <div className="w-11 h-11 rounded-2xl flex items-center justify-center" style={{ background: 'rgba(34,197,94,0.14)', color: 'hsl(150,70%,40%)' }}>
                                <TestTube2 size={22} />
                            </div>
                            <div>
                                <h1 className="text-xl sm:text-2xl font-extrabold" style={{ color: 'hsl(var(--foreground))' }}>WhatsApp Test Inbox</h1>
                                <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                    Admin-only virtual delivery for the fixed fictional +1 202-555-0100–0149 range.
                                </p>
                            </div>
                        </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        <button onClick={() => refresh()} disabled={refreshing}
                            className="px-4 py-2.5 rounded-xl glass-inner text-sm font-semibold inline-flex items-center gap-2 disabled:opacity-50">
                            <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} /> Refresh
                        </button>
                        <button onClick={provision} disabled={provisioning}
                            className="px-4 py-2.5 rounded-xl text-sm font-bold text-white inline-flex items-center gap-2 disabled:opacity-50"
                            style={{ background: 'linear-gradient(135deg, hsl(150,70%,40%), hsl(180,70%,38%))' }}>
                            {provisioning ? <Loader2 size={15} className="animate-spin" /> : <ShieldCheck size={15} />}
                            {numbers.length === targetCount ? 'Re-provision 50' : 'Provision 50 Numbers'}
                        </button>
                    </div>
                </div>
                <div className="mt-4 p-3 rounded-2xl text-xs leading-relaxed"
                    style={{ background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.2)', color: 'hsl(var(--foreground))' }}>
                    Only active numbers in this reserved pool are intercepted. All real WhatsApp numbers continue through Evolution API unchanged. OTPs and order buttons remain protected by normal backend verification, ownership, expiry, and decision guards.
                </div>
            </div>

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <StatCard icon={Phone} label="Pool" value={`${numbers.length}/${targetCount}`} note="Fixed fictional numbers" color="hsl(220,70%,55%)" />
                <StatCard icon={Activity} label="Active" value={activeNumbers} note="Eligible for virtual delivery" color="hsl(150,70%,40%)" />
                <StatCard icon={Users} label="Assigned" value={assignedNumbers} note="Linked buyer/seller identities" color="hsl(270,60%,55%)" />
                <StatCard icon={MessageCircle} label="Messages" value={totalMessages} note={`${otpMessages} OTP${otpMessages === 1 ? '' : 's'} on this page`} color="hsl(38,92%,48%)" />
            </div>

            <div className="grid xl:grid-cols-[360px_minmax(0,1fr)] gap-5">
                <div className="glass-panel-strong rounded-3xl p-4 h-fit xl:sticky xl:top-5">
                    <div className="flex items-center justify-between mb-3">
                        <h2 className="font-extrabold flex items-center gap-2" style={{ color: 'hsl(var(--foreground))' }}><Phone size={17} /> Test Numbers</h2>
                        <span className="text-[10px] font-bold px-2 py-1 rounded-full glass-inner">{numbers.length}</span>
                    </div>
                    <button onClick={() => setNumberFilter('')}
                        className="w-full text-left px-3 py-2.5 rounded-xl mb-2 text-xs font-semibold"
                        style={!numberFilter ? { background: 'rgba(59,130,246,0.12)', color: 'hsl(220,70%,50%)' } : { color: 'hsl(var(--foreground))' }}>
                        All numbers
                    </button>
                    <div className="space-y-2 max-h-[62vh] overflow-y-auto pr-1">
                        {numbers.map(number => (
                            <div key={number._id} className="rounded-2xl p-3 glass-inner"
                                style={numberFilter === number.number ? { border: '1px solid rgba(59,130,246,0.4)' } : undefined}>
                                <div className="flex items-start justify-between gap-2">
                                    <button onClick={() => setNumberFilter(number.number)} className="text-left min-w-0 flex-1">
                                        <div className="text-xs font-bold" style={{ color: 'hsl(var(--foreground))' }}>{formatNumber(number.number)}</div>
                                        <div className="text-[10px] mt-0.5" style={{ color: 'hsl(var(--muted-foreground))' }}>{number.label}</div>
                                    </button>
                                    <button onClick={() => toggleNumber(number)} title={number.isActive ? 'Deactivate' : 'Activate'}
                                        className="w-8 h-8 rounded-lg flex items-center justify-center"
                                        style={{ background: number.isActive ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.1)', color: number.isActive ? 'hsl(150,70%,40%)' : 'hsl(0,72%,55%)' }}>
                                        <Power size={13} />
                                    </button>
                                </div>
                                {number.assignments?.map(assignment => (
                                    <div key={`${number._id}-${assignment.userId}`} className="mt-2 text-[10px] rounded-lg p-2"
                                        style={{ background: 'rgba(99,102,241,0.08)', color: 'hsl(var(--foreground))' }}>
                                        <div className="font-bold">{assignment.username} · {assignment.role}</div>
                                        <div className="truncate" style={{ color: 'hsl(var(--muted-foreground))' }}>{assignment.email}</div>
                                    </div>
                                ))}
                                <div className="text-[9px] mt-2" style={{ color: 'hsl(var(--muted-foreground))' }}>Last used: {formatTime(number.lastUsedAt)}</div>
                            </div>
                        ))}
                    </div>
                </div>

                <div className="glass-panel-strong rounded-3xl p-4 sm:p-5 min-w-0">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
                        <div>
                            <h2 className="font-extrabold flex items-center gap-2" style={{ color: 'hsl(var(--foreground))' }}><Inbox size={18} /> Captured Messages</h2>
                            <p className="text-[10px] mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                {selectedNumber ? formatNumber(selectedNumber.number) : 'All active test numbers'} · newest first
                            </p>
                        </div>
                        {numberFilter && <button onClick={() => setNumberFilter('')} className="text-xs px-3 py-2 rounded-xl glass-inner">Clear filter</button>}
                    </div>

                    {selectedNumber && (
                        <form onSubmit={sendInboundText} className="mb-4 rounded-2xl p-4 glass-inner"
                            style={{ border: '1px solid rgba(34,197,94,0.24)' }}>
                            <div className="flex items-center justify-between gap-3 mb-2">
                                <div>
                                    <div className="text-xs font-extrabold" style={{ color: 'hsl(var(--foreground))' }}>
                                        Send inbound WhatsApp text
                                    </div>
                                    <div className="text-[10px] mt-0.5" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                        Runs through the authenticated production webhook and the same AI routing used by real WhatsApp messages.
                                    </div>
                                </div>
                                <MessageCircle size={18} style={{ color: 'hsl(150,70%,40%)' }} />
                            </div>
                            <textarea
                                value={inboundText}
                                onChange={event => setInboundText(event.target.value)}
                                maxLength={4000}
                                rows={3}
                                disabled={sendingInbound || !selectedNumber.isActive}
                                placeholder={selectedNumber.isActive ? 'Type a buyer or seller message to Rozare AI…' : 'Activate this test number first.'}
                                aria-label="Inbound WhatsApp text"
                                className="w-full rounded-xl px-3 py-2.5 text-xs resize-y outline-none disabled:opacity-50"
                                style={{ background: 'hsl(var(--background) / 0.7)', border: '1px solid hsl(var(--border))', color: 'hsl(var(--foreground))' }}
                            />
                            <div className="mt-2 flex items-center justify-between gap-3">
                                <span className="text-[9px]" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                    {inboundText.length}/4000 · {formatNumber(selectedNumber.number)}
                                </span>
                                <button type="submit" disabled={sendingInbound || !selectedNumber.isActive || !inboundText.trim()}
                                    className="px-4 py-2.5 rounded-xl text-xs font-bold text-white inline-flex items-center gap-2 disabled:opacity-50"
                                    style={{ background: 'hsl(150,70%,40%)' }}>
                                    {sendingInbound ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
                                    {sendingInbound ? 'Processing AI reply…' : 'Send through live AI'}
                                </button>
                            </div>
                        </form>
                    )}

                    {!messages.length ? (
                        <div className="py-16 text-center">
                            <Inbox size={38} className="mx-auto mb-3 opacity-40" />
                            <div className="font-bold" style={{ color: 'hsl(var(--foreground))' }}>No captured messages yet</div>
                            <div className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>Send an OTP or place an order using an active test number.</div>
                        </div>
                    ) : (
                        <div className="space-y-3">
                            {messages.map(message => (
                                <motion.div key={message._id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
                                    className="rounded-2xl p-4 glass-inner" style={{ border: '1px solid var(--glass-border)' }}>
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <span className="text-[10px] font-extrabold uppercase px-2 py-1 rounded-full"
                                                style={{ background: message.direction === 'outbound' ? 'rgba(59,130,246,0.12)' : 'rgba(34,197,94,0.12)', color: message.direction === 'outbound' ? 'hsl(220,70%,50%)' : 'hsl(150,70%,40%)' }}>
                                                {message.direction}
                                            </span>
                                            <span className="text-[10px] font-bold uppercase" style={{ color: 'hsl(var(--muted-foreground))' }}>{message.messageType}</span>
                                            <button onClick={() => setNumberFilter(message.number)} className="text-xs font-bold hover:underline" style={{ color: 'hsl(var(--foreground))' }}>{formatNumber(message.number)}</button>
                                        </div>
                                        <span className="text-[10px]" style={{ color: 'hsl(var(--muted-foreground))' }}>{formatTime(message.createdAt)}</span>
                                    </div>

                                    {message.otp && (
                                        <div className="mt-3 flex items-center justify-between gap-3 rounded-xl p-3"
                                            style={{ background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.24)' }}>
                                            <div>
                                                <div className="text-[10px] uppercase font-bold" style={{ color: 'hsl(38,92%,42%)' }}>Verification OTP</div>
                                                <div className="text-2xl font-black tracking-[0.28em] mt-1" style={{ color: 'hsl(var(--foreground))' }}>{message.otp}</div>
                                            </div>
                                            <button onClick={() => copyText(message.otp)} className="w-10 h-10 rounded-xl glass-inner flex items-center justify-center" title="Copy OTP"><Copy size={16} /></button>
                                        </div>
                                    )}

                                    {message.text && <pre className="mt-3 whitespace-pre-wrap break-words text-xs leading-relaxed font-sans" style={{ color: 'hsl(var(--foreground))' }}>{message.text}</pre>}

                                    {!!message.actions?.length && (
                                        <div className="mt-3 flex flex-wrap gap-2">
                                            {message.actions.map(action => {
                                                const isCancel = /cancel|decline|no/i.test(`${action.id} ${action.label}`);
                                                return (
                                                    <button key={action.id} onClick={() => applyAction(message, action)} disabled={actingMessageId === message._id}
                                                        className="px-4 py-2.5 rounded-xl text-xs font-bold text-white inline-flex items-center gap-2 disabled:opacity-50"
                                                        style={{ background: isCancel ? 'hsl(0,72%,55%)' : 'hsl(150,70%,40%)' }}>
                                                        {actingMessageId === message._id ? <Loader2 size={13} className="animate-spin" /> : isCancel ? <XCircle size={13} /> : <CheckCircle2 size={13} />}
                                                        {action.label}
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    )}

                                    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[9px]" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                        <span className="inline-flex items-center gap-1"><Clock size={10} /> {message.processingStatus}</span>
                                        <span>Instance: {message.instanceName || 'virtual'}</span>
                                        <span className="truncate max-w-full">ID: {message.messageId}</span>
                                    </div>
                                    {message.processingError && <div className="mt-2 text-[10px]" style={{ color: 'hsl(0,72%,55%)' }}>{message.processingError}</div>}
                                </motion.div>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default WhatsAppTestInbox;
