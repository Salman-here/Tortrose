// src/components/CartDropdown.jsx
import React, { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowBigRightDash, CarIcon, CatIcon, ChevronRight, Cross, Loader2, Minus, MoveRight, Plus, ShoppingCart, SquareArrowRight, X } from "lucide-react";
import { useGlobal } from "../../contexts/GlobalContext";
import { useAuth } from "../../contexts/AuthContext";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "react-toastify";
import Loader from '../common/Loader'

const CartDropdown = () => {

  const {
    fetchCart,
    cartItems,
    handleQtyInc,
    handleQtyDec,
    isOpen,
    setIsOpen,
    dropdownRef,
    toggleCart,
    handleRemoveCartItem,
    isCartLoading,
    qtyUpdateId
  } = useGlobal()

  const {
    currentUser
  } = useAuth()
  const navigate = useNavigate()

  const handleGoToCheckout = () => {
    if (cartItems.cart.length == 0) return toast.error('No items in the cart')
  }

  // Get spin discount from localStorage
  const getSpinDiscount = () => {
    const spinResult = localStorage.getItem('spinResult');
    const spinTimestamp = localStorage.getItem('spinTimestamp');
    
    if (!spinResult || !spinTimestamp) return null;
    
    const now = new Date().getTime();
    const spinTime = parseInt(spinTimestamp);
    const hoursPassed = (now - spinTime) / (1000 * 60 * 60);
    
    // Check if spin is still valid (less than 24 hours)
    if (hoursPassed >= 24) {
      localStorage.removeItem('spinResult');
      localStorage.removeItem('spinTimestamp');
      localStorage.removeItem('spinSelectedProducts');
      return null;
    }
    
    return JSON.parse(spinResult);
  };

  // Calculate discounted price for a product
  const getDiscountedPrice = (product) => {
    const spinResult = getSpinDiscount();
    const spinSelectedProducts = JSON.parse(localStorage.getItem('spinSelectedProducts') || '[]');
    
    // Don't apply discount if spin is checked out or product not selected
    if (!spinResult || spinResult.hasCheckedOut || !spinSelectedProducts.includes(product._id)) {
      return product.discountedPrice || product.price;
    }
    
    let discountedPrice = product.price;
    
    if (spinResult.type === 'free') {
      discountedPrice = 0;
    } else if (spinResult.type === 'fixed') {
      discountedPrice = spinResult.value;
    } else if (spinResult.type === 'percentage') {
      discountedPrice = product.price * (1 - spinResult.value / 100);
    }
    
    return Math.max(0, discountedPrice);
  };


  return (
    <div ref={dropdownRef}>
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, x: '100%' }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: '100%' }}
            transition={{ duration: 0.2, ease: 'easeIn' }}
            className="w-[350px] h-screen p-2 fixed top-0 right-0 bg-white shadow-xl rounded-xl z-50 overflow-hidden"
          >
            <button
              onClick={toggleCart}
              className="w-full button flex py-1 justify-center items-center cursor-pointer">
              <ChevronRight size={35} />
            </button>
            <div className="p-4 border-b font-semibold border-[lightgray] text-gray-800">Your Cart</div>
            <div className=" h-[70%] overflow-y-auto divide-y-[1px] divide-[lightgray]">
              {
                !currentUser || cartItems.cart.length == 0 ? (
                  <p className="text-[gray] ml-4 mt-2">
                    No items in the cart
                  </p>
                ) :
                  isCartLoading ? (<div className="w-full h-full flex justify-center items-center">
                    <Loader />
                  </div>) :
                  cartItems.cart.map((item, index) => {
                    const {product, qty, _id: id } = item
              const {
                _id,
                name,
                price,
                discountedPrice,
                image,
                    } = product
              // console.log(_id);


              return (
              <div key={index} className="relative p-4 flex justify-between items-center">
                <AnimatePresence mode="wait">
                  {
                    qtyUpdateId === id && (
                      <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="w-full h-full  absolute backdrop-blur-lg text-blue-900 top-0 left-0 z-2 flex justify-center items-center gap-1 rounded ">
                        Processing <span className="animate-spin"> <Loader2 /> </span>
                      </motion.div>
                    )
                  }
                </AnimatePresence>
                <div className=" flex flex-col">
                  <div className=" flex">

                    <img
                      className="h-[50px] w-[50px] mr-2 rounded object-cover object-center"
                      src={image} alt="" />
                    <div>

                      <h4 className="font-medium text-gray-900">{name}</h4>
                      <QuantitySelector 
                        qty={qty} 
                        onIncrement={() => { handleQtyInc(item._id) }} 
                        onDecrement={() => { handleQtyDec(item._id) }}
                        disableIncrease={true}
                      />

                    </div>
                    <motion.button
                      whileHover={{ scale: 1.2 }}
                      whileTap={{ scale: 0.8 }}
                      onClick={() => {
                        handleRemoveCartItem(_id)
                      }}
                      className="absolute cursor-pointer top-2 right-2">
                      <X size={20} />
                    </motion.button>

                  </div>

                </div>
                <div className="flex flex-col items-end">
                  <span className="font-semibold text-gray-800">${getDiscountedPrice(product).toFixed(2)}</span>
                  {getDiscountedPrice(product) < (discountedPrice || price) && (
                    <span className="text-xs text-gray-500 line-through">${(discountedPrice || price).toFixed(2)}</span>
                  )}
                </div>
              </div>
              )
                  }

                  )}
            </div>
            <div className="p-4 border-t border-[lightgray] flex justify-between items-center">
              <div className=" text-white w-max text-[15px] bg-[#b64141] px-4 py-2 rounded transition">
                <span className="font-semibold">
                  Subtotal: ${
                    cartItems.cart.reduce((total, item) => {
                      const itemPrice = getDiscountedPrice(item.product);
                      return total + (itemPrice * item.qty);
                    }, 0).toFixed(2)
                  }
                </span>
              </div>

              <button
                disabled={isCartLoading}
                className="button text-white px-4 py-2 rounded transition">
                <Link
                  onClick={handleGoToCheckout} to={'/checkout'}>
                  Checkout
                </Link>
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div >
  );
};

export default CartDropdown;

function QuantitySelector({ qty, onIncrement, onDecrement, disableIncrease = false }) {
  return (
    <div className="flex items-center bg-white/70 backdrop-blur-md  w-max border-gray-200 rounded-full px-2 py-1 mt-2 shadow-sm">
      {/* Decrement Button */}
      <motion.p
        whileTap={{ scale: 0.9 }}
        onClick={onDecrement}
        className="p-1 rounded-full hover:bg-gray-200 transition-colors cursor-pointer"
      >
        <Minus className="w-4 h-4 text-gray-600" />
      </motion.p>

      {/* Qty Number with Animation */}
      <AnimatePresence mode="popLayout">
        <motion.span
          key={qty}
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          exit={{ scale: 0 }}
          transition={{ duration: 0.2, ease: 'easeIn' }}
          className="px-4 text-sm font-medium text-gray-900 select-none"
        >
          {qty}
        </motion.span>
      </AnimatePresence>

      {/* Increment Button - Disabled */}
      <motion.p
        whileTap={!disableIncrease ? { scale: 0.9 } : {}}
        onClick={disableIncrease ? () => toast.error('Quantity increase is disabled. Only 1 item per product allowed.') : onIncrement}
        className={`p-1 rounded-full transition-colors ${
          disableIncrease 
            ? 'opacity-40 cursor-not-allowed' 
            : 'hover:bg-gray-200 cursor-pointer'
        }`}
      >
        <Plus className="w-4 h-4 text-gray-600" />
      </motion.p>
    </div>
  );
}