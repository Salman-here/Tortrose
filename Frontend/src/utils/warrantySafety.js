import { inspectBuyerReturnOrderContext, inspectBuyerReturnRequest } from './returnPresentationSafety.js';
const id = value => typeof value === 'string' && /^[a-f\d]{24}$/iu.test(value);
const iso = value => typeof value === 'string' && Number.isFinite(new Date(value).getTime()) && new Date(value).toISOString() === value;
export const inspectWarrantyCoverage = (response, order) => {
  const context = inspectBuyerReturnOrderContext(order);
  if (!context.valid || response?.version !== 1 || response.orderId !== context.orderId || response.currency !== context.currency || !Array.isArray(response.groups)) return { valid: false, groups: [] };
  const seen = new Set();
  const valid = response.groups.every(group => id(group?.seller?._id) && Array.isArray(group.items) && group.items.every(item => {
    const original = context.itemById.get(item.orderItemId);
    if (!original || seen.has(item.orderItemId) || original.sellerId && original.sellerId !== group.seller._id
      || original.quantity !== item.purchasedQuantity || !Number.isSafeInteger(item.availableQuantity)
      || item.availableQuantity < 0 || item.availableQuantity > item.purchasedQuantity || typeof item.eligible !== 'boolean'
      || typeof item.reason !== 'string' || !Number.isInteger(item.months) || item.months < 0 || item.months > 120
      || item.eligible && (!item.availableQuantity || item.months < 1 || !iso(item.deadline) || !iso(item.deliveredAt))) return false;
    seen.add(item.orderItemId); return true;
  }));
  const complete = valid && seen.size === context.items.length;
  return { valid: complete, groups: complete ? response.groups : [] };
};
export const inspectWarrantyList = (rows, order) => {
  const context = inspectBuyerReturnOrderContext(order);
  if (!context.valid || !Array.isArray(rows)) return false;
  const seen = new Set();
  return rows.every(claim => {
    if (!inspectBuyerReturnRequest(claim, context).valid || claim.kind !== 'warranty' || seen.has(claim._id)
      || claim.order !== context.orderId || claim.currency !== context.currency) return false;
    seen.add(claim._id);
    return claim.items.every(item => {
      const original = context.itemById.get(item.orderItemId);
      return original && original.productId === item.productId && original.quantity === item.purchasedQuantity;
    });
  });
};
