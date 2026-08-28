import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import axios from 'axios';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, Ban, Check, Flag, Loader2, ShieldCheck, X } from 'lucide-react';
import { toast } from 'react-toastify';
import { useAuth } from '../../contexts/AuthContext';
import { getAuthToken } from '../../utils/cookieHelper';

const API = `${import.meta.env.VITE_API_URL}api/safety`;
const REASONS = [
  ['inappropriate', 'Inappropriate', 'Sexual, abusive, or offensive content'],
  ['harmful', 'Harmful or unsafe', 'Could cause harm or dangerous behavior'],
  ['misleading', 'Misleading', 'False, deceptive, or inaccurate information'],
  ['spam', 'Spam', 'Repeated, promotional, or irrelevant content'],
  ['illegal', 'Illegal content', 'May violate law or someone’s rights'],
  ['other', 'Something else', 'Tell us what our safety team should review'],
];

export default function SafetyActionsDialog({ open, onClose, report, block, initialMode = 'menu', onBlocked }) {
  const { currentUser } = useAuth();
  const [mode, setMode] = useState(block && initialMode === 'menu' ? 'menu' : 'report');
  const [reason, setReason] = useState('');
  const [details, setDetails] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setMode(block && initialMode === 'menu' ? 'menu' : 'report');
    setReason('');
    setDetails('');
    setBusy(false);
  }, [open, block, initialMode]);

  const authHeaders = () => {
    const token = getAuthToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  };

  const submitReport = async () => {
    if (!reason || busy) return;
    setBusy(true);
    try {
      const response = await axios.post(`${API}/reports`, { ...report, reason, details: details.trim() }, { headers: authHeaders() });
      toast.success(response.data?.msg || 'Report submitted.');
      onClose?.();
    } catch (error) {
      toast.error(error.response?.data?.msg || 'Could not submit report.');
    } finally {
      setBusy(false);
    }
  };

  const submitBlock = async () => {
    if (!currentUser) {
      toast.info('Log in to block sellers and other accounts.');
      return;
    }
    if (!block?.userId || busy) return;
    setBusy(true);
    try {
      const response = await axios.post(`${API}/blocks`, { userId: block.userId, source: block.source || 'user' }, { headers: authHeaders() });
      toast.success(response.data?.msg || 'Account blocked.');
      onBlocked?.(block.userId);
      onClose?.();
    } catch (error) {
      toast.error(error.response?.data?.msg || 'Could not block this account.');
    } finally {
      setBusy(false);
    }
  };

  if (typeof document === 'undefined') return null;

  return createPortal((
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-[120] bg-slate-950/55 backdrop-blur-sm flex items-center justify-center p-4" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose?.(); }}>
          <motion.div className="glass-panel-strong w-full max-w-lg p-5 sm:p-6 max-h-[88vh] overflow-y-auto" initial={{ opacity: 0, scale: 0.96, y: 16 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.96, y: 16 }}>
            <div className="flex items-start gap-3">
              <div className="w-11 h-11 rounded-2xl text-white flex items-center justify-center shrink-0 shadow-lg" style={{ background: 'linear-gradient(135deg,#14B8A6,#0EA5E9,#6366F1)' }}>
                {mode === 'block' ? <Ban size={20} /> : <ShieldCheck size={20} />}
              </div>
              <div className="flex-1 min-w-0">
                <h2 className="text-lg font-extrabold" style={{ color: 'hsl(var(--foreground))' }}>{mode === 'menu' ? 'Safety options' : mode === 'block' ? `Block ${block?.label || 'account'}?` : 'Report content'}</h2>
                <p className="text-xs leading-relaxed mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                  {mode === 'menu' ? 'Choose how you want Rozare to protect your experience.' : mode === 'block' ? 'Their products, store, and reviews will be hidden. You can unblock them later in Settings.' : 'Reports are confidential. Choose the reason that best describes the issue.'}
                </p>
              </div>
              <button type="button" onClick={onClose} className="w-9 h-9 rounded-xl inline-flex items-center justify-center" aria-label="Close safety options"><X size={18} /></button>
            </div>

            {mode === 'menu' ? (
              <div className="mt-5 grid gap-3">
                <button type="button" onClick={() => setMode('report')} className="glass-inner p-4 rounded-2xl flex items-center gap-3 text-left hover:scale-[1.01] transition-transform">
                  <span className="w-10 h-10 rounded-xl inline-flex items-center justify-center" style={{ background: 'rgba(245,158,11,.12)', color: 'hsl(45,80%,40%)' }}><Flag size={19} /></span>
                  <span className="flex-1"><strong className="block text-sm" style={{ color: 'hsl(var(--foreground))' }}>Report</strong><span className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>Send this content to the Rozare safety team.</span></span>
                </button>
                {block && <button type="button" onClick={() => setMode('block')} className="glass-inner p-4 rounded-2xl flex items-center gap-3 text-left hover:scale-[1.01] transition-transform"><span className="w-10 h-10 rounded-xl inline-flex items-center justify-center" style={{ background: 'rgba(239,68,68,.10)', color: 'hsl(0,72%,55%)' }}><Ban size={19} /></span><span className="flex-1"><strong className="block text-sm" style={{ color: 'hsl(var(--foreground))' }}>Block {block.label || 'account'}</strong><span className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>Hide their content from your Rozare account.</span></span></button>}
              </div>
            ) : mode === 'block' ? (
              <>
                <div className="mt-5 rounded-2xl p-4 flex gap-3" style={{ background: 'rgba(239,68,68,.08)', border: '1px solid rgba(239,68,68,.18)' }}><AlertTriangle size={20} style={{ color: 'hsl(0,72%,55%)' }} className="shrink-0" /><p className="text-sm leading-relaxed" style={{ color: 'hsl(var(--foreground))' }}>This changes only what you see. Rozare may separately review any report you submit.</p></div>
                <div className="mt-5 flex justify-end gap-2"><button type="button" onClick={() => setMode('menu')} className="glass-button px-4 py-2.5 rounded-xl text-sm font-semibold">Go back</button><button type="button" onClick={submitBlock} disabled={busy} className="px-4 py-2.5 rounded-xl text-sm font-semibold text-white inline-flex items-center gap-2 disabled:opacity-50" style={{ background: 'hsl(0,72%,55%)' }}>{busy ? <Loader2 size={16} className="animate-spin" /> : <Ban size={16} />} Block</button></div>
              </>
            ) : (
              <div className="mt-5">
                <div className="grid gap-2">
                  {REASONS.map(([value, label, description]) => <button type="button" key={value} onClick={() => setReason(value)} className="p-3.5 rounded-2xl text-left flex items-start gap-3 transition-colors" style={{ border: reason === value ? '1px solid hsl(var(--primary))' : '1px solid var(--glass-border-subtle)', background: reason === value ? 'hsl(var(--primary) / .08)' : 'var(--glass-bg-subtle)' }}><span className="mt-0.5 w-5 h-5 rounded-full inline-flex items-center justify-center shrink-0" style={{ border: reason === value ? '1.5px solid hsl(var(--primary))' : '1.5px solid hsl(var(--muted-foreground))', color: 'hsl(var(--primary))' }}>{reason === value && <Check size={12} strokeWidth={3} />}</span><span><strong className="block text-sm" style={{ color: 'hsl(var(--foreground))' }}>{label}</strong><span className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>{description}</span></span></button>)}
                </div>
                <textarea value={details} onChange={(event) => setDetails(event.target.value)} maxLength={1000} rows={4} className="glass-input w-full resize-none mt-3" placeholder="Add details (optional)" />
                <div className="mt-5 flex justify-end gap-2">{block && initialMode === 'menu' && <button type="button" onClick={() => setMode('menu')} className="glass-button px-4 py-2.5 rounded-xl text-sm font-semibold">Go back</button>}<button type="button" onClick={submitReport} disabled={!reason || busy} className="px-4 py-2.5 rounded-xl text-sm font-semibold text-white inline-flex items-center gap-2 disabled:opacity-45" style={{ background: 'hsl(var(--primary))' }}>{busy ? <Loader2 size={16} className="animate-spin" /> : <Flag size={16} />} Submit report</button></div>
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  ), document.body);
}
