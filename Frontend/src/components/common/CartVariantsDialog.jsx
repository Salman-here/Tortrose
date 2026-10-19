import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Plus, Minus, Trash2, Pencil } from 'lucide-react';
import { useGlobal } from '../../contexts/GlobalContext';
import { cartVariantLabel, findProductCartLine, getCartProductQuantity } from '../../utils/cartProductSelection';
import { useReturnDialogAccessibility } from '../../utils/returnDialogAccessibility';
import ProductOptionsModal from './ProductOptionsModal';
const EMPTY = Object.freeze({});
export default function CartVariantsDialog({ open, product, onClose }) {
  const { cartItems, handleAddToCart, handleEditCartVariant, handleQtyInc, handleQtyDec, handleRemoveCartItem, qtyUpdateId, isCartLoading } = useGlobal();
  const lines = (cartItems?.cart || []).filter(line => String(line.product?._id || line.productId) === String(product?._id));
  const [view,setView] = useState('manage'), [editing,setEditing] = useState(null), [error,setError] = useState(''), [busy,setBusy] = useState(false);
  const working = useRef(false);
  const seeded = useRef(null);
  useEffect(() => { if (!open) { seeded.current = null; return; } if (seeded.current === product?._id) return; seeded.current = product?._id; setView(lines.length ? 'manage' : 'add'); setEditing(null); setError(''); }, [open, product?._id, lines.length]);
  const blocked = busy || Boolean(qtyUpdateId) || isCartLoading;
  const displayView = seeded.current === product?._id ? view : lines.length ? 'manage' : 'add';
  const panel = useReturnDialogAccessibility({ open: open && displayView === 'manage', busy: blocked, onClose });
  const submit = async choices => {
    if (working.current) return;
    working.current = true; setBusy(true); setError('');
    try {
      if (displayView === 'edit') {
        if (await handleEditCartVariant(editing, product, choices) === false) throw new Error('The variant was not updated. Please try again.');
      } else if (findProductCartLine(product, cartItems?.cart, choices.selectedOptions, choices.selectedColor)) {
        setError('This variant is already in your cart. Close options to adjust its quantity.'); return;
      } else if (!await handleAddToCart(product._id, choices.selectedColor, choices.selectedOptions, product, 'add')) throw new Error('The variant was not added. Please try again.');
      setEditing(null); onClose();
    } catch (failure) { setError(failure.message); }
    finally { working.current = false; setBusy(false); }
  };
  if (!open || !product) return null;
  if (displayView !== 'manage') return <ProductOptionsModal open product={product} selectedOptions={displayView === 'edit' ? editing?.selectedOptions || EMPTY : EMPTY} selectedColor={displayView === 'edit' ? editing?.selectedColor || null : null}
    title={displayView === 'edit' ? 'Edit variant' : lines.length ? 'Add another variant' : 'Choose options'} confirmLabel={displayView === 'edit' ? 'Save changes' : 'Add variant to cart'}
    description={displayView === 'edit' ? 'Your quantity stays the same. Matching variants are combined into one line.' : 'Select the options for this item.'}
    error={error} submitting={busy} onConfirm={submit} onClose={() => { if (!working.current) { onClose(); setError(''); } }} />;
  return createPortal(<div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={() => !blocked && onClose()}>
    <div ref={panel} role="dialog" aria-modal="true" aria-labelledby="cart-variants-title" tabIndex={-1} className="modal-surface glass-panel-strong rounded-3xl p-5 sm:p-6 w-full max-w-lg max-h-[90dvh] overflow-y-auto" onClick={event => event.stopPropagation()}>
      <div className="flex items-start justify-between gap-3"><div><h2 id="cart-variants-title" className="text-xl font-bold">Your variants</h2><p className="text-sm text-muted-foreground mt-1">{product.name}</p></div><button type="button" disabled={blocked} className="glass-button rounded-xl p-2" aria-label="Close cart variants" onClick={onClose}><X size={18}/></button></div>
      <p className="text-sm text-muted-foreground mt-4">Add different colors or sizes separately. Edit changes an existing choice; it does not add a copy.</p>
      <div className="space-y-3 my-5">{lines.map(line => { const label = cartVariantLabel(product,line) || 'Options need updating'; return <div key={line._id} data-cart-variant={line._id} className="glass-inner rounded-2xl p-4">
        <p className="font-semibold text-sm">{label}</p><div className="mt-3 flex items-center justify-between gap-3 flex-wrap"><div className="flex items-center gap-4"><button type="button" disabled={blocked} aria-label={`Decrease ${label}`} onClick={() => handleQtyDec(line._id)} className="glass-button p-2 rounded-lg"><Minus size={15}/></button><span aria-label={`Quantity ${label}`}>{line.qty}</span><button type="button" disabled={blocked || getCartProductQuantity(product,cartItems?.cart) >= product.stock} aria-label={`Increase ${label}`} onClick={() => handleQtyInc(line._id)} className="glass-button p-2 rounded-lg"><Plus size={15}/></button></div><div className="flex gap-2"><button type="button" disabled={blocked} onClick={() => { setEditing({ ...line }); setView('edit'); setError(''); }} className="glass-button p-2 rounded-lg text-xs inline-flex gap-1 items-center" aria-label={`Edit ${label}`}><Pencil size={13}/>Edit</button><button type="button" disabled={blocked} onClick={() => handleRemoveCartItem(line._id)} className="glass-button p-2 rounded-lg" aria-label={`Remove ${label}`}><Trash2 size={14}/></button></div></div></div>; })}</div>
      {!lines.length && <p className="text-sm my-4">No variants in your bag yet.</p>}
      {error && <p role="alert" className="text-sm text-destructive mb-3">{error}</p>}
      <button type="button" disabled={blocked || getCartProductQuantity(product,cartItems?.cart) >= product.stock} onClick={() => { setEditing(null); setError(''); setView('add'); }} className="w-full min-h-12 rounded-xl font-semibold text-white disabled:opacity-50" style={{ background:'var(--logo-gradient)' }}>+ Add another variant</button>
    </div></div>,document.body);
}
