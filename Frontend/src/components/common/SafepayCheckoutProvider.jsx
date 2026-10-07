import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, ShieldCheck, X } from 'lucide-react';
import { registerSafepayPresenter, verifySafepayPayment } from '../../utils/safepay';
import { safepayPollingDelay, safepayRetryAfterMs } from '../../utils/safepayPolling';

export default function SafepayCheckoutProvider({ children }) {
  const [payment, setPayment] = useState(null);
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState('');
  const active = useRef(null);
  const checkingRef = useRef(false);
  const retryNotBefore = useRef(0);
  const panel = useRef(null);
  const savedCardFrame = useRef(null);
  const deliverSession = useCallback(() => {
    if (payment?.checkoutPresentation !== 'saved-card') return;
    savedCardFrame.current?.contentWindow?.postMessage({ type: 'rozare-saved-card-session',
      paymentId: payment.paymentId, grant: payment.checkoutSessionGrant }, 'https://rozare.up.railway.app');
  }, [payment]);
  useEffect(() => {
    if (payment?.checkoutPresentation !== 'saved-card') return undefined;
    const ready = event => {
      if (event.origin === 'https://rozare.up.railway.app' && event.source === savedCardFrame.current?.contentWindow
        && event.data?.type === 'rozare-saved-card-ready' && event.data.paymentId === payment.paymentId) deliverSession();
    };
    window.addEventListener('message', ready);
    return () => window.removeEventListener('message', ready);
  }, [payment, deliverSession]);
  const finish = useCallback(result => {
    const current = active.current;
    active.current = null;
    setPayment(null);
    setNotice('');
    current?.resolve(result);
  }, []);
  const check = useCallback(async (closing = false) => {
    if (!active.current || checkingRef.current) return;
    const current = active.current;
    if (Date.now() < retryNotBefore.current) {
      if (closing) finish({ status: 'pending', paymentId: current.payment.paymentId, isPaid: false });
      else setNotice('Verification is temporarily paused. Rozare will check this same payment again automatically; do not pay twice.');
      return;
    }
    checkingRef.current = true; setChecking(true);
    try {
      const result = await verifySafepayPayment(current.payment);
      if (active.current !== current) return;
      if (result.status !== 'pending' || closing) finish(result);
      else setNotice('Payment is not confirmed yet. Complete the secure form or close and resume this same attempt later.');
    } catch (error) {
      if (active.current !== current) return;
      const retryAfter = safepayRetryAfterMs(error);
      if (retryAfter) retryNotBefore.current = Date.now() + retryAfter;
      if (closing) finish({ status: 'pending', paymentId: current.payment.paymentId, isPaid: false });
      else setNotice(retryAfter
        ? 'Verification is temporarily paused. Rozare will check this same payment again automatically; do not pay twice.'
        : 'We could not verify payment yet. Do not start a second payment; check this attempt again.');
    } finally { checkingRef.current = false; setChecking(false); }
  }, [finish]);
  useEffect(() => registerSafepayPresenter(next => new Promise((resolve, reject) => {
    if (active.current) { reject(new Error('Finish or close the current payment first.')); return; }
    active.current = { payment: next, resolve };
    setNotice(''); setPayment(next);
  })), []);
  useEffect(() => {
    if (!payment) return undefined;
    const previous = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panel.current?.focus();
    const keyboard = event => {
      if (event.key === 'Escape') { event.preventDefault(); check(true); }
      if (event.key === 'Tab') {
        const items = panel.current?.querySelectorAll('button:not(:disabled), a[href], iframe');
        if (!items?.length) return;
        if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items[items.length - 1].focus(); }
        else if (!event.shiftKey && document.activeElement === items[items.length - 1]) { event.preventDefault(); items[0].focus(); }
      }
    };
    document.addEventListener('keydown', keyboard);
    const startedAt = Date.now();
    let disposed = false;
    let timer;
    const poll = async () => {
      if (disposed || !active.current) return;
      await check();
      if (!disposed && active.current) timer = setTimeout(poll,
        Math.max(safepayPollingDelay(Date.now() - startedAt), retryNotBefore.current - Date.now()));
    };
    timer = setTimeout(poll, Math.max(safepayPollingDelay(0), retryNotBefore.current - Date.now()));
    return () => { disposed = true; clearTimeout(timer); document.removeEventListener('keydown', keyboard); document.body.style.overflow = overflow; previous?.focus?.(); };
  }, [payment, check]);
  useEffect(() => () => { active.current?.resolve({ status: 'pending', isPaid: false }); active.current = null; }, []);

  return <>{children}{payment && createPortal(
    <div className="fixed inset-0 z-[10000] bg-black/65 flex items-center justify-center p-2 sm:p-5">
      <section ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="safepay-title"
        className="w-full max-w-xl h-[92dvh] rounded-2xl overflow-hidden shadow-2xl flex flex-col bg-white text-slate-900">
        <header className="flex items-center justify-between p-4 border-b">
          <div><h2 id="safepay-title" className="font-bold flex items-center gap-2"><ShieldCheck size={18} /> Secure payment</h2>
            <p className="text-xs text-slate-600">Safepay {payment.environment === 'sandbox' ? 'sandbox — test payment' : 'secure checkout'}</p></div>
          <button type="button" aria-label="Close payment and check status" onClick={() => check(true)} disabled={checking} className="p-2"><X /></button>
        </header>
        <p className="text-xs p-3 bg-slate-50">Closing this screen does not cancel a payment. Rozare verifies the result securely.</p>
        {payment.purpose === 'card_setup' && <p className="text-xs px-3 pb-3 bg-slate-50">Select “Securely save this card” in the Safepay form to keep it for future payments. Card verification alone does not start a subscription.</p>}
        <iframe ref={savedCardFrame} onLoad={deliverSession} title="Safepay secure card checkout" src={payment.checkoutUrl} className="w-full flex-1 min-h-0 border-0"
          referrerPolicy="no-referrer" allow="payment *" sandbox="allow-forms allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox" />
        <footer className="p-3 border-t text-xs space-y-2">
          {notice && <p role="status">{notice}</p>}
          <div className="flex items-center justify-between gap-3">
            <button type="button" onClick={() => check()} disabled={checking} className="font-semibold flex gap-1 items-center">{checking && <Loader2 size={14} className="animate-spin" />} Check payment status</button>
            {payment.checkoutPresentation !== 'saved-card' && <a href={payment.checkoutUrl} target="_blank" rel="noopener noreferrer" className="underline">Open secure form in a new tab</a>}
          </div>
        </footer>
      </section>
    </div>, document.body)}</>;
}
