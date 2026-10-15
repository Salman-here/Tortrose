import { validateProductSelection } from './productOptions.js';
const check = (product, options, color) => validateProductSelection(product, options, color);

const productIdOf = line => String(line?.product?._id || line?.productId || '');
const optionKey = value => JSON.stringify(Object.entries(value || {}).sort(([a], [b]) => a.localeCompare(b)));
const selectionKey = value => JSON.stringify([value.selectedColor || null, optionKey(value.selectedOptions)]);
const checkedLines = (product, cart) => (Array.isArray(cart) ? cart : []).filter(line =>
  Boolean(product?._id) && productIdOf(line) === String(product._id) && Number.isSafeInteger(line.qty) && line.qty > 0
).map(line => ({ line, selection: check(product, line.selectedOptions, line.selectedColor) })).filter(row => row.selection.ok);

// Match the exact canonical variant, never just the product or a local picker draft.
export function findProductCartLine(product, cart, selectedOptions = {}, selectedColor = null) {
  const wanted = check(product, selectedOptions, selectedColor);
  if (!wanted.ok) return null;
  return checkedLines(product, cart).find(row => selectionKey(row.selection) === selectionKey(wanted))?.line || null;
}

// Cards may represent a variant already explicitly chosen elsewhere. Prefer the
// current exact line, then the most recently added valid variant. The UI labels
// that displayed variant and keeps a separate options action for other variants.
export function resolveProductCartLine(product, cart, selectedOptions = {}, selectedColor = null) {
  return findProductCartLine(product, cart, selectedOptions, selectedColor)
    || checkedLines(product, cart).slice(-1)[0]?.line || null;
}

export function getCartProductQuantity(product, cart) {
  return (Array.isArray(cart) ? cart : []).filter(line => Boolean(product?._id) && productIdOf(line) === String(product._id))
    .reduce((total, line) => Number.isSafeInteger(line.qty) && line.qty > 0 && Number.isSafeInteger(total + line.qty) ? total + line.qty : total, 0);
}

export function cartVariantLabel(product, line) {
  if (!line) return '';
  const value = check(product, line.selectedOptions, line.selectedColor);
  if (!value.ok) return '';
  return value.groups.map(group => group.legacy ? value.selectedColor : value.selectedOptions?.[group.name]).filter(Boolean).join(' / ');
}
