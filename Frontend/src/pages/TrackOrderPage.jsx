import React, { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Search, Package, Truck, CheckCircle, Clock, XCircle, Mail, Hash, ChevronDown, ChevronUp } from "lucide-react";
import axios from "axios";
import { toast } from "react-toastify";
import { useCurrency } from "../contexts/CurrencyContext";
import SEOHead from "../components/common/SEOHead";
import {
  formatOrderItemOptions,
  getOrderCurrency,
  getOrderItemLineSubtotal,
  getOrderSellerGroups,
  getOrderTotal,
  hasExactOrderItemUnitEquation,
} from "../utils/orderItems";
import BuyerSellerFulfillmentGroups from "../components/order/BuyerSellerFulfillmentGroups";

const statusSteps = ["pending", "confirmed", "processing", "shipped", "delivered"];
const statusConfig = {
  pending: { icon: Clock, color: "#f59e0b", label: "Pending" },
  confirmed: { icon: CheckCircle, color: "#22c55e", label: "Confirmed" },
  processing: { icon: Package, color: "#3b82f6", label: "Processing" },
  shipped: { icon: Truck, color: "#8b5cf6", label: "Shipped" },
  delivered: { icon: CheckCircle, color: "#22c55e", label: "Delivered" },
  cancelled: { icon: XCircle, color: "#ef4444", label: "Cancelled" },
};

export default function TrackOrderPage() {
  return (
    <>
      <SEOHead
        title="Track Your Order - Order Status Lookup"
        description="Track your Rozare order status. Enter your email and order ID to view order status, shipping updates when available, and seller-provided delivery details."
        canonical="/track-order"
        keywords="track order, order tracking, rozare order tracking, track my order, order status, shipping status, delivery updates, where is my order, order updates, rozare tracking"
      />
      <TrackOrderContent />
    </>
  );
}

function TrackOrderContent() {
  const [email, setEmail] = useState("");
  const [orderId, setOrderId] = useState("");
  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [showItems, setShowItems] = useState(false);
  const { formatPrice } = useCurrency();
  const orderMoney = (amount) => {
    const orderCurrency = getOrderCurrency(order);
    return formatPrice(amount, {
      sourceCurrency: orderCurrency,
      targetCurrency: orderCurrency,
      showCode: true,
    });
  };

  const handleTrack = async (e) => {
    e.preventDefault();
    if (!email.trim() || !orderId.trim()) {
      toast.error("Please enter both email and order ID");
      return;
    }
    setLoading(true);
    setSearched(true);
    try {
      const res = await axios.get(
        `${import.meta.env.VITE_API_URL}api/order/track?email=${encodeURIComponent(email)}&orderId=${encodeURIComponent(orderId)}`
      );
      setOrder(res.data.order);
    } catch (err) {
      setOrder(null);
      toast.error(err.response?.data?.msg || "Order not found");
    } finally {
      setLoading(false);
    }
  };

  const currentStepIndex = order ? statusSteps.indexOf(order.orderStatus) : -1;
  const isCancelled = order?.orderStatus === "cancelled";
  const sellerGrouping = (() => {
    if (!order) return { groups: [], invalid: false };
    try {
      return { groups: getOrderSellerGroups(order), invalid: false };
    } catch (_) {
      return { groups: [], invalid: true };
    }
  })();

  return (
    <div className="min-h-[70vh] py-8 px-4">
      <div className="max-w-2xl mx-auto">
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
          <h1 className="text-3xl font-bold mb-2" style={{ color: "hsl(var(--foreground))" }}>
            Track Your Order
          </h1>
          <p className="mb-8" style={{ color: "hsl(var(--muted-foreground))" }}>
            Enter your email and order ID to check your order status
          </p>

          <form onSubmit={handleTrack} className="glass-panel p-6 mb-8">
            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium mb-1.5 flex items-center gap-2" style={{ color: "hsl(var(--foreground))" }}>
                  <Mail className="w-4 h-4" /> Email Address
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="your@email.com"
                  className="w-full px-4 py-3 rounded-xl glass-inner outline-none text-sm"
                  style={{ color: "hsl(var(--foreground))" }}
                  required
                />
              </div>
              <div>
                <label className="text-sm font-medium mb-1.5 flex items-center gap-2" style={{ color: "hsl(var(--foreground))" }}>
                  <Hash className="w-4 h-4" /> Order ID
                </label>
                <input
                  type="text"
                  value={orderId}
                  onChange={(e) => setOrderId(e.target.value)}
                  placeholder="ORD-1234567890"
                  className="w-full px-4 py-3 rounded-xl glass-inner outline-none text-sm"
                  style={{ color: "hsl(var(--foreground))" }}
                  required
                />
              </div>
              <motion.button
                type="submit"
                disabled={loading}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                className="w-full py-3 rounded-xl font-semibold text-white flex items-center justify-center gap-2"
                style={{ background: "linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))" }}
              >
                {loading ? (
                  <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                ) : (
                  <>
                    <Search className="w-4 h-4" /> Track Order
                  </>
                )}
                {sellerGrouping.groups.length > 1 && (
                  <p className="text-xs text-center -mt-3" style={{ color: "hsl(var(--muted-foreground))" }}>
                    Overall status follows the least-advanced active seller shipment. See each store below for its exact progress.
                  </p>
                )}
              </motion.button>
            </div>
          </form>

          <AnimatePresence>
            {order && (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className="glass-panel p-6 space-y-6"
              >
                {/* Order Header */}
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs" style={{ color: "hsl(var(--muted-foreground))" }}>Order ID</p>
                    <p className="text-lg font-bold" style={{ color: "hsl(var(--primary))" }}>{order.orderId}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs" style={{ color: "hsl(var(--muted-foreground))" }}>Total</p>
                    <p className="text-lg font-bold" style={{ color: "hsl(var(--foreground))" }}>
                      {orderMoney(getOrderTotal(order))}
                    </p>
                  </div>
                </div>

                {/* Status Progress */}
                {isCancelled ? (
                  <div className="flex items-center justify-center gap-3 py-4 glass-inner rounded-xl">
                    <XCircle className="w-8 h-8" style={{ color: "#ef4444" }} />
                    <span className="text-lg font-semibold" style={{ color: "#ef4444" }}>Order Cancelled</span>
                  </div>
                ) : (
                  <div className="py-4">
                    <div className="flex items-center justify-between relative">
                      {/* Progress line */}
                      <div className="absolute top-5 left-0 right-0 h-0.5" style={{ background: "hsl(var(--border))" }} />
                      <div
                        className="absolute top-5 left-0 h-0.5 transition-all duration-500"
                        style={{
                          width: `${(currentStepIndex / (statusSteps.length - 1)) * 100}%`,
                          background: "linear-gradient(90deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))",
                        }}
                      />
                      {statusSteps.map((step, i) => {
                        const cfg = statusConfig[step];
                        const Icon = cfg.icon;
                        const isActive = i <= currentStepIndex;
                        return (
                          <div key={step} className="relative flex flex-col items-center z-10">
                            <div
                              className="w-10 h-10 rounded-full flex items-center justify-center transition-all"
                              style={{
                                background: isActive ? cfg.color : "hsl(var(--muted))",
                                color: isActive ? "#fff" : "hsl(var(--muted-foreground))",
                              }}
                            >
                              <Icon className="w-5 h-5" />
                            </div>
                            <span
                              className="text-xs mt-2 font-medium"
                              style={{ color: isActive ? "hsl(var(--foreground))" : "hsl(var(--muted-foreground))" }}
                            >
                              {cfg.label}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Shipping Info */}
                <div className="glass-inner rounded-xl p-4">
                  <h3 className="text-sm font-semibold mb-2" style={{ color: "hsl(var(--foreground))" }}>Shipping To</h3>
                  <p className="text-sm" style={{ color: "hsl(var(--muted-foreground))" }}>
                    {order.shippingInfo.fullName}<br />
                    {order.shippingInfo.address}, {order.shippingInfo.city}<br />
                    {order.shippingInfo.state} {order.shippingInfo.postalCode}, {order.shippingInfo.country}
                  </p>
                </div>

                {/* Seller-owned shipment groups */}
                <BuyerSellerFulfillmentGroups order={order} formatMoney={orderMoney} />

                {/* Legacy orders without immutable seller snapshots */}
                {sellerGrouping.groups.length === 0 && !sellerGrouping.invalid && <div>
                  <button
                    onClick={() => setShowItems(!showItems)}
                    className="w-full flex items-center justify-between py-2 text-sm font-semibold"
                    style={{ color: "hsl(var(--foreground))" }}
                  >
                    <span>Order Items ({order.orderItems.length})</span>
                    {showItems ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                  </button>
                  <AnimatePresence>
                    {showItems && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        className="overflow-hidden space-y-2"
                      >
                        {order.orderItems.map((item, i) => (
                          <div key={i} className="flex items-center gap-3 glass-inner rounded-xl p-3">
                            {item.image && (
                              <img src={item.image} alt={item.name} className="w-12 h-12 rounded-lg object-cover" />
                            )}
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium truncate" style={{ color: "hsl(var(--foreground))" }}>{item.name}</p>
                              {formatOrderItemOptions(item) && (
                                <p className="text-xs leading-snug" style={{ color: "hsl(var(--muted-foreground))" }}>{formatOrderItemOptions(item)}</p>
                              )}
                              <p className="text-xs" style={{ color: "hsl(var(--muted-foreground))" }}>
                                {hasExactOrderItemUnitEquation(item)
                                  ? <>Qty: {item.quantity} × {orderMoney(item.price)}</>
                                  : <>Qty: {item.quantity} · Complete line price</>}
                              </p>
                            </div>
                            <p className="text-sm font-semibold" style={{ color: "hsl(var(--foreground))" }}>
                              {orderMoney(getOrderItemLineSubtotal(item))}
                            </p>
                          </div>
                        ))}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>}

                {/* Payment Info */}
                <div className="flex items-center justify-between text-sm glass-inner rounded-xl p-3">
                  <span style={{ color: "hsl(var(--muted-foreground))" }}>Payment</span>
                  <span className="font-medium" style={{ color: "hsl(var(--foreground))" }}>
                    {order.paymentMethod === "cash_on_delivery"
                      ? "Cash on Delivery"
                      : order.paymentMethod === "wallet"
                        ? "Rozare Wallet"
                        : "Card (Stripe)"} •{" "}
                    <span style={{ color: order.isPaid ? "#22c55e" : "#f59e0b" }}>
                      {order.isPaid ? "Paid" : "Unpaid"}
                    </span>
                  </span>
                </div>

                <p className="text-xs text-center" style={{ color: "hsl(var(--muted-foreground))" }}>
                  Placed on {new Date(order.createdAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}
                </p>
              </motion.div>
            )}

            {searched && !order && !loading && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="text-center py-12 glass-panel"
              >
                <Package className="w-16 h-16 mx-auto mb-4" style={{ color: "hsl(var(--muted-foreground))" }} />
                <p className="text-lg font-semibold" style={{ color: "hsl(var(--foreground))" }}>No order found</p>
                <p className="text-sm" style={{ color: "hsl(var(--muted-foreground))" }}>
                  Double-check your email and order ID
                </p>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      </div>
    </div>
  );
}
