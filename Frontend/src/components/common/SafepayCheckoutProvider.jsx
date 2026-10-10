import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, ShieldCheck, X } from 'lucide-react';
import { registerSafepayPresenter, verifySafepayPayment } from '../../utils/safepay';
import { safepayPollingDelay, safepayRetryAfterMs } from '../../utils/safepayPolling';
import { checkSafepayPopupSession, isSafepayPopupReturn } from '../../utils/safepayPopupReturn';

export default function SafepayCheckoutProvider({ children }) {
  const [payment, setPayment] = useState(null);
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState('');
  const active = useRef(null);
  const presentationGeneration = useRef(0);
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
    setChecking(false);
    current?.resolve(result);
  }, []);
  const check = useCallback(async (closing = false) => {
    const current = active.current;
    await checkSafepayPopupSession(current, { closing, verify: verifySafepayPayment, finish,
      notice: setNotice, checking: setChecking, isCurrent: session => active.current === session,
      retryAfter: safepayRetryAfterMs });
  }, [finish]);
  useEffect(() => {
    if (!payment) return undefined;
    const returned = event => {
      if (active.current?.payment !== payment) return;
      if (isSafepayPopupReturn(event, { paymentId: payment.paymentId,
        frameWindow: savedCardFrame.current?.contentWindow, appOrigin: window.location.origin })) check(true);
    };
    window.addEventListener('message', returned);
    return () => window.removeEventListener('message', returned);
  }, [payment, check]);
  useEffect(() => registerSafepayPresenter(next => new Promise((resolve, reject) => {
    if (active.current) { reject(new Error('Finish or close the current payment first.')); return; }
    const presented = { ...next, popupGeneration: ++presentationGeneration.current };
    active.current = { payment: presented, resolve, checking: false, closeRequested: false, retryNotBefore: 0 };
    setNotice(''); setChecking(false); setPayment(presented);
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
        Math.max(safepayPollingDelay(Date.now() - startedAt), active.current.retryNotBefore - Date.now()));
    };
    timer = setTimeout(poll, Math.max(safepayPollingDelay(0), active.current.retryNotBefore - Date.now()));
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
          <button type="button" aria-label="Close payment and check status" onClick={() => check(true)} className="p-2"><X /></button>
        </header>
        <p className="text-xs p-3 bg-slate-50">Closing this screen does not cancel a payment. Rozare verifies the result securely.</p>
        {payment.purpose === 'card_setup' && <p className="text-xs px-3 pb-3 bg-slate-50">Select “Securely save this card” in the Safepay form to keep it for future payments. Card verification alone does not start a subscription.</p>}
        <iframe key={`${payment.paymentId}:${payment.popupGeneration}`} ref={savedCardFrame} onLoad={deliverSession} title="Safepay secure card checkout" src={payment.checkoutUrl} className="w-full flex-1 min-h-0 border-0"
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
