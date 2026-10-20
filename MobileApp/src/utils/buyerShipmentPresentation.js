// Display wording only. Stored money, cancellation eligibility and status stay authoritative.
export function getBuyerDeliveryHeading(storeCount) {
  return storeCount > 1
    ? { title: 'Store deliveries', subtitle: `Your order includes ${storeCount} stores. Track each delivery below.` }
    : { title: 'Delivery details', subtitle: 'Your items, delivery updates and store total.' };
}

export function getShipmentItemLabel(itemCount, units) {
  const items = `${itemCount} item${itemCount === 1 ? '' : 's'}`;
  return units !== itemCount ? `${items} · ${units} unit${units === 1 ? '' : 's'}` : items;
}

export function getBuyerShippingPresentation(shippingMethod) {
  if (!shippingMethod) return { name: 'Delivery details unavailable', estimate: null };
  const rawName = typeof shippingMethod.name === 'string' ? shippingMethod.name.trim() : '';
  const method = rawName.toLowerCase();
  const labels = {
    free: shippingMethod.price === 0 ? 'Free shipping' : 'Delivery',
    standard: 'Standard delivery',
    fast: 'Express delivery',
    express: 'Express delivery',
  };
  return {
    name: Object.prototype.hasOwnProperty.call(labels, method) ? labels[method] : rawName || 'Delivery',
    estimate: Number.isFinite(shippingMethod.estimatedDays) && shippingMethod.estimatedDays > 0
      ? `Estimated delivery: ${shippingMethod.estimatedDays} day${shippingMethod.estimatedDays === 1 ? '' : 's'}`
      : 'Delivery estimate not available',
  };
}
