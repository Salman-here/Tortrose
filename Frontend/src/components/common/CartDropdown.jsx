import React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowRight, Loader2, Minus, Plus, ShoppingBag, ShoppingCart, Trash2, X } from "lucide-react";
import { useGlobal } from "../../contexts/GlobalContext";
import { useAuth } from "../../contexts/AuthContext";
import { useCurrency } from "../../contexts/CurrencyContext";
import { Link } from "react-router-dom";
import { toast } from "react-toastify";
import Loader from '../common/Loader'
import { getMainDomainUrl, isSubdomain } from "../../utils/subdomainHelper";
import { formatOrderItemOptions } from "../../utils/orderItems";

const CartDropdown = () => {
  const { cartItems, handleQtyInc, handleQtyDec, isOpen, dropdownRef, toggleCart, handleRemoveCartItem, isCartLoading, qtyUpdateId } = useGlobal()
  const { currentUser } = useAuth()
  const { currency, formatPrice, convertAmount } = useCurrency()

  const isEmpty = !cartItems?.cart || cartItems.cart.length === 0

  const subtotal = isEmpty ? 0 : cartItems.cart.reduce((total, item) => {
    if (!item.product) return total
    const productCurrency = item.product.currency || item.product.priceCurrency || 'USD'
    const price = Number(item.product.price || 0)
    const discountedPrice = Number(item.product.discountedPrice || 0)
    const hasDiscount = discountedPrice > 0 && discountedPrice < price
    return total + (convertAmount(hasDiscount ? discountedPrice : price, productCurrency, currency) * item.qty)
  }, 0)

  const handleGoToCheckout = () => {
    if (isEmpty) return toast.error('Your cart is empty')
  }

  const mainDomainPath = (path) => (isSubdomain() ? getMainDomainUrl(path) : path)

  return (
    <div ref={dropdownRef}>
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/30 backdrop-blur-sm z-40"
            onClick={toggleCart}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
            transition={{ type: 'tween', ease: 'easeInOut', duration: 0.3 }}
            className="fixed top-0 right-0 h-full w-[380px] max-w-full z-50 flex flex-col glass-panel-strong"
            style={{ borderRadius: '28px 0 0 28px' }}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-white/15">
              <div className="flex items-center gap-2.5">
                <div className="glass-inner p-2 rounded-xl">
                  <ShoppingBag size={18} style={{ color: 'hsl(var(--primary))' }} />
                </div>
                <h2 className="text-lg font-bold" style={{ color: 'hsl(var(--foreground))' }}>Your Cart</h2>
                {!isEmpty && (
                  <span className="tag-pill text-xs font-bold">{cartItems.cart.length}</span>
                )}
              </div>
              <motion.button whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.9 }}
                onClick={toggleCart} className="p-1.5 rounded-xl glass-button">
                <X size={18} />
              </motion.button>
            </div>

            {/* Items */}
            <div className="flex-1 overflow-y-auto">
              {isCartLoading ? (
                <div className="h-full flex items-center justify-center"><Loader /></div>
              ) : isEmpty ? (
                <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
                  className="h-full flex flex-col items-center justify-center gap-4 p-8 text-center">
                  <div className="glass-inner p-5 rounded-2xl">
                    <ShoppingCart size={40} style={{ color: 'hsl(var(--muted-foreground))' }} />
                  </div>
                  <div>
                    <p className="font-semibold text-lg" style={{ color: 'hsl(var(--foreground))' }}>Your cart is empty</p>
                    <p className="text-sm mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>Add some products to get started</p>
                  </div>
                  <Link to={mainDomainPath('/')} onClick={toggleCart}
                    className="inline-flex items-center gap-2 font-semibold px-5 py-2.5 rounded-xl text-sm glow-soft"
                    style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))', color: 'white' }}>
                    Browse Products <ArrowRight size={16} />
                  </Link>
                </motion.div>
              ) : (
                <div className="divide-y divide-white/10">
                  {cartItems.cart.map((item, index) => {
                    const { product, qty, _id: id } = item
                    if (!product) return null
                    const { _id, name, image } = product
                    const price = Number(product.price || 0)
                    const discountedPrice = Number(product.discountedPrice || 0)
                    const hasDiscount = discountedPrice > 0 && discountedPrice < price
                    const displayPrice = hasDiscount ? discountedPrice : price
                    const productCurrency = product.currency || product.priceCurrency || 'USD'
                    const lineTotal = convertAmount(displayPrice, productCurrency, currency) * qty

                    return (
                      <div key={index} className="relative p-4">
                        <AnimatePresence>
                          {qtyUpdateId === id && (
                            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                              className="absolute inset-0 glass-panel z-10 flex items-center justify-center gap-2 rounded-lg">
                              <Loader2 size={18} className="animate-spin" style={{ color: 'hsl(var(--primary))' }} />
                              <span className="text-sm font-medium" style={{ color: 'hsl(var(--primary))' }}>Updating…</span>
                            </motion.div>
                          )}
                        </AnimatePresence>

                        <div className="flex gap-3">
                          <div className="relative shrink-0">
                            <img src={image} alt={name} className="w-16 h-16 rounded-xl object-cover glass-inner" />
                            {hasDiscount && (
                              <span className="absolute -top-1.5 -right-1.5 text-[9px] font-bold px-1 py-0.5 rounded-full"
                                style={{ background: 'hsl(var(--destructive))', color: 'white' }}>SALE</span>
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <h4 className="font-semibold text-sm leading-snug truncate pr-6" style={{ color: 'hsl(var(--foreground))' }}>{name}</h4>
                            {formatOrderItemOptions(item) && (
                              <p className="text-[11px] mt-0.5 leading-snug" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                {formatOrderItemOptions(item)}
                              </p>
                            )}
                            <div className="flex items-baseline gap-1.5 mt-1">
                              <span className="font-bold text-sm" style={{ color: 'hsl(var(--primary))' }}>{formatPrice(displayPrice, { sourceCurrency: productCurrency })}</span>
                              {hasDiscount && <span className="text-xs line-through" style={{ color: 'hsl(var(--muted-foreground))' }}>{formatPrice(price, { sourceCurrency: productCurrency })}</span>}
                            </div>
                            <QuantitySelector qty={qty} onIncrement={() => handleQtyInc(item._id)} onDecrement={() => handleQtyDec(item._id)} />
                          </div>
                          <div className="flex flex-col items-end justify-between shrink-0">
                            <motion.button whileHover={{ scale: 1.15 }} whileTap={{ scale: 0.85 }}
                              onClick={() => handleRemoveCartItem(_id)}
                              className="p-1.5 rounded-lg glass-button hover:text-red-500 transition-colors cursor-pointer">
                              <Trash2 size={15} />
                            </motion.button>
                            <span className="text-sm font-bold" style={{ color: 'hsl(var(--foreground))' }}>{formatPrice(lineTotal, { sourceCurrency: currency })}</span>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            {/* Footer */}
            {!isEmpty && (
              <div className="border-t border-white/15 p-4 glass-inner m-3 rounded-2xl space-y-3">
                <div className="flex justify-between items-center">
                  <span className="text-sm font-medium" style={{ color: 'hsl(var(--muted-foreground))' }}>Subtotal</span>
                  <span className="font-bold text-lg" style={{ color: 'hsl(var(--foreground))' }}>{formatPrice(subtotal, { sourceCurrency: currency })}</span>
                </div>
                <p className="text-xs text-center" style={{ color: 'hsl(var(--muted-foreground))' }}>Taxes & shipping calculated at checkout</p>
                <Link to={mainDomainPath('/checkout')} onClick={handleGoToCheckout}>
                  <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}
                    disabled={isCartLoading}
                    className="w-full py-3 rounded-xl font-bold text-sm flex items-center justify-center gap-2 glow-soft transition-all cursor-pointer"
                    style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))', color: 'white' }}>
                    Proceed to Checkout <ArrowRight size={16} />
                  </motion.button>
                </Link>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default CartDropdown;

function QuantitySelector({ qty, onIncrement, onDecrement, disableIncrease = false }) {
  return (
    <div className="flex items-center w-max glass-inner rounded-full px-1 py-0.5 mt-2 gap-1">
      <motion.button whileTap={{ scale: 0.85 }} onClick={onDecrement}
        className="p-1 rounded-full hover:bg-white/15 transition-all cursor-pointer">
        <Minus className="w-3 h-3" />
      </motion.button>
      <AnimatePresence mode="popLayout">
        <motion.span key={qty} initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.6, opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="w-6 text-center text-xs font-bold select-none">{qty}</motion.span>
      </AnimatePresence>
      <motion.button
        whileTap={!disableIncrease ? { scale: 0.85 } : {}}
        onClick={disableIncrease ? () => toast.error('Only 1 item per product allowed.') : onIncrement}
        className={`p-1 rounded-full transition-all ${disableIncrease ? 'opacity-30 cursor-not-allowed' : 'hover:bg-white/15 cursor-pointer'}`}>
        <Plus className="w-3 h-3" />
      </motion.button>
    </div>
  )
}
