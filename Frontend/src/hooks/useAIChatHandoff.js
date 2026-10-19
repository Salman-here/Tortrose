import { useEffect, useRef } from 'react';

// A navigation/event intent is not a draft. Consume it exactly once, only
// after the intended owner's conversation has finished restoring.
export function useAIChatHandoff({ request, actorKey, ready, busy, send, consumed, failed }) {
  const claimed = useRef(new Set());
  const callbacks = useRef({ send, consumed, failed });
  callbacks.current = { send, consumed, failed };
  useEffect(() => {
    if (!request?.id || !request.prompt?.trim() || !ready || busy) return;
    const key = `${actorKey}:${request.id}`;
    if (claimed.current.has(key)) return;
    claimed.current.add(key);
    if (claimed.current.size > 256) claimed.current.delete(claimed.current.values().next().value);
    callbacks.current.consumed?.(request.id);
    if (request.actorKey !== actorKey) return;
    try { Promise.resolve(callbacks.current.send(request.prompt, [])).catch(() => callbacks.current.failed?.(request.prompt)); }
    catch (_) { callbacks.current.failed?.(request.prompt); }
  }, [request?.id, request?.prompt, request?.actorKey, actorKey, ready, busy]);
}
