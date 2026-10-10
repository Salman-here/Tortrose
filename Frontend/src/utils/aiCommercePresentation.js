const CURRENCIES = new Set(['USD', 'PKR', 'EUR', 'GBP']);
const TITLES = {
  cancel_order: 'cancellation', request_return: 'return request', cancel_return: 'return-request cancellation',
  update_return_status: 'return status update', accept_return: 'return acceptance',
  request_withdrawal: 'withdrawal request', update_order_status: 'shipment update',
};
const safeMoney = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
  && Number.isSafeInteger(Math.round(value * 100)) && Math.abs(value * 100 - Math.round(value * 100)) < 0.000001;
export function aiCommercePreviewPresentation(result) {
  const preview = result?.data?.commercePreview;
  const request = result?.data?.request || {};
  if (result?.success !== true || result.previewOnly !== true || result.requiresConfirmation !== true
    || !preview || !TITLES[preview.action] || result.data.action !== preview.action
    || typeof preview.title !== 'string' || typeof preview.notice !== 'string'
    || !/^aif1\.[a-f0-9]{64}$/.test(result.data.quoteToken || '')
    || !Number.isFinite(new Date(preview.expiresAt).getTime())) return null;
  const controls = [];
  if (preview.action === 'cancel_order' && Array.isArray(preview.options) && preview.options.length) {
    for (const option of preview.options) {
      if (!['wallet', 'original_card', 'none'].includes(option.destination) || !CURRENCIES.has(option.currency)
        || !safeMoney(option.amount) || !safeMoney(option.deduction)) return null;
    }
    const selected = request.refundDestination;
    const options = selected ? preview.options.filter(option => option.destination === selected) : preview.options;
    if (!options.length) return null;
    for (const option of options) {
      const choosing = !selected && options.length > 1;
      const destination = option.destination === 'wallet' ? 'full Wallet refund'
        : option.destination === 'original_card' ? 'original-card refund' : result.data.cancellationQuote?.paymentMethod === 'cash_on_delivery' ? 'COD cancellation' : 'no-money cancellation';
      controls.push({
        label: choosing ? `Review ${option.label}` : option.destination === 'none' ? 'Confirm cancellation'
          : `Confirm ${option.label} · ${option.amount.toFixed(2)} ${option.currency}`,
        message: choosing ? `Please review this cancellation with ${destination} before submitting anything.`
          : `Yes, confirm this cancellation with ${destination}${option.destination === 'original_card' ? ' and accept the displayed processing deduction' : ''}.`,
      });
    }
  } else {
    let detail = '';
    if (preview.action === 'request_withdrawal') {
      if (!safeMoney(request.amount) || request.amount <= 0 || !CURRENCIES.has(request.currency)) return null;
      detail = ` of ${request.amount.toFixed(2)} ${request.currency}`;
    }
    const another = preview.action === 'request_withdrawal' && result.data.anotherRequestRequired === true;
    controls.push({ label: 'Confirm ' + (another ? 'another NEW ' : '') + TITLES[preview.action],
      message: `Yes, confirm ${another ? 'another new' : 'this'} ${TITLES[preview.action]}${detail}.` });
  }
  return { title: preview.title, notice: preview.notice, controls,
    reminder: 'Nothing submitted yet. The server checks these details again when you confirm.' };
}
