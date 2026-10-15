import { normalizeGuestCart, parseStoredGuestCart } from './guestCart.js';
// Cookies share a guest bag between store subdomains. Store each product once,
// not its complete catalogue document once per selected color/size.
const fields = ['_id','name','image','category','brand','stock','currency','priceCurrency','price','priceOriginal','discountedPrice','discountedPriceOriginal','colors','optionGroups'];
export function serializeGuestCartCookie(items) {
  const cart = normalizeGuestCart(items), products = {};
  for (const line of cart) {
    const product = line.product;
    const value = Object.fromEntries(fields.filter(field => product[field] !== undefined).map(field => [field,product[field]]));
    const seller = product.seller;
    if (seller) value.seller = typeof seller === 'string' ? seller : { _id:seller._id, username:seller.username, store:seller.store ? { _id:seller.store._id, storeName:seller.store.storeName, storeSlug:seller.store.storeSlug } : undefined };
    products[product._id] = value;
  }
  const data = JSON.stringify({ version:2, products, lines:cart.map(line => ({ productId:line.product._id,qty:line.qty,selectedColor:line.selectedColor,selectedOptions:line.selectedOptions })) });
  if (encodeURIComponent(data).length > 3500) throw new Error('Your guest bag is full. Sign in to save a larger bag; your existing items have not changed.');
  return data;
}
export function parseGuestCartCookie(raw) {
  const value = JSON.parse(raw);
  if (Array.isArray(value)) return parseStoredGuestCart(raw);
  if (value?.version !== 2 || !value.products || !Array.isArray(value.lines)) throw new Error('The shared guest bag could not be verified.');
  return normalizeGuestCart(value.lines.map(line => ({ ...line,product:value.products[line.productId] })));
}
