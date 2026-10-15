// Pure guest-cart edit: keep quantities, merge equal variants, never add a copy.
export function replaceGuestVariant(cart, line, product, selection, nextLineId) {
  const key = row => JSON.stringify([row.selectedColor || null, Object.entries(row.selectedOptions || {}).filter(([,v]) => v != null && v !== '').sort(([a],[b]) => a.localeCompare(b))]);
  const current = cart.find(row => row._id === line._id);
  if (!current || current.qty !== line.qty || key(current) !== key(line)) throw new Error('This variant changed. Review your bag and try again.');
  const rows = cart.filter(row => String(row.product?._id) === String(product._id));
  const total = rows.reduce((sum,row) => { if (!Number.isSafeInteger(row.qty) || row.qty < 1 || !Number.isSafeInteger(sum + row.qty)) throw new Error('Cart quantities could not be verified.'); return sum + row.qty; },0);
  if (!Number.isSafeInteger(product.stock) || total > product.stock) throw new Error('Reduce the quantity to match available stock before changing options.');
  const other = rows.find(row => row._id !== line._id && key(row) === key(selection));
  return cart.flatMap(row => {
    if (row._id === line._id) return other ? [] : [{ ...row, _id: nextLineId, product, selectedColor: selection.selectedColor || null, selectedOptions: selection.selectedOptions }];
    if (row._id === other?._id) return [{ ...row, product, qty: row.qty + line.qty }];
    return String(row.product?._id) === String(product._id) ? [{ ...row, product }] : [row];
  });
}
