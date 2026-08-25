/**
 * Share Wishlist — generates an HTML preview of the user's wishlist
 * and shares it via expo-sharing (PDF) or React Native Share (deep link).
 */
import { Share, Platform } from 'react-native';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { currencyCodeIsSupported, roundCurrencyAmount } from './currencySafety';

const hasOwn = (value, key) => (
  value !== null
  && typeof value === 'object'
  && Object.prototype.hasOwnProperty.call(value, key)
);

const productCurrency = (item) => {
  const raw = hasOwn(item, 'currency')
    ? item.currency
    : (hasOwn(item, 'priceCurrency') ? item.priceCurrency : 'USD');
  return typeof raw === 'string'
    && raw === raw.trim().toUpperCase()
    && currencyCodeIsSupported(raw)
    ? raw
    : null;
};

const effectiveNativePrice = (item) => {
  const price = item?.price;
  const priceIsExact = typeof price === 'number'
    && Number.isFinite(price)
    && price >= 0
    && roundCurrencyAmount(price) === price;
  if (!priceIsExact) return null;

  const discountedPrice = item?.discountedPrice;
  const hasDiscount = discountedPrice !== null && discountedPrice !== undefined;
  if (hasDiscount && (
    typeof discountedPrice !== 'number'
    || !Number.isFinite(discountedPrice)
    || discountedPrice < 0
    || roundCurrencyAmount(discountedPrice) !== discountedPrice
  )) return null;
  if (discountedPrice > 0 && discountedPrice < price) {
    return discountedPrice;
  }
  return price;
};

export const formatWishlistProductPrice = (item) => {
  const currency = productCurrency(item);
  const amount = effectiveNativePrice(item);
  if (!currency || amount === null) return 'Price unavailable';
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch (_) {
    return `${currency} ${amount.toFixed(2)}`;
  }
};

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

export const buildWishlistHtml = (items, userName = 'My') => {
  const rows = items.map((it) => `
    <tr>
      <td style="padding:12px;border-bottom:1px solid #eee">
        <img src="${escapeHtml(it.image || it.images?.[0]?.url || '')}" width="60" height="60" style="border-radius:8px;object-fit:cover" />
      </td>
      <td style="padding:12px;border-bottom:1px solid #eee;font-family:-apple-system,Inter,sans-serif">
        <div style="font-weight:600;color:#111;font-size:14px">${escapeHtml(it.name)}</div>
        <div style="color:#6366f1;font-weight:700;margin-top:4px">${formatWishlistProductPrice(it)}</div>
      </td>
    </tr>`).join('');
  return `<!doctype html><html><body style="margin:0;padding:24px;font-family:-apple-system,Inter,sans-serif;background:#fafafa">
    <h1 style="font-size:28px;color:#111;margin:0 0 4px">${escapeHtml(userName)} Wishlist</h1>
    <p style="color:#666;margin:0 0 24px">${items.length} item${items.length === 1 ? '' : 's'} from Rozare</p>
    <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:12px;overflow:hidden">
      ${rows}
    </table>
    <p style="text-align:center;color:#999;margin-top:32px;font-size:12px">Shop more at rozare.com</p>
  </body></html>`;
};

export const shareWishlistAsLink = async (items = [], userName = 'My') => {
  const top = items.slice(0, 5).map((it) => `• ${it.name}`).join('\n');
  const message = `${userName} Wishlist on Rozare\n${items.length} items\n\n${top}\n\nShop on Rozare: https://rozare.com`;
  try {
    await Share.share({ message, title: `${userName} Wishlist` });
    return true;
  } catch { return false; }
};

export const shareWishlistAsPdf = async (items = [], userName = 'My') => {
  try {
    const { uri } = await Print.printToFileAsync({ html: buildWishlistHtml(items, userName) });
    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(uri, { mimeType: 'application/pdf', dialogTitle: `${userName} Wishlist` });
      return true;
    }
    return false;
  } catch { return false; }
};
