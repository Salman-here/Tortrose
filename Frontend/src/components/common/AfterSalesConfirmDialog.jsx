import { useId } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, ShieldCheck } from 'lucide-react';
import { useReturnDialogAccessibility } from '../../utils/returnDialogAccessibility';

export default function AfterSalesConfirmDialog({ open, title, description, busy, onConfirm, onCancel, confirmLabel = 'Confirm' }) {
  const titleId = useId();
  const panel = useReturnDialogAccessibility({ open, busy, onClose: onCancel });
  if (!open || typeof document === 'undefined') return null;
  return createPortal(<div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={() => !busy && onCancel()}>
    <div ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-busy={busy} aria-labelledby={titleId}
      className="modal-surface glass-panel-strong w-full max-w-md p-5 sm:p-6 space-y-4" onClick={event => event.stopPropagation()}>
      <div className="flex items-center gap-3"><ShieldCheck size={24} className="text-primary shrink-0" /><h3 id={titleId} className="font-bold text-lg">{title}</h3></div>
      <p className="text-sm text-muted-foreground">{description}</p>
      <div className="grid grid-cols-2 gap-3"><button type="button" onClick={onCancel} disabled={busy} className="glass-button rounded-xl p-3 font-semibold disabled:opacity-50">Not now</button>
        <button type="button" onClick={onConfirm} disabled={busy} className="rounded-xl p-3 font-semibold bg-primary text-primary-foreground flex items-center justify-center gap-2 disabled:opacity-50">{busy && <Loader2 size={16} className="animate-spin" />}{confirmLabel}</button></div>
    </div>
  </div>, document.body);
}
