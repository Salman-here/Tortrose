import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ShieldCheck, RefreshCw } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { openSafepayCheckout, safepayApi, verifySafepayPayment } from '../utils/safepay';
import { validateSafepayPayment } from '../utils/safepayContract';
import { canResumeSafepayPayment, resumeOwnedSafepayPayment } from '../utils/safepayResume';
import { safepayPollingDelay, safepayRetryAfterMs } from '../utils/safepayPolling';

export default function SafepayReturnPage() {
  const [params] = useSearchParams();
  const { currentUser } = useAuth();
  const paymentId = params.get('paymentId');
  const [payment, setPayment] = useState(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [resuming, setResuming] = useState(false);
  const [coolingDown, setCoolingDown] = useState(false);
  useEffect(() => {
    let disposed = false;
    let timer;
    const startedAt = Date.now();
    if (resuming || !currentUser || !/^[a-f\d]{24}$/i.test(paymentId || '')) return undefined;
    const check = async () => {
      try {
        const { data } = await safepayApi.get(`/payments/${paymentId}`);
        const result = validateSafepayPayment(data);
        if (result.paymentId !== paymentId) throw new Error('Payment reference could not be verified.');
        if (disposed) return;
        setPayment(result); setError(''); setCoolingDown(false);
        if (result.status === 'pending') timer = setTimeout(check, safepayPollingDelay(Date.now() - startedAt));
      } catch (err) {
        if (disposed) return;
        const retryAfter = safepayRetryAfterMs(err);
        setCoolingDown(!!retryAfter);
        setError(retryAfter
          ? 'Verification is temporarily paused. Rozare will check this same payment again automatically; do not pay twice.'
          : err.response?.data?.msg || err.message || 'Payment verification is unavailable.');
        if (retryAfter) timer = setTimeout(check, retryAfter);
      }
    };
    check();
    return () => { disposed = true; clearTimeout(timer); };
  }, [paymentId, currentUser, retry, resuming]);
  const resume = async () => {
    if (resuming || coolingDown || !canResumeSafepayPayment(payment)) return;
    setResuming(true); setError('');
    try {
      const result = await resumeOwnedSafepayPayment(payment, {
        reopen: async id => (await safepayApi.post(`/payments/${id}/reopen`, { clientSurface: 'web' })).data,
        present: openSafepayCheckout,
        verify: verifySafepayPayment,
      });
      setPayment(result);
    } catch (err) {
      setError(err.response?.data?.msg || err.message || 'Secure checkout could not be reopened. Retry this same payment.');
    } finally { setResuming(false); setRetry(value => value + 1); }
  };
  const complete = ['paid', 'authorized'].includes(payment?.status);
  const destination = ({ wallet_top_up: '/user-dashboard/wallet', card_setup: '/user-dashboard/payment-methods', subdomain: '/seller-dashboard/subdomain' })[payment?.purpose] || '/user-dashboard/orders';
  return <main className="max-w-lg mx-auto p-6 my-12 glass-card space-y-5 text-center">
    <ShieldCheck className="mx-auto text-primary" size={40} /><h1 className="text-2xl font-bold">{complete ? payment.status === 'authorized' ? 'Card setup verified' : 'Payment verified' : 'Safepay checkout'}</h1>
    {!currentUser ? <p>Sign in to Rozare to check your payment securely. Returning from checkout alone does not confirm payment.</p>
      : !/^[a-f\d]{24}$/i.test(paymentId || '') ? <p role="alert">The payment reference is invalid.</p>
        : error ? <p role="alert">{error}</p>
          : complete ? <p>Your payment outcome has been verified by Rozare. You can close this payment window and return to your previous screen.</p>
            : <p role="status">{payment?.status === 'pending' || !payment ? 'Checking your payment. Please do not start another payment while this attempt is being verified.' : `Payment status: ${payment.status.replace(/_/g, ' ')}. Return to your account for details.`}</p>}
    {error && <button disabled={coolingDown} className="glass-button px-4 py-2 inline-flex gap-2 disabled:opacity-50" onClick={() => setRetry(value => value + 1)}><RefreshCw size={16} />{coolingDown ? 'Waiting to recheck…' : 'Check again'}</button>}
    {currentUser && canResumeSafepayPayment(payment) && <button type="button" disabled={resuming || coolingDown} onClick={resume}
      className="glass-button-primary px-5 py-3 block w-full disabled:opacity-50">
      {resuming ? 'Opening secure payment…' : 'Resume secure payment'}
    </button>}
    <Link className="glass-button-primary px-5 py-3 inline-block" to={currentUser ? destination : '/login'}>{currentUser ? 'Return to Rozare' : 'Sign in'}</Link>
  </main>;
}
