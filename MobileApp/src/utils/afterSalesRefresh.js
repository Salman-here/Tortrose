// Coordinate eligibility reads only. No mutation, draft or payment state is shared.
const listeners = new Set();
export const subscribeAfterSalesChange = listener => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
export const publishAfterSalesChange = value => {
  const orderId = String(value?._id || value || '');
  if (!/^[a-f\d]{24}$/iu.test(orderId)) return;
  for (const listener of listeners) {
    try { listener(orderId); } catch { /* A refresh cannot invalidate a confirmed mutation. */ }
  }
};
