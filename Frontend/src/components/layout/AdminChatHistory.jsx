import React, { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import axios from 'axios';
import { AlertCircle, Bot, ChevronLeft, ChevronRight, ExternalLink, Loader2, LockKeyhole, MessageSquare, RefreshCw, Search, User } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { getAuthToken } from '../../utils/cookieHelper';
import { chatKey, chatSourceLabels, inspectAdminChatList, inspectAdminChatTranscript, safeChatAttachment } from '../../utils/adminChatHistory';

const formatTime = value => value && Number.isFinite(new Date(value).getTime())
  ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Time not recorded';
const sourceStyle = source => ({ whatsapp: 'bg-emerald-500/10 text-emerald-600', mobile: 'bg-violet-500/10 text-violet-500',
  web: 'bg-sky-500/10 text-sky-600', unknown: 'bg-slate-500/10 text-muted-foreground' }[source]);
const Source = ({ source }) => <span className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold ${sourceStyle(source)}`}>{chatSourceLabels[source]}</span>;
const emptyPage = { page: 1, total: 0, totalPages: 0, hasMore: false };

export default function AdminChatHistory() {
  const { currentUser } = useAuth();
  const [params] = useSearchParams();
  const userId = params.get('userId') || '';
  const identity = currentUser?.role === 'admin' ? String(currentUser._id || currentUser.id || '') : '';
  const [search, setSearch] = useState(''), [query, setQuery] = useState(''), [source, setSource] = useState('all'), [role, setRole] = useState('all');
  const [page, setPage] = useState(1), [refresh, setRefresh] = useState(0), [list, setList] = useState([]), [pagination, setPagination] = useState(emptyPage);
  const [listBusy, setListBusy] = useState(false), [listError, setListError] = useState(''), [listContext, setListContext] = useState('');
  const [selected, setSelected] = useState(null), [transcript, setTranscript] = useState(null), [transcriptBusy, setTranscriptBusy] = useState(false);
  const [transcriptError, setTranscriptError] = useState(''), [olderBusy, setOlderBusy] = useState(false), [subject, setSubject] = useState(null);
  const generation = useRef(0), olderAbort = useRef(null);
  const context = JSON.stringify([identity, userId, query, source, role, page, refresh]);
  const selectedKey = chatKey(selected);
  useEffect(() => { const timer = setTimeout(() => { setQuery(search.trim()); setPage(1); }, 300); return () => clearTimeout(timer); }, [search]);

  useEffect(() => {
    const controller = new AbortController();
    if (!identity) { setList([]); setSelected(null); setTranscript(null); return () => controller.abort(); }
    setListBusy(true); setListError(''); setSelected(null); setTranscript(null);
    const filters = new URLSearchParams({ page: String(page), limit: '20', source, role });
    if (query) filters.set('search', query); if (userId) filters.set('userId', userId);
    axios.get(`${import.meta.env.VITE_API_URL}api/ai-chat/admin/conversations?${filters}`, {
      headers: { Authorization: `Bearer ${getAuthToken()}` }, signal: controller.signal,
    }).then(response => {
      if (controller.signal.aborted) return;
      const data = inspectAdminChatList(response.data); setList(data.conversations); setPagination(data.pagination);
      setSubject(data.subject); setListContext(context); setSelected(data.conversations[0] || null);
    }).catch(error => { if (!controller.signal.aborted) { setList([]); setPagination(emptyPage); setListError(error.response?.data?.msg || error.message || 'Unable to load saved conversations.'); } })
      .finally(() => { if (!controller.signal.aborted) setListBusy(false); });
    return () => controller.abort();
  }, [identity, userId, query, source, role, page, refresh, context]);

  useEffect(() => {
    const controller = new AbortController(); const requestGeneration = ++generation.current;
    olderAbort.current?.abort(); setTranscript(null); setTranscriptError(''); setOlderBusy(false);
    if (!identity || !selectedKey) { setTranscriptBusy(false); return () => controller.abort(); }
    setTranscriptBusy(true);
    axios.get(`${import.meta.env.VITE_API_URL}api/ai-chat/admin/users/${selected.user.id}/conversations/${selected.id}`, {
      headers: { Authorization: `Bearer ${getAuthToken()}` }, signal: controller.signal,
    }).then(response => { if (!controller.signal.aborted && generation.current === requestGeneration) setTranscript(inspectAdminChatTranscript(response.data, selectedKey)); })
      .catch(error => { if (!controller.signal.aborted) setTranscriptError(error.response?.data?.msg || error.message || 'Unable to load this transcript.'); })
      .finally(() => { if (!controller.signal.aborted) setTranscriptBusy(false); });
    return () => { controller.abort(); olderAbort.current?.abort(); };
  }, [identity, selectedKey, selected, refresh]);

  const loadEarlier = async () => {
    if (!transcript?.pagination.hasOlder || olderBusy) return;
    const controller = new AbortController(); olderAbort.current = controller;
    const requestGeneration = generation.current; setOlderBusy(true); setTranscriptError('');
    try {
      const response = await axios.get(`${import.meta.env.VITE_API_URL}api/ai-chat/admin/users/${selected.user.id}/conversations/${selected.id}?page=${transcript.pagination.page + 1}`, {
        headers: { Authorization: `Bearer ${getAuthToken()}` }, signal: controller.signal,
      });
      const data = inspectAdminChatTranscript(response.data, selectedKey);
      if (!controller.signal.aborted && generation.current === requestGeneration) setTranscript(previous => ({ ...data,
        messages: [...new Map([...data.messages, ...previous.messages].map(message => [message.id, message])).values()] }));
    } catch (error) { if (!controller.signal.aborted) setTranscriptError(error.response?.data?.msg || error.message || 'Unable to load earlier messages.'); }
    finally { if (!controller.signal.aborted) setOlderBusy(false); }
  };

  if (!identity) return <p className="p-6 text-muted-foreground">Administrator access is required to review conversations.</p>;
  const rows = listContext === context ? list : [];
  const visibleTranscript = transcript && chatKey(transcript.conversation) === selectedKey ? transcript : null;
  return <section className="space-y-5 p-4 sm:p-6 lg:p-8">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div><div className="mb-2 flex items-center gap-2 text-primary"><MessageSquare size={22} /><span className="text-xs font-semibold uppercase tracking-widest">Administration</span></div>
        <h1 className="text-2xl font-bold sm:text-3xl">Chat History</h1><p className="mt-2 max-w-2xl text-sm text-muted-foreground">Review saved AI conversations from the website, mobile app and Rozare WhatsApp. Web and mobile chats can sync across devices.</p></div>
      <div className="flex items-center gap-3"><span className="flex items-center gap-1.5 rounded-full border border-primary/15 bg-primary/5 px-3 py-2 text-xs font-medium text-primary"><LockKeyhole size={13} /> Read-only · access logged</span>
        <button type="button" aria-label="Refresh chat history" onClick={() => setRefresh(value => value + 1)} className="rounded-xl border border-white/30 p-2.5 transition-colors hover:bg-primary/10"><RefreshCw size={17} /></button></div>
    </header>
    {userId && <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground"><span>Account: {subject?.name || 'Selected account'}{subject?.email ? ` · ${subject.email}` : ''}</span><Link to="/admin-dashboard/chats" className="font-medium text-primary">View all accounts</Link></div>}
    <div className="glass-panel flex flex-wrap gap-3 p-3 sm:p-4">
      <label className="flex min-w-[220px] flex-1 items-center gap-2 rounded-xl border border-white/30 bg-white/10 px-3"><Search size={17} className="text-muted-foreground" /><input aria-label="Search accounts or conversations" value={search} maxLength={100} onChange={event => setSearch(event.target.value)} placeholder="Search name, email or chat title" className="min-w-0 flex-1 bg-transparent py-3 text-sm outline-none" /></label>
      <select aria-label="Chat source" value={source} onChange={event => { setSource(event.target.value); setPage(1); }} className="rounded-xl border border-white/30 bg-transparent px-3 py-2.5 text-sm"><option value="all">All sources</option>{Object.entries(chatSourceLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      <select aria-label="Account role" value={role} onChange={event => { setRole(event.target.value); setPage(1); }} className="rounded-xl border border-white/30 bg-transparent px-3 py-2.5 text-sm"><option value="all">All account roles</option><option value="user">Buyers</option><option value="seller">Sellers</option><option value="admin">Admins</option></select>
    </div>
    {listError && <p role="alert" className="flex items-center gap-2 rounded-xl bg-red-500/10 p-4 text-sm text-red-500"><AlertCircle size={16} />{listError}</p>}
    <div className="grid items-start gap-5 xl:grid-cols-[340px_minmax(0,1fr)]">
      <aside className="glass-panel overflow-hidden"><div className="border-b border-white/20 px-4 py-3 text-xs font-medium text-muted-foreground">{pagination.total} retained conversation{pagination.total === 1 ? '' : 's'}</div>
        <div className="max-h-[65vh] overflow-y-auto p-2">{listBusy ? <div role="status" className="flex items-center justify-center gap-2 p-12 text-sm text-muted-foreground"><Loader2 className="animate-spin" size={18} />Loading chats</div>
          : rows.length ? rows.map(row => <button type="button" key={chatKey(row)} onClick={() => setSelected(row)} aria-pressed={selectedKey === chatKey(row)} className={`mb-1 w-full rounded-2xl border p-3.5 text-left transition-colors ${selectedKey === chatKey(row) ? 'border-primary/30 bg-primary/10' : 'border-transparent hover:bg-white/20'}`}>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><span className="text-sm font-semibold">{row.user.name}</span><Source source={row.source} /></div>
            <p className="truncate text-xs text-muted-foreground">{row.user.email} · {row.user.role === 'user' ? 'Buyer' : row.user.role}</p><p className="mt-2 line-clamp-2 text-sm font-medium">{row.legacy ? 'Older saved chat' : row.title}</p>
            <p className="mt-2 text-[11px] text-muted-foreground">{row.messageCount} messages · {formatTime(row.lastActive)}</p></button>)
            : <div className="p-10 text-center text-sm text-muted-foreground"><MessageSquare className="mx-auto mb-3 opacity-50" size={28} />No saved conversations match these filters.</div>}</div>
        <div className="flex items-center justify-between border-t border-white/20 p-3"><button type="button" aria-label="Previous conversation page" disabled={page <= 1 || listBusy} onClick={() => setPage(value => value - 1)} className="rounded-lg p-2 disabled:opacity-30"><ChevronLeft size={17} /></button><span className="text-xs text-muted-foreground">Page {page} of {Math.max(1, pagination.totalPages || 1)}</span><button type="button" aria-label="Next conversation page" disabled={!pagination.hasMore || listBusy} onClick={() => setPage(value => value + 1)} className="rounded-lg p-2 disabled:opacity-30"><ChevronRight size={17} /></button></div>
      </aside>
      <article className="glass-panel min-w-0 overflow-hidden">{selected && <header className="border-b border-white/20 p-4 sm:p-5"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="min-w-0 break-words text-lg font-semibold">{selected.legacy ? 'Older saved chat' : selected.title}</h2><Source source={selected.source} /></div><p className="mt-1 break-words text-xs text-muted-foreground">{selected.user.name} · {selected.user.email}</p></header>}
        <div className="max-h-[72vh] min-h-[420px] space-y-4 overflow-y-auto p-4 sm:p-5" aria-label="Saved conversation transcript">
          {transcriptBusy ? <div role="status" className="flex items-center justify-center gap-2 py-20 text-muted-foreground"><Loader2 size={18} className="animate-spin" />Loading transcript</div> : !selected ? <div className="py-24 text-center text-sm text-muted-foreground"><MessageSquare size={32} className="mx-auto mb-3 opacity-50" />Choose a conversation to review.</div> : visibleTranscript && <>
            {visibleTranscript.pagination.hasOlder && <div className="text-center"><button type="button" disabled={olderBusy} onClick={loadEarlier} className="rounded-full border border-primary/20 bg-primary/5 px-4 py-2 text-xs font-medium text-primary">{olderBusy ? 'Loading earlier messages…' : 'Load earlier messages'}</button></div>}
            {visibleTranscript.messages.length === 0 && <p className="py-12 text-center text-sm text-muted-foreground">No retained messages are available in this conversation.</p>}
            {visibleTranscript.messages.map(message => <div key={message.id} className={`flex gap-2.5 ${message.role === 'user' ? 'flex-row-reverse' : ''}`}>
              <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ${message.role === 'assistant' ? 'bg-primary/10 text-primary' : 'bg-sky-500/10 text-sky-500'}`}>{message.role === 'assistant' ? <Bot size={16} /> : <User size={16} />}</span>
              <div className={`min-w-0 max-w-[88%] rounded-2xl border p-3.5 sm:p-4 ${message.role === 'assistant' ? 'border-white/25 bg-white/10' : 'border-primary/15 bg-primary/5'}`}>
                <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground"><span className="font-semibold">{message.role === 'assistant' ? 'Rozare AI' : selected.user.name}</span><time>{formatTime(message.createdAt)}</time></div>
                {message.content && <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{message.content}</p>}
                {(message.attachments || []).map(safeChatAttachment).filter(Boolean).map(attachment => <a key={attachment.url} href={attachment.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" className="mt-3 flex items-center gap-2 break-all rounded-xl border border-primary/15 bg-primary/5 p-3 text-xs font-medium text-primary"><ExternalLink size={14} className="shrink-0" />{attachment.name}</a>)}
              </div>
            </div>)}
          </>}
          {transcriptError && <p role="alert" className="rounded-xl bg-red-500/10 p-3 text-sm text-red-500">{transcriptError}</p>}
        </div>
        <footer className="border-t border-white/20 p-4 text-[11px] leading-relaxed text-muted-foreground">Only retained chat messages are shown. Deleted or pruned history is unavailable. System instructions and private action data are excluded; access tokens are hidden.</footer>
      </article>
    </div>
  </section>;
}
