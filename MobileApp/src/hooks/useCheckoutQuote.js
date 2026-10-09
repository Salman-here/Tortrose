import { useCallback, useEffect, useRef, useState } from 'react';
import { requireCheckoutQuote } from '../utils/checkoutQuote.js';

// Only a quote for the current actor and current cart/delivery/coupon intent is
// usable. Late responses and unmounted/account-switched requests are discarded.
export default function useCheckoutQuote({ input, enabled, requestQuote }) {
  const [state,setState] = useState({ signature:'', status:'idle', quote:null, error:'' });
  const [revision,setRevision] = useState(0);
  const requestRef = useRef(requestQuote);
  requestRef.current = requestQuote;
  const inputRef = useRef(input);
  inputRef.current = input;
  const refresh = useCallback(() => setRevision(value => value + 1),[]);
  const signature = input.signature;
  const inputReady = input.ready;
  useEffect(() => {
    if (!enabled || !inputReady) return undefined;
    const payload = inputRef.current.request;
    let active = true;
    const controller = new AbortController();
    setState({ signature, status:'loading', quote:null, error:'' });
    const timer = setTimeout(async () => {
      try {
        const response = await requestRef.current(payload,controller.signal);
        const quote = requireCheckoutQuote(response?.data ?? response,payload);
        if (active) setState({ signature, status:'ready', quote, error:'' });
      } catch (error) {
        if (active && !controller.signal.aborted) setState({ signature, status:'error', quote:null,
          error:error?.response?.data?.msg || error?.message || 'Checkout totals could not be confirmed.' });
      }
    },250);
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  },[signature,enabled,inputReady,revision]);
  const current = enabled && input.ready && state.signature === signature;
  const ready = current && state.status === 'ready';
  return { quote:ready ? state.quote : null, ready, status:current ? state.status : enabled && input.ready ? 'loading' : 'idle',
    error:current ? state.error : '', refresh };
}
