import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, ChevronRight, Palette, SlidersHorizontal, Sparkles, X } from 'lucide-react';
import { useCurrency, resolveProductPresentationCurrency, resolveProductPresentationMoney } from '../../contexts/CurrencyContext';
import {
  createProductSelection,
  getProductSelectionPayload,
  normalizeProductOptionGroups,
} from '../../utils/productOptions';

/**
 * Premium, responsive option picker shared by catalogue cards and the product
 * detail page. It intentionally lives in a portal so cards with overflow
 * clipping or transformed parents never cut off the dialog.
 */
const ProductOptionsModal = ({
  open,
  product,
  selectedOptions = {},
  selectedColor = null,
  onClose,
  onConfirm,
  submitting = false,
}) => {
  const { formatPrice } = useCurrency();
  const closeButtonRef = useRef(null);
  const [localOptions, setLocalOptions] = useState({});
  const [localColor, setLocalColor] = useState(null);
  const [showValidation, setShowValidation] = useState(false);

  const groups = useMemo(() => normalizeProductOptionGroups(product), [product]);
  const productImage = product?.images?.[0]?.url || product?.image;
  const productPrice = resolveProductPresentationMoney(product, 'price');
  const productDiscountedPrice = resolveProductPresentationMoney(product, 'discountedPrice');
  const displayPrice = productDiscountedPrice > 0 && productDiscountedPrice < productPrice
    ? productDiscountedPrice
    : productPrice;
  const productCurrency = resolveProductPresentationCurrency(product);

  // Seed each opening only with values the buyer already chose. A seller
  // default is presented as a suggestion, never as implicit consent.
  useEffect(() => {
    if (!open) return;
    const initial = createProductSelection(product, selectedOptions, selectedColor);
    setLocalOptions(initial.selectedOptions || {});
    setLocalColor(initial.selectedColor || null);
    setShowValidation(false);
  }, [open, product, selectedOptions, selectedColor]);

  useEffect(() => {
    if (!open) return undefined;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event) => {
      if (event.key === 'Escape' && !submitting) onClose?.();
    };
    document.addEventListener('keydown', onKeyDown);
    // Let the opening animation settle before moving focus for screen readers
    // and keyboard buyers.
    const focusTimer = window.setTimeout(() => closeButtonRef.current?.focus(), 30);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onClose, submitting]);

  const getGroupValue = (group) => group.legacy
    ? localColor
    : localOptions[group.name];

  // Validate the raw picker state rather than re-applying defaults here. This
  // means an intentional deselection is visible and cannot be submitted until
  // the buyer picks a value again.
  const missingGroups = groups.filter((group) => {
    const value = getGroupValue(group);
    return !(value && group.values.includes(value));
  });
  const isComplete = missingGroups.length === 0;
  const selectedCount = groups.length - missingGroups.length;

  const selectValue = (group, value) => {
    setShowValidation(false);
    if (group.legacy) {
      setLocalColor((current) => (current === value ? null : value));
      return;
    }
    setLocalOptions((current) => ({
      ...current,
      [group.name]: current[group.name] === value ? undefined : value,
    }));
  };

  const handleConfirm = () => {
    if (!isComplete) {
      setShowValidation(true);
      return;
    }
    onConfirm?.(getProductSelectionPayload(product, localOptions, localColor));
  };

  if (typeof document === 'undefined') return null;

  return createPortal(
    <AnimatePresence>
      {open && groups.length > 0 && (
        <motion.div
          key="product-options-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[120] flex items-end justify-center bg-black/55 p-0 backdrop-blur-md sm:items-center sm:p-4"
          style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !submitting) onClose?.();
          }}
          role="presentation"
        >
          <motion.div
            key="product-options-dialog"
            initial={{ opacity: 0, y: 28, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 380, damping: 32 }}
            className="glass-panel-strong relative flex max-h-[min(90dvh,720px)] w-full max-w-xl flex-col overflow-hidden rounded-t-[28px] sm:rounded-[28px]"
            role="dialog"
            aria-modal="true"
            aria-labelledby="product-options-title"
            aria-describedby="product-options-description"
            onMouseDown={(event) => event.stopPropagation()}
          >
            {/* Soft brand light keeps the dialog feeling like part of the
                existing liquid-glass system instead of a generic alert. */}
            <div
              className="pointer-events-none absolute -right-24 -top-24 h-56 w-56 rounded-full opacity-20 blur-3xl"
              style={{ background: 'linear-gradient(135deg, #14B8A6, #6366F1)' }}
            />
            <div
              className="pointer-events-none absolute -bottom-28 -left-24 h-52 w-52 rounded-full opacity-15 blur-3xl"
              style={{ background: 'linear-gradient(135deg, #0EA5E9, #8B5CF6)' }}
            />

            <div className="relative flex items-start gap-3 border-b px-5 pb-4 pt-5 sm:px-6 sm:pt-6" style={{ borderColor: 'var(--glass-border)' }}>
              <div
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl"
                style={{ background: 'var(--logo-gradient-soft)', color: 'hsl(var(--primary))' }}
              >
                <SlidersHorizontal size={21} />
              </div>
              <div className="min-w-0 flex-1 pr-8">
                <p className="mb-0.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.18em]" style={{ color: 'hsl(var(--primary))' }}>
                  <Sparkles size={11} /> Personalize your item
                </p>
                <h2 id="product-options-title" className="truncate text-lg font-extrabold sm:text-xl" style={{ color: 'hsl(var(--foreground))' }}>
                  Choose your options
                </h2>
                <p id="product-options-description" className="mt-1 text-xs leading-relaxed sm:text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>
                  Select every required option so we can add the exact version you want.
                </p>
              </div>
              <button
                ref={closeButtonRef}
                type="button"
                onClick={() => !submitting && onClose?.()}
                disabled={submitting}
                className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-xl glass-button transition hover:scale-105 disabled:cursor-not-allowed disabled:opacity-50 sm:right-5 sm:top-5"
                style={{ color: 'hsl(var(--foreground))', background: 'var(--glass-bg-strong)' }}
                aria-label="Close option picker"
              >
                <X size={17} />
              </button>
            </div>

            <div className="relative min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">
              <div className="mb-5 flex items-center gap-3 rounded-2xl p-3" style={{ background: 'var(--glass-bg-subtle)', border: '1px solid var(--glass-border-subtle)' }}>
                <div className="h-14 w-14 shrink-0 overflow-hidden rounded-xl glass-inner">
                  {productImage ? (
                    <img src={productImage} alt="" className="h-full w-full object-contain" loading="lazy" />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center" style={{ color: 'hsl(var(--muted-foreground))' }}>
                      <Palette size={20} />
                    </div>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold" style={{ color: 'hsl(var(--foreground))' }}>{product?.name || 'Selected product'}</p>
                  <p className="mt-0.5 text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>
                    {displayPrice > 0 ? formatPrice(displayPrice, { sourceCurrency: productCurrency }) : 'Price shown at checkout'}
                  </p>
                </div>
                <div className="shrink-0 rounded-full px-2.5 py-1 text-[10px] font-bold" style={{ background: isComplete ? 'rgba(16,185,129,0.14)' : 'rgba(14,165,233,0.12)', color: isComplete ? 'hsl(150,60%,40%)' : 'hsl(var(--primary))' }}>
                  {selectedCount}/{groups.length} selected
                </div>
              </div>

              <div className="space-y-5">
                {groups.map((group, index) => {
                  const value = getGroupValue(group);
                  const missing = !value || !group.values.includes(value);
                  return (
                    <section key={`${group.name}-${index}`} aria-labelledby={`product-option-group-${index}`}>
                      <div className="mb-2.5 flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <h3 id={`product-option-group-${index}`} className="flex items-center gap-2 text-sm font-bold" style={{ color: 'hsl(var(--foreground))' }}>
                            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold" style={{ background: value ? 'rgba(16,185,129,0.14)' : 'var(--glass-bg-strong)', color: value ? 'hsl(150,60%,40%)' : 'hsl(var(--primary))' }}>
                              {value ? <Check size={12} /> : index + 1}
                            </span>
                            <span className="truncate">{group.name}</span>
                          </h3>
                        </div>
                        <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider" style={{ color: missing && showValidation ? 'hsl(0,72%,55%)' : 'hsl(var(--muted-foreground))' }}>
                          {missing && showValidation ? 'Choose one' : 'Required'}
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {group.values.map((option) => {
                          const active = value === option;
                          const suggested = group.default === option;
                          return (
                            <motion.button
                              key={option}
                              type="button"
                              onClick={() => selectValue(group, option)}
                              whileHover={{ y: -1, scale: 1.02 }}
                              whileTap={{ scale: 0.97 }}
                              className="inline-flex min-h-10 items-center gap-1.5 rounded-xl px-3.5 py-2 text-sm font-semibold transition-all focus:outline-none focus:ring-2"
                              style={active
                                ? { background: 'var(--logo-gradient)', color: 'white', border: '1px solid transparent', boxShadow: 'var(--logo-glow)', '--tw-ring-color': 'rgba(14,165,233,0.4)' }
                                : { background: 'var(--glass-bg-subtle)', color: 'hsl(var(--foreground))', border: `1px solid ${missing && showValidation ? 'rgba(239,68,68,0.35)' : 'var(--glass-border)'}`, '--tw-ring-color': 'rgba(14,165,233,0.35)' }}
                              aria-pressed={active}
                              aria-label={`${option}${suggested ? ', suggested' : ''}`}
                            >
                              {active && <Check size={14} />}
                              <span>{option}</span>
                              {suggested && (
                                <span
                                  className="rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide"
                                  style={{
                                    background: active ? 'rgba(255,255,255,0.20)' : 'rgba(14,165,233,0.10)',
                                    color: active ? 'white' : 'hsl(var(--primary))',
                                  }}
                                >
                                  Suggested
                                </span>
                              )}
                            </motion.button>
                          );
                        })}
                      </div>
                    </section>
                  );
                })}
              </div>

              {showValidation && !isComplete && (
                <motion.p
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="mt-5 flex items-center gap-2 rounded-xl px-3 py-2.5 text-xs font-semibold"
                  style={{ background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.22)', color: 'hsl(0,72%,50%)' }}
                  role="alert"
                >
                  <ChevronRight size={14} className="shrink-0" />
                  Choose an option for {missingGroups.map((group) => group.name).join(', ')} to continue.
                </motion.p>
              )}
            </div>

            <div className="relative border-t px-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] pt-4 sm:px-6 sm:pb-5" style={{ borderColor: 'var(--glass-border)', background: 'var(--glass-bg-subtle)' }}>
              <div className="flex items-center gap-2 text-[11px]" style={{ color: 'hsl(var(--muted-foreground))' }}>
                <Check size={13} style={{ color: isComplete ? 'hsl(150,60%,42%)' : 'hsl(var(--muted-foreground))' }} />
                {isComplete ? 'All options selected' : `${missingGroups.length} selection${missingGroups.length === 1 ? '' : 's'} remaining`}
              </div>
              <button
                type="button"
                onClick={handleConfirm}
                disabled={submitting}
                className="mt-3 flex min-h-12 w-full items-center justify-center gap-2 rounded-xl px-5 py-3 text-sm font-bold text-white transition-all hover:scale-[1.01] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
                style={{ background: 'var(--logo-gradient)', boxShadow: 'var(--logo-glow)' }}
              >
                {submitting ? (
                  <>
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/35 border-t-white" aria-hidden="true" />
                    Adding to cart…
                  </>
                ) : (
                  <>
                    {isComplete ? 'Add selected version to cart' : 'Complete your selections'} <ChevronRight size={17} />
                  </>
                )}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
};

export default ProductOptionsModal;
