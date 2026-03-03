// src/components/CartDropdown.jsx
import React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowRight, Loader2, Minus, Plus, ShoppingBag, ShoppingCart, Trash2, X } from "lucide-react";
import { useGlobal } from "../../contexts/GlobalContext";
import { useAuth } from "../../contexts/AuthContext";
import { useCurrency } from "../../contexts/CurrencyContext";
import { Link } from "react-router-dom";
import { toast } from "react-toastify";
import Loader from '../common/Loader'

const CartDropdown = () => {
  const { cartItems, handleQtyInc, handleQtyDec, isOpen, dropdownRef, toggleCart, handleRemoveCartItem, isCartLoading, qtyUpdateId } = useGlobal()
  const { currentUser } = useAuth()
  const { formatPrice } = useCurrency()

  const isEmpty = !currentUser || !cartItems?.cart || cartItems.cart.length === 0

  const subtotal = isEmpty ? 0 : cartItems.cart.reduce((total, item) => {
    if (!item.product) return total
    return total + ((item.product.discountedPrice || item.product.price) * item.qty)
  }, 0)

  const handleGoToCheckout = () => {
    if (isEmpty) return toast.error('Your cart is empty')
  }

  return (
    <div ref={dropdownRef}>
      {/* Backdrop */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/30 backdrop-blur-sm z-40"
            onClick={toggleCart}
          />
        )}
      </AnimatePresence>

      {/* Panel */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
            transition={{ type: 'tween', ease: 'easeInOut', duration: 0.3 }}
            className="fixed top-0 right-0 h-full w-[380px] max-w-full bg-white/90 backdrop-blur-xl z-50 flex flex-col shadow-2xl shadow-indigo-900/20 border-l border-white/50"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-white/20 bg-linear-to-r from-indigo-600 to-sky-500">
              <div className="flex items-center gap-2.5">
                <ShoppingBag size={20} className="text-white" />
                <h2 className="text-lg font-bold text-white">Your Cart</h2>
                {!isEmpty && (
                  <span className="bg-white/25 text-white text-xs font-bold px-2 py-0.5 rounded-full">
                    {cartItems.cart.length}
                  </span>
                )}
              </div>
              <motion.button
                whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.9 }}
                onClick={toggleCart}
                className="p-1.5 rounded-lg bg-white/15 hover:bg-white/25 text-white transition-colors">
                <X size={18} />
              </motion.button>
            </div>

            {/* Items */}
            <div className="flex-1 overflow-y-auto">
              {isCartLoading ? (
                <div className="h-full flex items-center justify-center">
                  <Loader />
                </div>
              ) : isEmpty ? (
                <motion.div
                  initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
                  className="h-full flex flex-col items-center justify-center gap-4 p-8 text-center">
                  <div className="p-5 rounded-2xl bg-indigo-50">
                    <ShoppingCart size={40} className="text-indigo-300" />
                  </div>
                  <div>
                    <p className="font-semibold text-slate-700 text-lg">Your cart is empty</p>
                    <p className="text-sm text-slate-400 mt-1">Add some products to get started</p>
                  </div>
                  <motion.div whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}>
                    <Link to="/products" onClick={toggleCart}
                      className="inline-flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold px-5 py-2.5 rounded-xl text-sm transition-colors">
                      Browse Products <ArrowRight size={16} />
                    </Link>
                  </motion.div>
                </motion.div>
              ) : (
                <div className="divide-y divide-slate-100">
                  {cartItems.cart.map((item, index) => {
                    const { product, qty, _id: id } = item
                    if (!product) return null
                    const { _id, name, price, discountedPrice, image } = product
                    const displayPrice = discountedPrice || price
                    const hasDiscount = discountedPrice && discountedPrice < price

                    return (
                      <div key={index} className="relative p-4">
                        <AnimatePresence>
                          {qtyUpdateId === id && (
                            <motion.div
                              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                              className="absolute inset-0 backdrop-blur-sm bg-white/70 z-10 flex items-center justify-center gap-2 rounded-lg">
                              <Loader2 size={18} className="animate-spin text-indigo-600" />
                              <span className="text-sm text-indigo-700 font-medium">Updating…</span>
                            </motion.div>
                          )}
                        </AnimatePresence>

                        <div className="flex gap-3">
                          {/* Product image */}
                          <div className="relative shrink-0">
                            <img src={image} alt={name}
                              className="w-16 h-16 rounded-xl object-cover object-center border border-slate-100 shadow-sm" />
                            {hasDiscount && (
                              <span className="absolute -top-1.5 -right-1.5 bg-rose-500 text-white text-[9px] font-bold px-1 py-0.5 rounded-full">
                                SALE
                              </span>
                            )}
                          </div>

                          {/* Info */}
                          <div className="flex-1 min-w-0">
                            <h4 className="font-semibold text-slate-800 text-sm leading-snug truncate pr-6">{name}</h4>
                            <div className="flex items-baseline gap-1.5 mt-1">
                              <span className="font-bold text-indigo-600 text-sm">{formatPrice(displayPrice)}</span>
                              {hasDiscount && (
                                <span className="text-xs text-slate-400 line-through">{formatPrice(price)}</span>
                              )}
                            </div>
                            <QuantitySelector
                              qty={qty}
                              onIncrement={() => handleQtyInc(item._id)}
                              onDecrement={() => handleQtyDec(item._id)}
                              disableIncrease={true}
                            />
                          </div>

                          {/* Line total + remove */}
                          <div className="flex flex-col items-end justify-between shrink-0">
                            <motion.button
                              whileHover={{ scale: 1.15 }} whileTap={{ scale: 0.85 }}
                              onClick={() => handleRemoveCartItem(_id)}
                              className="p-1.5 rounded-lg hover:bg-rose-50 text-slate-300 hover:text-rose-500 transition-colors cursor-pointer">
                              <Trash2 size={15} />
                            </motion.button>
                            <span className="text-sm font-bold text-slate-700">
                              {formatPrice(displayPrice * qty)}
                            </span>
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
              <div className="border-t border-slate-100/60 p-4 bg-white/60 backdrop-blur-md space-y-3">
                <div className="flex justify-between items-center">
                  <span className="text-slate-500 text-sm font-medium">Subtotal</span>
                  <span className="text-slate-800 font-bold text-lg">{formatPrice(subtotal)}</span>
                </div>
                <p className="text-xs text-slate-400 text-center">Taxes & shipping calculated at checkout</p>
                <Link to="/checkout" onClick={handleGoToCheckout}>
                  <motion.button
                    whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}
                    disabled={isCartLoading}
                    className="w-full py-3 rounded-xl bg-linear-to-r from-indigo-600 to-sky-500 hover:from-indigo-700 hover:to-sky-600 text-white font-bold text-sm flex items-center justify-center gap-2 shadow-md shadow-indigo-300/40 transition-all cursor-pointer">
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
    <div className="flex items-center w-max bg-slate-100 rounded-full px-1 py-0.5 mt-2 gap-1">
      <motion.button whileTap={{ scale: 0.85 }} onClick={onDecrement}
        className="p-1 rounded-full hover:bg-white hover:shadow-sm transition-all cursor-pointer">
        <Minus className="w-3 h-3 text-slate-600" />
      </motion.button>
      <AnimatePresence mode="popLayout">
        <motion.span key={qty} initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.6, opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="w-6 text-center text-xs font-bold text-slate-800 select-none">{qty}</motion.span>
      </AnimatePresence>
      <motion.button
        whileTap={!disableIncrease ? { scale: 0.85 } : {}}
        onClick={disableIncrease ? () => toast.error('Only 1 item per product allowed.') : onIncrement}
        className={`p-1 rounded-full transition-all ${disableIncrease ? 'opacity-30 cursor-not-allowed' : 'hover:bg-white hover:shadow-sm cursor-pointer'}`}>
        <Plus className="w-3 h-3 text-slate-600" />
      </motion.button>
    </div>
  )
}