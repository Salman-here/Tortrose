import { addCurrencyAmounts, toCurrencyMinorUnits, SUPPORTED_CURRENCY_CODES } from './currencySafety.js';

const id = value => String(value?._id || value || '');
const exactMoney = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
  && toCurrencyMinorUnits(value) / 100 === value;
const stable = value => Array.isArray(value) ? value.map(stable)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;

export function createCheckoutQuoteInput({ actor, currency, cart = [], selections = {}, shippingMethods = {}, coupons = [], paymentMethod, location = {}, pricingSignature = '' }) {
  const items = cart.map(item => ({ id:id(item.product?._id || item.productId), quantity:item.qty ?? item.quantity ?? 1,
    selectedColor:item.selectedColor || null, selectedOptions:item.selectedOptions || undefined }));
  const sellers = [...new Set(cart.map(item => id(item.product?.seller)).filter(Boolean))];
  const sellerShipping = sellers.map(seller => {
    const selected = selections[seller]?.type || selections[seller]?.name;
    const method = shippingMethods[seller]?.methods?.find(candidate => candidate.type === selected);
    return method ? { seller, shippingMethod:{ name:method.type } } : null;
  }).filter(Boolean);
  const appliedCoupons = (Array.isArray(coupons) ? coupons : Object.values(coupons)).map(coupon =>
    ({ couponId:id(coupon._id || coupon.couponId), applicableProductIds:coupon.applicableProductIds || [] }));
  const method = paymentMethod === 'wallet' ? 'wallet' : ['card','safepay'].includes(paymentMethod) ? 'safepay' : 'cash_on_delivery';
  const request = { order:{ currency, paymentMethod:method, orderItems:items, sellerShipping, appliedCoupons,
    buyerLocation:{ town:location.town || '' },
    shippingInfo:{ country:location.country || '', countryCode:location.countryCode || '', city:location.city || '', state:location.state || location.region || '' } } };
  const signature = JSON.stringify(stable({ actor:id(actor), request, pricingSignature,
    sourceMoney:cart.map(item => [item.product?.price, item.product?.priceInputAmount, item.product?.priceCurrency, item.product?.discountedPrice, item.product?.discountedPriceInputAmount]) }));
  return { request, signature, ready:Boolean(actor) && items.length > 0 && sellers.length > 0 && sellerShipping.length === sellers.length };
}

export function requireCheckoutQuote(raw, request) {
  const requested = request?.order;
  const summary = raw?.orderSummary;
  const fields = ['subtotal','shippingCost','tax','couponDiscount','totalAmount'];
  if (!requested || raw?.success !== true || raw.pricingPolicyVersion !== 1 || !SUPPORTED_CURRENCY_CODES.includes(raw.currency) || raw.currency !== requested.currency
      || !summary || fields.some(field => !exactMoney(summary[field]))
      || !Array.isArray(raw.orderItems) || raw.orderItems.length !== requested.orderItems.length
      || !Array.isArray(raw.sellerShipping) || raw.sellerShipping.length !== requested.sellerShipping.length
      || !Array.isArray(raw.appliedCoupons) || raw.appliedCoupons.length !== requested.appliedCoupons.length) {
    throw new Error('Checkout totals could not be confirmed. Please refresh checkout.');
  }
  raw.orderItems.forEach((item,index) => {
    const source = requested.orderItems[index];
    if (id(item.productId) !== source.id || item.quantity !== source.quantity || !exactMoney(item.lineSubtotal)
        || !exactMoney(item.discountAmount) || item.discountAmount > item.lineSubtotal) throw new Error('Checkout items changed. Refresh your cart.');
  });
  const sellerIds = new Set(requested.sellerShipping.map(row => id(row.seller)));
  const returnedSellers = new Set();
  raw.sellerShipping.forEach(row => {
    const seller = id(row.seller);
    const requestedRow = requested.sellerShipping.find(entry => id(entry.seller) === seller);
    if (!sellerIds.has(seller) || returnedSellers.has(seller) || row.shippingMethod?.name !== requestedRow.shippingMethod.name
        || !exactMoney(row.shippingMethod.price)) throw new Error('Delivery totals could not be confirmed.');
    returnedSellers.add(seller);
  });
  const couponIds = new Set(requested.appliedCoupons.map(row => id(row.couponId)));
  const returnedCoupons = new Set();
  raw.appliedCoupons.forEach(row => {
    const coupon = id(row.couponId);
    if (!couponIds.has(coupon) || returnedCoupons.has(coupon) || !exactMoney(row.appliedDiscountAmount)) throw new Error('Coupon totals could not be confirmed.');
    returnedCoupons.add(coupon);
  });
  if (addCurrencyAmounts(...raw.orderItems.map(row => row.lineSubtotal)) !== summary.subtotal
      || addCurrencyAmounts(...raw.orderItems.map(row => row.discountAmount)) !== summary.couponDiscount
      || addCurrencyAmounts(...raw.sellerShipping.map(row => row.shippingMethod.price)) !== summary.shippingCost
      || addCurrencyAmounts(...raw.appliedCoupons.map(row => row.appliedDiscountAmount)) !== summary.couponDiscount
      || addCurrencyAmounts(summary.subtotal,summary.shippingCost,summary.tax,-summary.couponDiscount) !== summary.totalAmount) {
    throw new Error('Checkout amounts do not add up. Please refresh checkout.');
  }
  return raw;
}
