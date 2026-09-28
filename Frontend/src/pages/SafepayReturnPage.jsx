import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ShieldCheck, RefreshCw } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { safepayApi } from '../utils/safepay';
import { validateSafepayPayment } from '../utils/safepayContract';

export default function SafepayReturnPage() {
  const [params] = useSearchParams();
  const { currentUser } = useAuth();
  const paymentId = params.get('paymentId');
  const [payment, setPayment] = useState(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let disposed = false;
    let timer;
    if (!currentUser || !/^[a-f\d]{24}$/i.test(paymentId || '')) return undefined;
    const check = async () => {
      try {
        const { data } = await safepayApi.get(`/payments/${paymentId}`);
        const result = validateSafepayPayment(data);
        if (result.paymentId !== paymentId) throw new Error('Payment reference could not be verified.');
        if (disposed) return;
        setPayment(result); setError('');
        if (result.status === 'pending') timer = setTimeout(check, 4000);
      } catch (err) { if (!disposed) setError(err.response?.data?.msg || err.message || 'Payment verification is unavailable.'); }
    };
    check();
    return () => { disposed = true; clearTimeout(timer); };
  }, [paymentId, currentUser, retry]);
  const complete = ['paid', 'authorized'].includes(payment?.status);
  const destination = ({ wallet_top_up: '/user-dashboard/wallet', card_setup: '/user-dashboard/payment-methods', subdomain: '/seller-dashboard/subdomain' })[payment?.purpose] || '/user-dashboard/orders';
  return <main className="max-w-lg mx-auto p-6 my-12 glass-card space-y-5 text-center">
    <ShieldCheck className="mx-auto text-primary" size={40} /><h1 className="text-2xl font-bold">{complete ? payment.status === 'authorized' ? 'Card setup verified' : 'Payment verified' : 'Safepay checkout'}</h1>
    {!currentUser ? <p>Sign in to Rozare to check your payment securely. Returning from checkout alone does not confirm payment.</p>
      : !/^[a-f\d]{24}$/i.test(paymentId || '') ? <p role="alert">The payment reference is invalid.</p>
        : error ? <p role="alert">{error}</p>
          : complete ? <p>Your payment outcome has been verified by Rozare. You can close this payment window and return to your previous screen.</p>
            : <p role="status">{payment?.status === 'pending' || !payment ? 'Checking your payment. Please do not start another payment while this attempt is being verified.' : `Payment status: ${payment.status.replace(/_/g, ' ')}. Return to your account for details.`}</p>}
    {error && <button className="glass-button px-4 py-2 inline-flex gap-2" onClick={() => setRetry(value => value + 1)}><RefreshCw size={16} /> Check again</button>}
    <Link className="glass-button-primary px-5 py-3 inline-block" to={currentUser ? destination : '/login'}>{currentUser ? 'Return to Rozare' : 'Sign in'}</Link>
  </main>;
}
