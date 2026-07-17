import React, { useState, useEffect, useCallback, useMemo } from 'react';
import axios from 'axios';
import { motion, AnimatePresence } from 'framer-motion';
import { getAuthToken } from '../../../utils/cookieHelper';
import {
    BrainCircuit, Sparkles, MessageSquareText, Wrench, BookOpenText, Plus,
    ChevronDown, ChevronRight, Save, RotateCcw, Trash2, Eye, History, X,
    CheckCircle2, AlertTriangle, Loader2, Globe, MessageCircle, User as UserIcon,
    Store, Shield, Power, Info,
} from 'lucide-react';

const API = import.meta.env.VITE_API_URL;
const authHeaders = () => ({ Authorization: `Bearer ${getAuthToken()}` });

const CATEGORY_ICONS = {
    'chat-personas': Sparkles,
    'chat-addendums': MessageSquareText,
    'product-assist': Wrench,
    knowledge: BookOpenText,
};

const ROLE_META = [
    { id: 'user', label: 'Buyers', icon: UserIcon },
    { id: 'seller', label: 'Sellers', icon: Store },
    { id: 'admin', label: 'Admins', icon: Shield },
];

const CHANNEL_META = [
    { id: 'web', label: 'Website', icon: Globe },
    { id: 'whatsapp', label: 'WhatsApp', icon: MessageCircle },
];

const cardStyle = {
    background: 'hsl(var(--card))',
    border: '1px solid hsl(var(--border))',
    borderRadius: '14px',
};

const chip = (text, color, bg, key) => (
    <span key={key} className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full"
        style={{ color, background: bg }}>
        {text}
    </span>
);

const formatTime = (d) => {
    if (!d) return '';
    try { return new Date(d).toLocaleString(); } catch { return ''; }
};

// ─── Single prompt card ───────────────────────────────────────────────
const PromptCard = ({ prompt, onSaved, onFeedback }) => {
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState(prompt.content);
    const [title, setTitle] = useState(prompt.title);
    const [appliesTo, setAppliesTo] = useState(prompt.appliesTo || []);
    const [channels, setChannels] = useState(prompt.channels || []);
    const [saving, setSaving] = useState(false);
    const [busy, setBusy] = useState('');
    const [showHistory, setShowHistory] = useState(false);

    useEffect(() => {
        setDraft(prompt.content);
        setTitle(prompt.title);
        setAppliesTo(prompt.appliesTo || []);
        setChannels(prompt.channels || []);
    }, [prompt]);

    const isCustom = prompt.type === 'custom';
    const dirty = draft !== prompt.content ||
        (isCustom && (title !== prompt.title ||
            JSON.stringify(appliesTo) !== JSON.stringify(prompt.appliesTo || []) ||
            JSON.stringify(channels) !== JSON.stringify(prompt.channels || [])));

    const save = async () => {
        if (!draft.trim()) { onFeedback('error', 'Prompt content cannot be empty.'); return; }
        if (isCustom && (!appliesTo.length || !channels.length)) {
            onFeedback('error', 'Select at least one audience and one channel.');
            return;
        }
        setSaving(true);
        try {
            const body = isCustom
                ? { content: draft, title, appliesTo, channels }
                : { content: draft };
            await axios.put(`${API}api/ai-prompts/${encodeURIComponent(prompt.key)}`, body, { headers: authHeaders() });
            onFeedback('success', `"${prompt.title || title}" saved. The AI uses it within ~30 seconds.`);
            onSaved();
        } catch (err) {
            onFeedback('error', err.response?.data?.msg || 'Failed to save prompt.');
        } finally {
            setSaving(false);
        }
    };

    const resetToDefault = async () => {
        if (!window.confirm(`Reset "${prompt.title}" to the original default? Your customized version will be removed (it stays in history until then, so copy it first if you need it).`)) return;
        setBusy('reset');
        try {
            await axios.post(`${API}api/ai-prompts/${encodeURIComponent(prompt.key)}/reset`, {}, { headers: authHeaders() });
            onFeedback('success', `"${prompt.title}" reset to default.`);
            onSaved();
        } catch (err) {
            onFeedback('error', err.response?.data?.msg || 'Failed to reset prompt.');
        } finally {
            setBusy('');
        }
    };

    const toggleActive = async () => {
        setBusy('toggle');
        try {
            await axios.put(`${API}api/ai-prompts/${encodeURIComponent(prompt.key)}`,
                { isActive: !prompt.isActive }, { headers: authHeaders() });
            onFeedback('success', `"${prompt.title}" ${prompt.isActive ? 'disabled' : 'enabled'}.`);
            onSaved();
        } catch (err) {
            onFeedback('error', err.response?.data?.msg || 'Failed to toggle prompt.');
        } finally {
            setBusy('');
        }
    };

    const remove = async () => {
        if (!window.confirm(`Delete "${prompt.title}" permanently? The AI will no longer know about this.`)) return;
        setBusy('delete');
        try {
            await axios.delete(`${API}api/ai-prompts/${encodeURIComponent(prompt.key)}`, { headers: authHeaders() });
            onFeedback('success', `"${prompt.title}" deleted.`);
            onSaved();
        } catch (err) {
            onFeedback('error', err.response?.data?.msg || 'Failed to delete prompt.');
        } finally {
            setBusy('');
        }
    };

    const toggleIn = (_list, setList, id) => {
        setList(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]));
    };

    return (
        <div style={cardStyle} className="overflow-hidden">
            {/* Header row */}
            <button type="button" onClick={() => setOpen(o => !o)}
                className="w-full flex items-start gap-3 p-4 text-left hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
                <span className="mt-0.5" style={{ color: 'hsl(var(--muted-foreground))' }}>
                    {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                </span>
                <span className="flex-1 min-w-0">
                    <span className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-sm" style={{ color: 'hsl(var(--foreground))' }}>
                            {prompt.title || 'Untitled prompt'}
                        </span>
                        {prompt.type === 'builtin'
                            ? prompt.isOverridden
                                ? chip('Customized', 'hsl(38,92%,40%)', 'rgba(245,158,11,0.14)')
                                : chip('Default', 'hsl(220,15%,50%)', 'rgba(120,130,150,0.12)')
                            : prompt.isActive
                                ? chip('Active', 'hsl(150,70%,35%)', 'rgba(34,197,94,0.12)')
                                : chip('Disabled', 'hsl(0,60%,50%)', 'rgba(239,68,68,0.12)')}
                        {isCustom && (prompt.appliesTo || []).map(r => {
                            const meta = ROLE_META.find(m => m.id === r);
                            return meta ? chip(meta.label, 'hsl(220,70%,50%)', 'rgba(99,102,241,0.10)', `role-${r}`) : null;
                        })}
                        {isCustom && (prompt.channels || []).map(c => {
                            const meta = CHANNEL_META.find(m => m.id === c);
                            return meta ? chip(meta.label, 'hsl(280,60%,50%)', 'rgba(168,85,247,0.10)', `channel-${c}`) : null;
                        })}
                    </span>
                    <span className="block text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                        {prompt.description}
                    </span>
                    <span className="block text-[11px] mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                        {prompt.content.length.toLocaleString()} characters
                        {prompt.usedIn ? ` · Used in: ${prompt.usedIn}` : ''}
                        {prompt.updatedAt ? ` · Edited ${formatTime(prompt.updatedAt)}${prompt.updatedByName ? ` by ${prompt.updatedByName}` : ''}` : ''}
                    </span>
                </span>
            </button>

            {/* Editor */}
            <AnimatePresence>
                {open && (
                    <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.18 }} className="overflow-hidden">
                        <div className="px-4 pb-4 space-y-3" style={{ borderTop: '1px solid hsl(var(--border))' }}>
                            {isCustom && (
                                <div className="pt-3 grid gap-3 sm:grid-cols-2">
                                    <div>
                                        <label className="block text-xs font-semibold mb-1" style={{ color: 'hsl(var(--muted-foreground))' }}>Title</label>
                                        <input value={title} onChange={e => setTitle(e.target.value)} maxLength={200}
                                            className="w-full px-3 py-2 rounded-lg text-sm outline-none"
                                            style={{ background: 'hsl(var(--background))', border: '1px solid hsl(var(--border))', color: 'hsl(var(--foreground))' }} />
                                    </div>
                                    <div className="flex flex-wrap items-end gap-4">
                                        <div>
                                            <span className="block text-xs font-semibold mb-1" style={{ color: 'hsl(var(--muted-foreground))' }}>Who should know this</span>
                                            <div className="flex gap-2">
                                                {ROLE_META.map(({ id, label }) => (
                                                    <button key={id} type="button" onClick={() => toggleIn(appliesTo, setAppliesTo, id)}
                                                        className="px-2.5 py-1 rounded-lg text-xs font-medium transition-colors"
                                                        style={appliesTo.includes(id)
                                                            ? { background: 'hsl(220,70%,55%)', color: 'white' }
                                                            : { background: 'hsl(var(--background))', border: '1px solid hsl(var(--border))', color: 'hsl(var(--muted-foreground))' }}>
                                                        {label}
                                                    </button>
                                                ))}
                                            </div>
                                        </div>
                                        <div>
                                            <span className="block text-xs font-semibold mb-1" style={{ color: 'hsl(var(--muted-foreground))' }}>Channels</span>
                                            <div className="flex gap-2">
                                                {CHANNEL_META.map(({ id, label }) => (
                                                    <button key={id} type="button" onClick={() => toggleIn(channels, setChannels, id)}
                                                        className="px-2.5 py-1 rounded-lg text-xs font-medium transition-colors"
                                                        style={channels.includes(id)
                                                            ? { background: 'hsl(280,60%,50%)', color: 'white' }
                                                            : { background: 'hsl(var(--background))', border: '1px solid hsl(var(--border))', color: 'hsl(var(--muted-foreground))' }}>
                                                        {label}
                                                    </button>
                                                ))}
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            )}

                            <div className={isCustom ? '' : 'pt-3'}>
                                <textarea value={draft} onChange={e => setDraft(e.target.value)} rows={Math.min(24, Math.max(8, draft.split('\n').length + 1))}
                                    spellCheck={false}
                                    className="w-full px-3 py-2.5 rounded-lg text-[13px] leading-relaxed font-mono outline-none resize-y"
                                    style={{ background: 'hsl(var(--background))', border: '1px solid hsl(var(--border))', color: 'hsl(var(--foreground))', minHeight: 160 }} />
                                <div className="text-[11px] mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                    {draft.length.toLocaleString()} characters{dirty ? ' · unsaved changes' : ''}
                                </div>
                            </div>

                            {/* Actions */}
                            <div className="flex flex-wrap items-center gap-2">
                                <button type="button" onClick={save} disabled={saving || !dirty}
                                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold text-white transition-opacity disabled:opacity-45"
                                    style={{ background: 'hsl(220,70%,52%)' }}>
                                    {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />} Save changes
                                </button>
                                {dirty && (
                                    <button type="button" onClick={() => { setDraft(prompt.content); setTitle(prompt.title); setAppliesTo(prompt.appliesTo || []); setChannels(prompt.channels || []); }}
                                        className="px-3 py-2 rounded-lg text-xs font-medium"
                                        style={{ border: '1px solid hsl(var(--border))', color: 'hsl(var(--muted-foreground))' }}>
                                        Discard edits
                                    </button>
                                )}
                                {prompt.type === 'builtin' && prompt.isOverridden && (
                                    <button type="button" onClick={resetToDefault} disabled={busy === 'reset'}
                                        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium"
                                        style={{ border: '1px solid rgba(245,158,11,0.4)', color: 'hsl(38,92%,40%)' }}>
                                        {busy === 'reset' ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />} Reset to default
                                    </button>
                                )}
                                {isCustom && (
                                    <>
                                        <button type="button" onClick={toggleActive} disabled={busy === 'toggle'}
                                            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium"
                                            style={{ border: '1px solid hsl(var(--border))', color: prompt.isActive ? 'hsl(0,60%,50%)' : 'hsl(150,70%,35%)' }}>
                                            {busy === 'toggle' ? <Loader2 size={13} className="animate-spin" /> : <Power size={13} />}
                                            {prompt.isActive ? 'Disable' : 'Enable'}
                                        </button>
                                        <button type="button" onClick={remove} disabled={busy === 'delete'}
                                            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium"
                                            style={{ border: '1px solid rgba(239,68,68,0.35)', color: 'hsl(0,72%,50%)' }}>
                                            {busy === 'delete' ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />} Delete
                                        </button>
                                    </>
                                )}
                                {(prompt.history || []).length > 0 && (
                                    <button type="button" onClick={() => setShowHistory(h => !h)}
                                        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium ml-auto"
                                        style={{ border: '1px solid hsl(var(--border))', color: 'hsl(var(--muted-foreground))' }}>
                                        <History size={13} /> History ({prompt.history.length})
                                    </button>
                                )}
                            </div>

                            {/* History */}
                            <AnimatePresence>
                                {showHistory && (
                                    <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }}
                                        exit={{ height: 0, opacity: 0 }} className="overflow-hidden space-y-2">
                                        {(prompt.history || []).map((h, i) => (
                                            <div key={i} className="p-3 rounded-lg"
                                                style={{ background: 'hsl(var(--background))', border: '1px solid hsl(var(--border))' }}>
                                                <div className="flex items-center justify-between gap-2 mb-1.5">
                                                    <span className="text-[11px] font-semibold" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                                        Version {h.version} · {formatTime(h.updatedAt)}{h.updatedByName ? ` · ${h.updatedByName}` : ''}
                                                    </span>
                                                    <button type="button" onClick={() => { setDraft(h.content); setShowHistory(false); }}
                                                        className="text-[11px] font-semibold px-2 py-1 rounded"
                                                        style={{ color: 'hsl(220,70%,50%)', background: 'rgba(99,102,241,0.10)' }}>
                                                        Load into editor
                                                    </button>
                                                </div>
                                                <pre className="text-[11px] whitespace-pre-wrap max-h-32 overflow-y-auto font-mono"
                                                    style={{ color: 'hsl(var(--muted-foreground))' }}>{h.content}</pre>
                                            </div>
                                        ))}
                                    </motion.div>
                                )}
                            </AnimatePresence>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};

// ─── Add knowledge form ───────────────────────────────────────────────
const AddKnowledgeForm = ({ onClose, onCreated, onFeedback }) => {
    const [title, setTitle] = useState('');
    const [content, setContent] = useState('');
    const [appliesTo, setAppliesTo] = useState(['user', 'seller', 'admin']);
    const [channels, setChannels] = useState(['web', 'whatsapp']);
    const [saving, setSaving] = useState(false);

    const toggleIn = (_list, setList, id) => {
        setList(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]));
    };

    const submit = async () => {
        if (!title.trim() || !content.trim()) { onFeedback('error', 'Title and content are required.'); return; }
        if (!appliesTo.length || !channels.length) { onFeedback('error', 'Select at least one audience and one channel.'); return; }
        setSaving(true);
        try {
            await axios.post(`${API}api/ai-prompts`, { title, content, appliesTo, channels }, { headers: authHeaders() });
            onFeedback('success', `"${title}" added. The AI knows about it within ~30 seconds.`);
            onCreated();
            onClose();
        } catch (err) {
            onFeedback('error', err.response?.data?.msg || 'Failed to add knowledge.');
        } finally {
            setSaving(false);
        }
    };

    return (
        <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
            style={cardStyle} className="p-4 space-y-3">
            <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold inline-flex items-center gap-2" style={{ color: 'hsl(var(--foreground))' }}>
                    <BookOpenText size={16} /> Add platform knowledge
                </h3>
                <button type="button" onClick={onClose} style={{ color: 'hsl(var(--muted-foreground))' }}><X size={16} /></button>
            </div>
            <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>
                Launched a new feature or changed a policy? Describe it here and the AI will know about it
                when buyers, sellers, or admins ask — no code change needed.
            </p>
            <input value={title} onChange={e => setTitle(e.target.value)} maxLength={200}
                placeholder='Title — e.g. "Gift cards launched" or "New return policy"'
                className="w-full px-3 py-2 rounded-lg text-sm outline-none"
                style={{ background: 'hsl(var(--background))', border: '1px solid hsl(var(--border))', color: 'hsl(var(--foreground))' }} />
            <textarea value={content} onChange={e => setContent(e.target.value)} rows={6} spellCheck={false}
                placeholder={'What should the AI know? Write it as instructions/facts, e.g.:\n"Rozare now supports gift cards. Buyers can buy them at rozare.com/gift-cards in amounts of Rs 500–10,000. They are delivered by email and never expire."'}
                className="w-full px-3 py-2.5 rounded-lg text-[13px] font-mono outline-none resize-y"
                style={{ background: 'hsl(var(--background))', border: '1px solid hsl(var(--border))', color: 'hsl(var(--foreground))' }} />
            <div className="flex flex-wrap gap-6">
                <div>
                    <span className="block text-xs font-semibold mb-1.5" style={{ color: 'hsl(var(--muted-foreground))' }}>Who should know this</span>
                    <div className="flex gap-2">
                        {ROLE_META.map(({ id, label, icon: Icon }) => (
                            <button key={id} type="button" onClick={() => toggleIn(appliesTo, setAppliesTo, id)}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
                                style={appliesTo.includes(id)
                                    ? { background: 'hsl(220,70%,55%)', color: 'white' }
                                    : { background: 'hsl(var(--background))', border: '1px solid hsl(var(--border))', color: 'hsl(var(--muted-foreground))' }}>
                                <Icon size={13} /> {label}
                            </button>
                        ))}
                    </div>
                </div>
                <div>
                    <span className="block text-xs font-semibold mb-1.5" style={{ color: 'hsl(var(--muted-foreground))' }}>Channels</span>
                    <div className="flex gap-2">
                        {CHANNEL_META.map(({ id, label, icon: Icon }) => (
                            <button key={id} type="button" onClick={() => toggleIn(channels, setChannels, id)}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
                                style={channels.includes(id)
                                    ? { background: 'hsl(280,60%,50%)', color: 'white' }
                                    : { background: 'hsl(var(--background))', border: '1px solid hsl(var(--border))', color: 'hsl(var(--muted-foreground))' }}>
                                <Icon size={13} /> {label}
                            </button>
                        ))}
                    </div>
                </div>
            </div>
            <button type="button" onClick={submit} disabled={saving}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold text-white disabled:opacity-45"
                style={{ background: 'hsl(150,70%,38%)' }}>
                {saving ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} Add knowledge
            </button>
        </motion.div>
    );
};

// ─── Preview modal ────────────────────────────────────────────────────
const PreviewModal = ({ onClose }) => {
    const [role, setRole] = useState('user');
    const [channel, setChannel] = useState('web');
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            setLoading(true);
            try {
                const { data: resp } = await axios.get(
                    `${API}api/ai-prompts/preview/${role}`,
                    { headers: authHeaders(), params: { channel } }
                );
                if (!cancelled) setData(resp);
            } catch {
                if (!cancelled) setData(null);
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [role, channel]);

    return (
        <div className="fixed inset-0 z-[80] flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.55)' }} onClick={onClose}>
            <motion.div initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }}
                onClick={e => e.stopPropagation()}
                className="w-full max-w-3xl max-h-[85vh] flex flex-col rounded-2xl overflow-hidden"
                style={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))' }}>
                <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: '1px solid hsl(var(--border))' }}>
                    <h3 className="text-sm font-bold inline-flex items-center gap-2" style={{ color: 'hsl(var(--foreground))' }}>
                        <Eye size={16} /> Final prompt preview — exactly what the AI receives
                    </h3>
                    <button type="button" onClick={onClose} style={{ color: 'hsl(var(--muted-foreground))' }}><X size={18} /></button>
                </div>
                <div className="flex flex-wrap gap-2 px-5 py-3" style={{ borderBottom: '1px solid hsl(var(--border))' }}>
                    {ROLE_META.map(({ id, label }) => (
                        <button key={id} type="button" onClick={() => setRole(id)}
                            className="px-3 py-1.5 rounded-lg text-xs font-semibold"
                            style={role === id ? { background: 'hsl(220,70%,55%)', color: 'white' } : { border: '1px solid hsl(var(--border))', color: 'hsl(var(--muted-foreground))' }}>
                            {label}
                        </button>
                    ))}
                    <span className="w-px h-6 mx-1" style={{ background: 'hsl(var(--border))' }} />
                    {CHANNEL_META.map(({ id, label }) => (
                        <button key={id} type="button" onClick={() => setChannel(id)}
                            className="px-3 py-1.5 rounded-lg text-xs font-semibold"
                            style={channel === id ? { background: 'hsl(280,60%,50%)', color: 'white' } : { border: '1px solid hsl(var(--border))', color: 'hsl(var(--muted-foreground))' }}>
                            {label}
                        </button>
                    ))}
                    {data && !loading && (
                        <span className="ml-auto text-[11px] self-center" style={{ color: 'hsl(var(--muted-foreground))' }}>
                            {data.characters.toLocaleString()} characters
                        </span>
                    )}
                </div>
                <div className="flex-1 overflow-y-auto p-5">
                    {loading ? (
                        <div className="flex items-center gap-2 text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>
                            <Loader2 size={15} className="animate-spin" /> Assembling…
                        </div>
                    ) : data ? (
                        <>
                            <p className="text-[11px] mb-3 inline-flex items-start gap-1.5" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                <Info size={13} className="shrink-0 mt-0.5" /> {data.note}
                            </p>
                            <pre className="text-[12px] whitespace-pre-wrap font-mono leading-relaxed" style={{ color: 'hsl(var(--foreground))' }}>
                                {data.content}
                            </pre>
                        </>
                    ) : (
                        <p className="text-sm" style={{ color: 'hsl(0,60%,50%)' }}>Failed to load preview.</p>
                    )}
                </div>
            </motion.div>
        </div>
    );
};

// ─── Main panel ───────────────────────────────────────────────────────
const AdminAIPromptsPanel = () => {
    const [categories, setCategories] = useState([]);
    const [prompts, setPrompts] = useState([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState('');
    const [showAdd, setShowAdd] = useState(false);
    const [showPreview, setShowPreview] = useState(false);
    const [feedback, setFeedback] = useState(null);

    const fetchPrompts = useCallback(async () => {
        try {
            const { data } = await axios.get(`${API}api/ai-prompts`, { headers: authHeaders() });
            setCategories(data.categories || []);
            setPrompts(data.prompts || []);
            setLoadError('');
        } catch (err) {
            setLoadError(err.response?.data?.msg || 'Failed to load AI prompts.');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { fetchPrompts(); }, [fetchPrompts]);

    const onFeedback = useCallback((type, msg) => {
        setFeedback({ type, msg });
        setTimeout(() => setFeedback(null), 4500);
    }, []);

    const grouped = useMemo(() => {
        const map = new Map();
        for (const c of categories) map.set(c.id, { ...c, prompts: [] });
        for (const p of prompts) {
            if (!map.has(p.category)) map.set(p.category, { id: p.category, title: p.category, description: '', prompts: [] });
            map.get(p.category).prompts.push(p);
        }
        return [...map.values()];
    }, [categories, prompts]);

    const customizedCount = prompts.filter(p => p.isOverridden).length;
    const knowledgeCount = prompts.filter(p => p.type === 'custom').length;

    return (
        <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-6">
            {/* Header */}
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h1 className="text-xl font-bold inline-flex items-center gap-2" style={{ color: 'hsl(var(--foreground))' }}>
                        <BrainCircuit size={22} style={{ color: 'hsl(220,70%,55%)' }} /> AI Prompts
                    </h1>
                    <p className="text-xs mt-1 max-w-2xl" style={{ color: 'hsl(var(--muted-foreground))' }}>
                        Everything the platform AI is told, in one place. Edit how it talks to buyers, sellers, and admins,
                        and add knowledge about new features — changes go live in ~30 seconds, no deploy needed.
                    </p>
                    {!loading && !loadError && (
                        <p className="text-[11px] mt-1.5" style={{ color: 'hsl(var(--muted-foreground))' }}>
                            {prompts.length} prompts · {customizedCount} customized · {knowledgeCount} knowledge entries
                        </p>
                    )}
                </div>
                <div className="flex gap-2">
                    <button type="button" onClick={() => setShowPreview(true)}
                        className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold"
                        style={{ border: '1px solid hsl(var(--border))', color: 'hsl(var(--foreground))' }}>
                        <Eye size={14} /> Preview final prompt
                    </button>
                    <button type="button" onClick={() => setShowAdd(s => !s)}
                        className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold text-white"
                        style={{ background: 'hsl(150,70%,38%)' }}>
                        <Plus size={14} /> Add knowledge
                    </button>
                </div>
            </div>

            {/* Feedback banner */}
            <AnimatePresence>
                {feedback && (
                    <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                        className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-medium"
                        style={feedback.type === 'success'
                            ? { background: 'rgba(34,197,94,0.12)', color: 'hsl(150,70%,32%)' }
                            : { background: 'rgba(239,68,68,0.12)', color: 'hsl(0,72%,45%)' }}>
                        {feedback.type === 'success' ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
                        {feedback.msg}
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Add knowledge form */}
            <AnimatePresence>
                {showAdd && (
                    <AddKnowledgeForm onClose={() => setShowAdd(false)} onCreated={fetchPrompts} onFeedback={onFeedback} />
                )}
            </AnimatePresence>

            {/* Content */}
            {loading ? (
                <div className="flex items-center gap-2 text-sm py-10 justify-center" style={{ color: 'hsl(var(--muted-foreground))' }}>
                    <Loader2 size={16} className="animate-spin" /> Loading prompts…
                </div>
            ) : loadError ? (
                <div className="flex items-center gap-2 px-4 py-3 rounded-xl text-sm"
                    style={{ background: 'rgba(239,68,68,0.10)', color: 'hsl(0,72%,45%)' }}>
                    <AlertTriangle size={15} /> {loadError}
                </div>
            ) : (
                grouped.map(section => {
                    const Icon = CATEGORY_ICONS[section.id] || Sparkles;
                    return (
                        <section key={section.id} className="space-y-3">
                            <div>
                                <h2 className="text-sm font-bold inline-flex items-center gap-2" style={{ color: 'hsl(var(--foreground))' }}>
                                    <Icon size={16} style={{ color: 'hsl(220,70%,55%)' }} /> {section.title}
                                </h2>
                                {section.description && (
                                    <p className="text-[11px] mt-0.5" style={{ color: 'hsl(var(--muted-foreground))' }}>{section.description}</p>
                                )}
                            </div>
                            {section.prompts.length === 0 ? (
                                <div className="px-4 py-6 text-center rounded-xl text-xs" style={{ ...cardStyle, color: 'hsl(var(--muted-foreground))' }}>
                                    {section.id === 'knowledge'
                                        ? 'No knowledge entries yet. Use "Add knowledge" to teach the AI about new features, policies, or FAQs.'
                                        : 'No prompts in this category.'}
                                </div>
                            ) : (
                                <div className="space-y-2.5">
                                    {section.prompts.map(p => (
                                        <PromptCard key={p.key} prompt={p} onSaved={fetchPrompts} onFeedback={onFeedback} />
                                    ))}
                                </div>
                            )}
                        </section>
                    );
                })
            )}

            {showPreview && <PreviewModal onClose={() => setShowPreview(false)} />}
        </div>
    );
};

export default AdminAIPromptsPanel;
