import React, { useState, useMemo, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { CheckCircle, Minus, Plus, CreditCard, DollarSign, Truck, MapPin, User, Mail, Phone, Home, Navigation, CreditCardIcon, X, Loader2, ChevronDown, ChevronUp } from "lucide-react";
import { useForm } from "react-hook-form";
import { useGlobal } from "../../contexts/GlobalContext";
import axios from "axios";
import { toast } from "react-toastify";
import { useNavigate } from "react-router-dom";
import { loadStripe } from '@stripe/stripe-js'
import Loader from "../common/Loader";

export default function Checkout() {

  const stripePromise = loadStripe("pk_test_51S0fa9AOCHgy4FXgLSOoaKPtariwAu7V28J1DQbxngB0JFfkgu6sa3lrW927fNt9R0cIEusKnXQvXitM9g9CHhVo004rZ7qzsA")

  const steps = ["Cart", "Shipping", "Payment"];
  const [currentStep, setCurrentStep] = useState(0);

  const [isProcessing, setIsProcessing] = useState(false);
  const navigate = useNavigate();
  
  // Tax and Shipping state
  const [taxConfig, setTaxConfig] = useState(null);
  const [sellerShippingMethods, setSellerShippingMethods] = useState({}); // { sellerId: { seller, methods } }
  const [selectedShippingPerSeller, setSelectedShippingPerSeller] = useState({}); // { sellerId: method }
  const [expandedSellers, setExpandedSellers] = useState({}); // { sellerId: boolean }


  const { cartItems, handleQtyInc, handleQtyDec, handleRemoveCartItem, isCartLoading,
    qtyUpdateId, fetchCart
  } = useGlobal();

  // Fetch tax configuration on mount
  useEffect(() => {
    fetchTaxConfig();
  }, []);

  // Fetch shipping methods when cart changes
  useEffect(() => {
    if (cartItems?.cart && cartItems.cart.length > 0) {
      fetchShippingMethods();
    }
  }, [cartItems?.cart?.length]);

  const fetchTaxConfig = async () => {
    try {
      const res = await axios.get(`${import.meta.env.VITE_API_URL}api/tax/config`);
      if (res.data.success) {
        setTaxConfig(res.data.taxConfig);
      }
    } catch (error) {
      console.error('Error fetching tax config:', error);
    }
  };

  const fetchShippingMethods = async () => {
    try {
      const cartItemsData = cartItems.cart.map(item => ({
        productId: item.product._id
      }));
      
      const res = await axios.post(
        `${import.meta.env.VITE_API_URL}api/shipping/cart`,
        { cartItems: cartItemsData }
      );
      
      if (res.data.success) {
        const shippingData = res.data.shippingMethods;
        setSellerShippingMethods(shippingData);
        
        // Set default shipping method for each seller - prefer free shipping
        const defaultSelections = {};
        Object.keys(shippingData).forEach(sellerId => {
          const methods = shippingData[sellerId].methods;
          if (methods.length > 0) {
            const freeShipping = methods.find(m => m.type === 'free');
            defaultSelections[sellerId] = freeShipping || methods[0];
          }
        });
        setSelectedShippingPerSeller(defaultSelections);
      }
    } catch (error) {
      console.error('Error fetching shipping methods:', error);
      toast.error('Failed to load shipping methods');
    }
  };

  // Calculate tax based on subtotal
  const calculateTax = (subtotal) => {
    if (!taxConfig || taxConfig.type === 'none') return 0;
    
    if (taxConfig.type === 'percentage') {
      return (subtotal * taxConfig.value) / 100;
    }
    
    if (taxConfig.type === 'fixed') {
      return taxConfig.value;
    }
    
    return 0;
  };

  // Get spin discount from localStorage
  const getSpinDiscount = () => {
    const spinResult = localStorage.getItem('spinResult');
    const spinTimestamp = localStorage.getItem('spinTimestamp');
    
    if (!spinResult || !spinTimestamp) return null;
    
    const now = new Date().getTime();
    const spinTime = parseInt(spinTimestamp);
    const hoursPassed = (now - spinTime) / (1000 * 60 * 60);
    
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

  const {
    register,
    handleSubmit,
    watch,
    trigger,
    formState: { errors, isSubmitting },
  } = useForm({
    mode: "all",
    reValidateMode: "onChange",
    defaultValues: {
      // Shipping
      fullName: "",
      email: "",
      phone: "",
      address: "",
      city: "",
      state: "",
      postalCode: "",
      country: "Pakistan",
      shippingMethod: "standard",
      instructions: "",
      // Payment
      paymentMethod: "stripe", // Default to Stripe
      // Billing address (optional)
      billingSameAsShipping: true,
      billingAddress: "",
      billingCity: "",
      billingState: "",
      billingPostalCode: "",
      billingCountry: "Pakistan",
    },
  });

  const paymentMethod = watch("paymentMethod");
  const selectedShipping = watch("shippingMethod");
  const billingSameAsShipping = watch("billingSameAsShipping");

  // Subtotal with spin discounts applied
  const subtotal = useMemo(() => {
    if (!cartItems?.cart) return 0;
    return cartItems.cart.reduce((total, item) => {
      const itemPrice = getDiscountedPrice(item.product);
      return total + (itemPrice * item.qty);
    }, 0);
  }, [cartItems]);
  
  // Calculate tax and shipping
  const tax = useMemo(() => calculateTax(subtotal), [subtotal, taxConfig]);
  
  // Calculate total shipping cost from all sellers
  const shippingCost = useMemo(() => {
    return Object.values(selectedShippingPerSeller).reduce((total, method) => {
      return total + (method?.cost || 0);
    }, 0);
  }, [selectedShippingPerSeller]);
  
  const totalAmount = subtotal + tax + shippingCost;
  
  // Group cart items by seller
  const cartItemsBySeller = useMemo(() => {
    if (!cartItems?.cart) return {};
    
    const grouped = {};
    cartItems.cart.forEach(item => {
      const sellerId = item.product.seller;
      if (!grouped[sellerId]) {
        grouped[sellerId] = [];
      }
      grouped[sellerId].push(item);
    });
    return grouped;
  }, [cartItems]);

  // Prevent Enter key from submitting the form
  const handleKeyDown = (e) => {
    if (e.key === "Enter") {
      if (currentStep !== steps.length - 1) {
        e.preventDefault();
      }
    }
  };

  // Next step with validation
  const nextStep = async () => {
    // CART step: ensure there's at least one item
    if (currentStep === 0) {
      if (!cartItems?.cart || cartItems.cart.length === 0) {
        toast.error("Your cart is empty. Add items to proceed.");
        return;
      }
      setCurrentStep((p) => p + 1);
      return;
    }

    // SHIPPING step: validate shipping related fields
    if (currentStep === 1) {
      const valid = await trigger([
        "fullName",
        "email",
        "phone",
        "address",
        "city",
        "state",
        "postalCode",
        "country",
      ]);
      if (!valid) return;
      
      // Validate shipping method is selected for all sellers
      const sellerIds = Object.keys(sellerShippingMethods);
      const hasAllShippingSelected = sellerIds.every(sellerId => selectedShippingPerSeller[sellerId]);
      
      if (!hasAllShippingSelected) {
        toast.error("Please select a shipping method for all sellers");
        return;
      }
      
      setCurrentStep((p) => p + 1);
      return;
    }


  };

  const prevStep = () => {
    if (currentStep > 0) setCurrentStep((p) => p - 1);
  };

  // Final form submit
  const onPlaceOrder = async (data) => {
    // Validate shipping method is selected for all sellers
    const sellerIds = Object.keys(sellerShippingMethods);
    const hasAllShippingSelected = sellerIds.every(sellerId => selectedShippingPerSeller[sellerId]);
    
    if (!hasAllShippingSelected) {
      toast.error("Please select a shipping method for all sellers");
      setIsProcessing(false);
      return;
    }
    
    setIsProcessing(true);
    console.log("cartItems::::", cartItems);

    // Get spin discount info
    const spinResult = getSpinDiscount();
    const spinSelectedProducts = JSON.parse(localStorage.getItem('spinSelectedProducts') || '[]');
    
    // Build seller shipping array
    const sellerShipping = Object.entries(selectedShippingPerSeller).map(([sellerId, method]) => ({
      seller: sellerId,
      shippingMethod: {
        name: method.type,
        price: method.cost,
        estimatedDays: method.deliveryDays
      }
    }));
    
    // Use first seller's shipping as primary (for backward compatibility)
    const primaryShipping = sellerShipping[0]?.shippingMethod || {
      name: 'standard',
      price: 0,
      estimatedDays: 5
    };
    
    const order = {
      orderItems: cartItems.cart.map((item) => {
        const discountedPrice = getDiscountedPrice(item.product);
        const originalPrice = item.product.discountedPrice || item.product.price;
        const hasSpinDiscount = spinResult && !spinResult.hasCheckedOut && spinSelectedProducts.includes(item.product._id);
        
        return {
          id: item.product._id,
          name: item.product.name,
          image: item.product.image,
          price: discountedPrice, // Use spin discounted price
          originalPrice: hasSpinDiscount ? originalPrice : undefined, // Store original price if spin discount applied
          hasSpinDiscount: hasSpinDiscount, // Flag for spin discount
          quantity: item.qty,
        };
      }),

      shippingInfo: {
        fullName: data.fullName,
        email: data.email,
        phone: data.phone,
        address: data.address,
        city: data.city,
        state: data.state,
        postalCode: data.postalCode,
        country: data.country || "Pakistan",
      },

      shippingMethod: {
        name: primaryShipping.name,
        price: primaryShipping.price,
        estimatedDays: primaryShipping.estimatedDays,
        seller: sellerShipping[0]?.seller
      },
      
      sellerShipping: sellerShipping, // Multi-seller shipping details

      orderSummary: {
        subtotal,
        shippingCost,
        tax,
        totalAmount,
      },

      paymentMethod:
        data.paymentMethod === "stripe"
          ? "stripe"
          : "cash_on_delivery",
    };
    
    // Add spin discount info if applicable
    if (spinResult && !spinResult.hasCheckedOut && spinSelectedProducts.length > 0) {
      order.spinDiscount = {
        applied: true,
        type: spinResult.type,
        value: spinResult.value,
        label: spinResult.label
      };
    }
    
    if (data.instructions !== '') order.instructions = data.instructions

    console.log("Order Object:", order);

    try {
      const stripe = await stripePromise
      const token = localStorage.getItem("jwtToken");
      const res = await axios.post(
        `${import.meta.env.VITE_API_URL}api/order/place`,
        { order },
        {
          headers: {
            Authorization: `Bearer ${token}`
          }
        }
      );

      console.log(res.data);
      toast.success(res.data.msg)

      if (order.paymentMethod == 'cash_on_delivery') {
        setIsProcessing(false);
        
        // Redirect to success page after a short delay
        setTimeout(() => {
          // Mark spin as used and clear cart AFTER redirect (so order summary doesn't update)
          const spinResult = JSON.parse(localStorage.getItem('spinResult') || '{}');
          spinResult.hasCheckedOut = true;
          localStorage.setItem('spinResult', JSON.stringify(spinResult));
          localStorage.removeItem('spinSelectedProducts');
          
          // Clear cart in background
          axios.delete(`${import.meta.env.VITE_API_URL}api/cart/clear`, {
            headers: { Authorization: `Bearer ${token}` }
          }).then(() => {
            fetchCart(); // Refresh cart state
          }).catch(error => {
            console.error('Error clearing cart:', error);
          });
          
          navigate('/success');
        }, 1500);
        return;
      }
      
      await stripe.redirectToCheckout({ sessionId: res.data.id })


    } catch (error) {
      if (order.paymentMethod === 'stripe') {
        console.error("Checkout session creation error:", error);
        toast.error(error.response?.data?.msg || "Server error while creating checkout session. Try again!");
      }
      else {
        console.error("Ordder placing error:", error);
        toast.error(error.response?.data?.msg || "Server error while placing Order. Try again!");
      }
      setIsProcessing(false);
    }
  };


  // // Helper function to complete order placement
  // const completeOrderPlacement = async (token) => {
  //   try {
  //     // This would be your actual order placement API call
  //     // For demonstration, we're using a timeout
  //     setTimeout(async () => {
  //       // Simulate API call

  //       // Clear cart after order placement
  //       const clearCartRes = await axios.delete(`${import.meta.env.VITE_API_URL}api/cart/clear`,
  //         {
  //           headers: {
  //             Authorization: `Bearer ${token}`
  //           }
  //         }
  //       );
  //       console.log(clearCartRes.data.msg);
  //       fetchCart();

  //       // Move to confirmation step
  //       // setCurrentStep(3);
  //       setIsProcessing(false);

  //       // Navigate to home after delay
  //       // setTimeout(() => {
  //       //   navigate('/');
  //       // }, 6000);
  //     }, 1500);
  //   } catch (error) {
  //     console.error("Order completion error:", error);
  //     toast.error("Failed to complete order. Please try again.");
  //     setIsProcessing(false);
  //   }
  // };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-6xl mx-auto">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-gray-900">Checkout</h1>
          <p className="mt-2 text-gray-600">Complete your purchase with confidence</p>
        </div>


        <div className="grid md:grid-cols-3 gap-8">
          <form
            className="md:col-span-2 bg-white rounded-xl shadow-lg p-6"


          >

            {/* Progress Steps */}
            <div className="mb-12">
              <div className="flex items-center justify-between relative">
                <div className="absolute top-1/2 left-0 right-0 h-1 bg-gray-200 transform -translate-y-1/2 -z-10"></div>
                <div
                  className="absolute top-1/2 left-0 h-1 bg-blue-600 transform -translate-y-1/2 -z-10 transition-all duration-500"
                  style={{ width: `${(currentStep / (steps.length - 1)) * 100}%` }}
                ></div>

                {steps.map((step, index) => (
                  <div key={step} className="flex flex-col items-center relative">
                    <div className={`w-10 h-10 rounded-full flex items-center justify-center border-2 ${index <= currentStep ? "bg-blue-600 border-blue-600 text-white" : "bg-white border-gray-300 text-gray-500"} transition-colors duration-300`}>
                      {index < currentStep ? (
                        <CheckCircle className="w-5 h-5" />
                      ) : (
                        <span>{index + 1}</span>
                      )}
                    </div>
                    <span className={`mt-2 text-sm font-medium ${index <= currentStep ? "text-blue-600" : "text-gray-500"}`}>
                      {step}
                    </span>
                  </div>
                ))}
              </div>
            </div>


            {/* Step Content */}
            <AnimatePresence mode="wait">
              <motion.div
                key={currentStep}
                initial={{ opacity: 0, x: 40 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -40 }}
                transition={{ duration: 0.35 }}
              >
                {/* CART STEP */}
                {currentStep === 0 && (
                  <div>
                    <h2 className="text-xl font-semibold mb-6 flex items-center gap-2">
                      <div className="p-2 bg-blue-100 rounded-full">
                        <Truck className="w-5 h-5 text-blue-600" />
                      </div>
                      Your Cart
                    </h2>

                    {
                      !cartItems?.cart || cartItems.cart.length === 0 ? (
                        <div className="text-center py-8">
                          <p className="text-gray-500">Your cart is empty</p>
                          <button
                            type="button"
                            className="mt-4 text-blue-600 hover:text-blue-800"
                            onClick={() => navigate('/')}
                          >
                            Continue Shopping
                          </button>
                        </div>
                      ) : (
                        <div className="space-y-4">
                          {cartItems.cart.map((item) => {
                            const { product, qty } = item;
                            const { _id, name, price, image, discountedPrice } = product;
                            
                            // Get spin discounted price
                            const itemPrice = getDiscountedPrice(product);
                            const originalPrice = discountedPrice || price;
                            const hasSpinDiscount = itemPrice < originalPrice;
                            
                            return (
                              <motion.div
                                key={item._id}
                                initial={{ opacity: 0, y: 10 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ duration: 0.3 }}
                                className="flex items-center relative justify-between p-4 border border-[lightgray] shadow-md shadow-[lightgray] rounded-lg"
                              >
                                <div className="flex items-center  gap-4">
                                  <AnimatePresence mode="wait">
                                    {
                                      qtyUpdateId === item._id && (
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
                                  <img
                                    className="h-16 w-16 rounded-lg object-cover"
                                    src={image}
                                    alt={name}
                                  />
                                  <div>
                                    <h4 className="font-medium text-gray-900">{name}</h4>
                                    {hasSpinDiscount && (
                                      <p className="text-xs text-green-600 font-semibold">🎉 Spin Discount Applied!</p>
                                    )}
                                    <p className="">
                                      <span className="font-bold text-gray-600">${itemPrice.toFixed(2)}</span>
                                      {hasSpinDiscount && (
                                        <span className="line-through text-gray-400 ml-2">${originalPrice.toFixed(2)}</span>
                                      )}
                                    </p>
                                    <QuantitySelector
                                      qty={qty}
                                      onIncrement={() => handleQtyInc(item._id)}
                                      onDecrement={() => handleQtyDec(item._id)}
                                    />
                                  </div>
                                </div>
                                <button
                                  onClick={() => {
                                    handleRemoveCartItem(_id)
                                  }}
                                  type="button"
                                  className="absolute cursor-pointer top-2 right-2">
                                  <X />
                                </button>
                              </motion.div>
                            );
                          })}
                        </div>
                      )}
                  </div>
                )}

                {/* SHIPPING STEP */}
                {currentStep === 1 && (
                  <div>
                    <h2 className="text-xl font-semibold mb-6 flex items-center gap-2">
                      <div className="p-2 bg-blue-100 rounded-full">
                        <MapPin className="w-5 h-5 text-blue-600" />
                      </div>
                      Shipping Information
                    </h2>

                    {
                      cartItems?.cart && cartItems.cart.length >= 1 ? (
                        <>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <InputField
                              icon={<User className="w-5 h-5  text-gray-400" />}
                              placeholder="Full Name"
                              {...register("fullName", { required: "Full name is required" })}
                              error={errors.fullName}
                            />
                            <InputField
                              icon={<Mail className="w-5 h-5  text-gray-400" />}
                              placeholder="Email"
                              type="email"
                              {...register("email", {
                                required: "Email is required",
                                pattern: { value: /^\S+@\S+$/i, message: "Invalid email" },
                              })}
                              error={errors.email}
                            />
                            <InputField
                              icon={<Phone className="w-5 h-5  text-gray-400" />}
                              placeholder="Phone"
                              type="tel"
                              {...register("phone", {
                                required: "Phone is required",
                                minLength: { value: 6, message: "Invalid phone" },
                              })}
                              error={errors.phone}
                            />
                            <InputField
                              icon={<Home className="w-5 h-5  text-gray-400" />}
                              placeholder="Address"
                              {...register("address", { required: "Address is required" })}
                              error={errors.address}
                            />
                            <InputField
                              placeholder="City"
                              {...register("city", { required: "City is required" })}
                              error={errors.city}
                            />
                            <InputField
                              placeholder="State"
                              {...register("state", { required: "State is required" })}
                              error={errors.state}
                            />
                            <InputField
                              placeholder="Postal Code"
                              {...register("postalCode", { required: "Postal code is required" })}
                              error={errors.postalCode}
                            />
                            <div className="md:col-span-2">
                              <InputField
                                placeholder="Country"
                                {...register("country")}
                                error={errors.country}
                              />
                            </div>
                          </div>

                          {/* Shipping Method Selection - Grouped by Seller */}
                          <div className="mt-6">
                            <label className="block text-sm font-medium text-gray-700 mb-3">
                              <div className="flex items-center gap-2">
                                <Truck className="w-5 h-5" />
                                Select Shipping Method
                              </div>
                            </label>
                            
                            {Object.keys(sellerShippingMethods).length === 0 ? (
                              <p className="text-gray-500 text-sm">Loading shipping options...</p>
                            ) : (
                              <>
                                {/* Info Message for Multi-Seller Orders */}
                                {Object.keys(sellerShippingMethods).length > 1 && (
                                  <div className="mb-4 p-4 bg-blue-50 border border-blue-200 rounded-lg">
                                    <div className="flex gap-3">
                                      <div className="flex-shrink-0">
                                        <svg className="w-5 h-5 text-blue-600" fill="currentColor" viewBox="0 0 20 20">
                                          <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
                                        </svg>
                                      </div>
                                      <div className="flex-1">
                                        <h4 className="text-sm font-semibold text-blue-900 mb-1">
                                          Multiple Seller's products in Your Cart!
                                        </h4>
                                        <p className="text-xs text-blue-800">
                                          Your items are from <span className="font-semibold">{Object.keys(sellerShippingMethods).length} different sellers</span>. 
                                          Each seller has their own shipping methods and costs. Please select a shipping method for each seller's products below.
                                        </p>
                                      </div>
                                    </div>
                                  </div>
                                )}
                                
                                <div className="space-y-6">
                                {Object.entries(sellerShippingMethods).map(([sellerId, { seller, methods }]) => {
                                  const sellerProducts = cartItemsBySeller[sellerId] || [];
                                  const isExpanded = expandedSellers[sellerId] === true; // Default to collapsed
                                  const hasMultipleProducts = sellerProducts.length > 1;
                                  
                                  return (
                                    <div key={sellerId} className="border border-gray-200 rounded-lg p-4 bg-gray-50">
                                      {/* Products from this Seller */}
                                      <div className="mb-3">
                                        {sellerProducts.length > 0 && (
                                          <div className="space-y-2">
                                            {/* Collapsed View - Summary with Remove All */}
                                            {!isExpanded && (
                                              <div className="flex items-center justify-between p-3 bg-white rounded-lg">
                                                <div className="flex items-center gap-3">
                                                  <div className="relative">
                                                    <img
                                                      className="h-12 w-12 rounded object-cover"
                                                      src={sellerProducts[0].product.image}
                                                      alt={sellerProducts[0].product.name}
                                                    />
                                                    {sellerProducts.length > 1 && (
                                                      <div className="absolute -top-1 -right-1 bg-blue-600 text-white text-xs font-bold rounded-full w-5 h-5 flex items-center justify-center">
                                                        {sellerProducts.length}
                                                      </div>
                                                    )}
                                                  </div>
                                                  <div>
                                                    <p className="font-medium text-sm text-gray-900">
                                                      {sellerProducts.length === 1 
                                                        ? sellerProducts[0].product.name
                                                        : `${sellerProducts.length} items`
                                                      }
                                                    </p>
                                                    <p className="text-xs text-gray-500">
                                                      Total: ${sellerProducts.reduce((sum, item) => 
                                                        sum + (getDiscountedPrice(item.product) * item.qty), 0
                                                      ).toFixed(2)}
                                                    </p>
                                                  </div>
                                                </div>
                                                <button
                                                  type="button"
                                                  onClick={async () => {
                                                    // Remove all products from this seller sequentially
                                                    for (const item of sellerProducts) {
                                                      await handleRemoveCartItem(item.product._id);
                                                    }
                                                  }}
                                                  className="text-gray-400 hover:text-red-600 transition-colors"
                                                  title="Remove all items"
                                                >
                                                  <X className="w-5 h-5" />
                                                </button>
                                              </div>
                                            )}
                                            
                                            {/* Expanded View - All Products with Individual Remove */}
                                            <AnimatePresence>
                                              {isExpanded && (
                                                <motion.div
                                                  initial={{ opacity: 0, height: 0 }}
                                                  animate={{ opacity: 1, height: 'auto' }}
                                                  exit={{ opacity: 0, height: 0 }}
                                                  transition={{ duration: 0.2 }}
                                                  className="space-y-2"
                                                >
                                                  {sellerProducts.map((item) => {
                                                    const itemPrice = getDiscountedPrice(item.product);
                                                    const originalPrice = item.product.discountedPrice || item.product.price;
                                                    const hasSpinDiscount = itemPrice < originalPrice;
                                                    
                                                    return (
                                                      <div key={item._id} className="flex items-center gap-3 p-2 bg-white rounded-lg relative">
                                                        <img
                                                          className="h-12 w-12 rounded object-cover"
                                                          src={item.product.image}
                                                          alt={item.product.name}
                                                        />
                                                        <div className="flex-1">
                                                          <p className="font-medium text-sm text-gray-900">{item.product.name}</p>
                                                          <p className="text-xs text-gray-500">Qty: {item.qty}</p>
                                                        </div>
                                                        <div className="text-right">
                                                          <span className="font-semibold text-sm">${(itemPrice * item.qty).toFixed(2)}</span>
                                                          {hasSpinDiscount && (
                                                            <p className="text-xs text-gray-500 line-through">${(originalPrice * item.qty).toFixed(2)}</p>
                                                          )}
                                                        </div>
                                                        <button
                                                          type="button"
                                                          onClick={() => handleRemoveCartItem(item.product._id)}
                                                          className="absolute top-2 right-2 text-gray-400 hover:text-red-600 transition-colors"
                                                        >
                                                          <X className="w-4 h-4" />
                                                        </button>
                                                      </div>
                                                    );
                                                  })}
                                                </motion.div>
                                              )}
                                            </AnimatePresence>
                                            
                                            {/* Expand/Collapse Button */}
                                            <button
                                              type="button"
                                              onClick={() => setExpandedSellers(prev => ({
                                                ...prev,
                                                [sellerId]: !isExpanded
                                              }))}
                                              className="w-full flex items-center justify-center gap-2 py-2 text-sm text-blue-600 hover:text-blue-700 font-medium"
                                            >
                                              {isExpanded ? (
                                                <>
                                                  <ChevronUp className="w-4 h-4" />
                                                  Collapse
                                                </>
                                              ) : (
                                                <>
                                                  <ChevronDown className="w-4 h-4" />
                                                  {sellerProducts.length === 1 ? 'View details' : `View all ${sellerProducts.length} items`}
                                                </>
                                              )}
                                            </button>
                                          </div>
                                        )}
                                      </div>
                                    
                                    {/* Shipping Options for these Products */}
                                    <div className="space-y-2 pt-3 border-t border-gray-300">
                                      <div className="flex items-center justify-between mb-2">
                                        <p className="text-xs font-medium text-gray-600">Choose shipping method:</p>
                                        <p className="text-xs text-gray-500">
                                          {methods.length === 1 
                                            ? '1 method available'
                                            : `${methods.length} methods available`
                                          }
                                        </p>
                                      </div>
                                      {methods.map((method) => (
                                        <motion.div
                                          key={method.type}
                                          whileHover={{ scale: 1.01 }}
                                          onClick={() => setSelectedShippingPerSeller(prev => ({
                                            ...prev,
                                            [sellerId]: method
                                          }))}
                                          className={`border-2 rounded-lg p-3 cursor-pointer transition-all ${
                                            selectedShippingPerSeller[sellerId]?.type === method.type
                                              ? 'border-blue-600 bg-blue-50 ring-2 ring-blue-100'
                                              : 'border-gray-300 hover:border-gray-400 bg-white'
                                          }`}
                                        >
                                          <div className="flex justify-between items-center">
                                            <div className="flex items-center gap-3">
                                              <div className={`p-2 rounded-full ${
                                                selectedShippingPerSeller[sellerId]?.type === method.type
                                                  ? 'bg-blue-100 text-blue-600'
                                                  : 'bg-gray-100 text-gray-600'
                                              }`}>
                                                <Truck className="w-4 h-4" />
                                              </div>
                                              <div>
                                                <div className="flex items-center gap-2">
                                                  <h5 className="font-medium capitalize text-sm">
                                                    {method.type} Shipping
                                                  </h5>
                                                  {method.type === 'free' && (
                                                    <span className="px-2 py-0.5 text-xs font-semibold bg-green-100 text-green-700 rounded-full">
                                                      Recommended
                                                    </span>
                                                  )}
                                                </div>
                                                <p className="text-xs text-gray-500">
                                                  Delivery in {method.deliveryDays} {method.deliveryDays === 1 ? 'day' : 'days'}
                                                </p>
                                              </div>
                                            </div>
                                            <span className="font-semibold">
                                              ${method.cost.toFixed(2)}
                                            </span>
                                          </div>
                                        </motion.div>
                                      ))}
                                    </div>
                                  </div>
                                  );
                                })}
                              </div>
                              </>
                            )}
                          </div>

                          <div className="mt-6">
                            <label className="block text-sm font-medium text-gray-700 mb-2">Delivery Instructions (Optional)</label>
                            <textarea
                              placeholder="Any special delivery instructions?"
                              className="w-full h-24 border rounded-lg px-4 py-3 focus:border-blue-600 outline-none resize-none"
                              {...register("instructions")}
                            />
                          </div>
                        </>
                      ) : (
                        <div className="text-center py-8">
                          <p className="text-gray-500">Your cart is empty</p>
                        </div>
                      )
                    }
                  </div>
                )}

                {/* PAYMENT STEP */}
                {currentStep === 2 && (
                  <div>
                    <h2 className="text-xl font-semibold mb-6 flex items-center gap-2">
                      <div className="p-2 bg-blue-100 rounded-full">
                        <CreditCard className="w-5 h-5 text-blue-600" />
                      </div>
                      Payment Method
                    </h2>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
                      <PaymentOption
                        value="stripe"
                        title="Credit/Debit Card"
                        description="Pay securely with Stripe"
                        icon={<CreditCardIcon className="w-6 h-6" />}
                        selected={paymentMethod === "stripe"}
                        {...register("paymentMethod")}
                      />
                      <PaymentOption
                        value="cash_on_delivery"
                        title="Cash on Delivery"
                        description="Pay when you receive your order"
                        icon={<DollarSign className="w-6 h-6" />}
                        selected={paymentMethod === "cash_on_delivery"}
                        {...register("paymentMethod")}
                      />
                    </div>

                    {paymentMethod === "stripe" && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.3 }}
                        className="bg-blue-50 p-4 rounded-lg mb-6"
                      >
                        <p className="text-blue-800 text-sm">
                          You will be redirected to Stripe's secure payment page to complete your transaction.
                        </p>
                      </motion.div>
                    )}

                    {/* Billing Address Section */}
                    <div className="mt-6">
                      <div className="flex items-center mb-4">
                        <input
                          type="checkbox"
                          id="billingSameAsShipping"
                          className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                          {...register("billingSameAsShipping")}
                        />
                        <label htmlFor="billingSameAsShipping" className="ml-2 block text-sm text-gray-900">
                          Billing address same as shipping address
                        </label>
                      </div>

                      {!billingSameAsShipping && (
                        <motion.div
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: "auto" }}
                          transition={{ duration: 0.3 }}
                          className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4"
                        >
                          <h3 className="md:col-span-2 text-lg font-semibold mb-2">Billing Address</h3>
                          <InputField
                            placeholder="Billing Address"
                            {...register("billingAddress", {
                              required: !billingSameAsShipping && "Billing address is required"
                            })}
                            error={errors.billingAddress}
                          />
                          <InputField
                            placeholder="Billing City"
                            {...register("billingCity", {
                              required: !billingSameAsShipping && "Billing city is required"
                            })}
                            error={errors.billingCity}
                          />
                          <InputField
                            placeholder="Billing State"
                            {...register("billingState", {
                              required: !billingSameAsShipping && "Billing state is required"
                            })}
                            error={errors.billingState}
                          />
                          <InputField
                            placeholder="Billing Postal Code"
                            {...register("billingPostalCode", {
                              required: !billingSameAsShipping && "Billing postal code is required"
                            })}
                            error={errors.billingPostalCode}
                          />
                          <div className="md:col-span-2">
                            <InputField
                              placeholder="Billing Country"
                              {...register("billingCountry")}
                              error={errors.billingCountry}
                            />
                          </div>
                        </motion.div>
                      )}
                    </div>
                  </div>
                )}


              </motion.div>
            </AnimatePresence>

            {/* Navigation Buttons */}
            {currentStep < steps.length && (
              <div className="flex justify-between mt-8">
                <button
                  type="button"
                  onClick={prevStep}
                  disabled={currentStep === 0 || isProcessing}
                  className={`px-6 py-3 rounded-lg font-medium flex items-center gap-2 ${currentStep === 0 || isProcessing
                    ? "bg-gray-200 text-gray-500 cursor-not-allowed"
                    : "bg-blue-600 text-white hover:bg-blue-700"
                    } transition-colors`}
                >
                  <Navigation className="w-5 h-5 rotate-180" />
                  Back
                </button>

                {currentStep === steps.length - 1 ? (
                  <button
                    type="button"
                    onClick={handleSubmit(onPlaceOrder)}
                    disabled={isSubmitting || isProcessing || !cartItems?.cart || cartItems.cart.length == 0}
                    className="px-6 py-3 rounded-lg font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:bg-blue-400 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
                  >
                    {isProcessing ? (
                      <>
                        <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                        Processing...
                      </>
                    ) : paymentMethod === "cash_on_delivery" ? (
                      <>
                        <CheckCircle className="w-5 h-5" />
                        Place Order
                      </>
                    ) : (
                      <>
                        <CreditCard className="w-5 h-5" />
                        Pay Securely
                      </>
                    )}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={nextStep}
                    disabled={!cartItems?.cart || cartItems.cart.length == 0}
                    className={`px-6 py-3 rounded-lg font-medium flex items-center gap-2 ${!cartItems?.cart || cartItems.cart.length === 0
                      ? "bg-gray-200 text-gray-500 cursor-not-allowed"
                      : "bg-blue-600 text-white hover:bg-blue-700"
                      } transition-colors`}
                  >
                    Next
                    <Navigation className="w-5 h-5" />
                  </button>
                )}
              </div>
            )}
          </form>

          {/* Order Summary */}
          <div className="md:col-span-1">
            <div className="sticky top-6 bg-white rounded-xl shadow-lg p-6">
              <h3 className="text-lg font-semibold mb-4 pb-2 border-b">Order Summary</h3>

              <div className="max-h-80 overflow-y-auto mb-4">
                {cartItems.cart.map((item) => {
                  const itemPrice = getDiscountedPrice(item.product);
                  const originalPrice = item.product.discountedPrice || item.product.price;
                  const hasSpinDiscount = itemPrice < originalPrice;
                  
                  return (
                    <div key={item._id} className="flex items-center justify-between py-3 border-b">
                      <div className="flex items-center gap-3">
                        <img
                          className="h-12 w-12 rounded object-cover"
                          src={item.product.image}
                          alt={item.product.name}
                        />
                        <div>
                          <p className="font-medium text-sm">{item.product.name}</p>
                          <p className="text-gray-500 text-sm">Qty: {item.qty}</p>
                          {hasSpinDiscount && (
                            <p className="text-xs text-green-600 font-semibold">🎉 Spin Discount Applied!</p>
                          )}
                        </div>
                      </div>
                      <div className="text-right">
                        <span className="font-semibold">${(itemPrice * item.qty).toFixed(2)}</span>
                        {hasSpinDiscount && (
                          <p className="text-xs text-gray-500 line-through">${(originalPrice * item.qty).toFixed(2)}</p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="space-y-3 pt-2">
                <div className="flex justify-between text-gray-700">
                  <span>Subtotal</span>
                  <span className="font-medium">${subtotal.toFixed(2)}</span>
                </div>
                
                {/* Shipping breakdown by seller */}
                {Object.keys(selectedShippingPerSeller).length > 0 && (
                  <div className="space-y-1">
                    <div className="flex justify-between text-gray-700 font-medium">
                      <span>Shipping</span>
                      <span>${shippingCost.toFixed(2)}</span>
                    </div>
                    {Object.entries(selectedShippingPerSeller).map(([sellerId, method]) => {
                      const sellerInfo = sellerShippingMethods[sellerId];
                      return (
                        <div key={sellerId} className="flex justify-between text-xs text-gray-500 pl-4">
                          <span className="capitalize">
                            {method.type} shipping
                          </span>
                          <span>${method.cost.toFixed(2)}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
                
                {tax > 0 && (
                  <div className="flex justify-between text-gray-700">
                    <span>
                      Tax {taxConfig?.type === 'percentage' && `(${taxConfig.value}%)`}
                    </span>
                    <span className="font-medium">${tax.toFixed(2)}</span>
                  </div>
                )}
                
                <div className="flex justify-between text-lg font-semibold border-t pt-3">
                  <span>Total</span>
                  <span className="text-blue-600">${totalAmount.toFixed(2)}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- Subcomponents ---------- */

const InputField = React.forwardRef(({ icon, error, ...props }, ref) => (
  <div className="relative">
    <div className="relative">
      {icon && (
        <div className="absolute inset-y-0 right-2 pl-3 flex items-center pointer-events-none">
          {icon}
        </div>
      )}

      <input
        ref={ref}
        className={`w-full border rounded-lg px-4 py-3 focus:border-blue-600 outline-none ${icon ? "pl-10" : ""} ${error ? "border-red-500" : ""}`}
        {...props}
      />
    </div>
    {error?.message && (
      <p className="text-xs text-red-500 mt-1">{String(error.message)}</p>
    )}
  </div>
));

function QuantitySelector({ qty, onIncrement, onDecrement }) {
  return (
    <div className="flex items-center bg-gray-100 w-max rounded-lg px-2 py-1 mt-2">
      <motion.button
        type="button"
        whileTap={{ scale: 0.9 }}
        onClick={onDecrement}
        className="p-1 rounded-lg hover:bg-gray-200 transition-colors"
        aria-label="Decrease quantity"
      >
        <Minus className="w-4 h-4 text-gray-600" />
      </motion.button>
      <AnimatePresence mode="popLayout">
        <motion.span
          key={qty}
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          exit={{ scale: 0 }}
          transition={{ duration: 0.2 }}
          className="px-4 text-sm font-medium text-gray-900 select-none"
        >
          {qty}
        </motion.span>
      </AnimatePresence>
      <motion.button
        type="button"
        whileTap={{ scale: 0.9 }}
        onClick={onIncrement}
        className="p-1 rounded-lg hover:bg-gray-200 transition-colors"
        aria-label="Increase quantity"
      >
        <Plus className="w-4 h-4 text-gray-600" />
      </motion.button>
    </div>
  );
}

const ShippingOption = React.forwardRef(({ value, title, price, days, selected, ...props }, ref) => (
  <label className={`border rounded-lg p-4 cursor-pointer transition-all ${selected ? "border-blue-600 bg-blue-50 ring-2 ring-blue-100" : "border-gray-300 hover:border-gray-400"}`}>
    <input
      type="radio"
      value={value}
      ref={ref}
      className="sr-only"
      {...props}
    />
    <div className="flex justify-between items-start">
      <div>
        <h4 className="font-medium">{title}</h4>
        <p className="text-sm text-gray-500 mt-1">{days}</p>
      </div>
      <span className="font-semibold">${price.toFixed(2)}</span>
    </div>
  </label>
));

const PaymentOption = React.forwardRef(({ value, title, description, icon, selected, ...props }, ref) => (
  <label className={`border rounded-lg p-4 cursor-pointer transition-all ${selected ? "border-blue-600 bg-blue-50 ring-2 ring-blue-100" : "border-gray-300 hover:border-gray-400"}`}>
    <input
      type="radio"
      value={value}
      ref={ref}
      className="sr-only"
      {...props}
    />
    <div className="flex items-start gap-3">
      <div className={`p-2 rounded-full ${selected ? "bg-blue-100 text-blue-600" : "bg-gray-100 text-gray-600"}`}>
        {icon}
      </div>
      <div>
        <h4 className="font-medium">{title}</h4>
        <p className="text-sm text-gray-500 mt-1">{description}</p>
      </div>
    </div>
  </label>
));