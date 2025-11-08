import { useEffect, useState } from "react";
import axios from "axios";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "react-toastify";
import {
    ArrowLeft,
    Edit,
    Package,
    XCircle,
    Clock,
    RefreshCw,
    Truck,
    CheckCircle,
    CreditCard,
} from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { useCurrency } from "../../contexts/CurrencyContext";
import Loader from "../common/Loader";

const OrderDetail = () => {
    const { formatPrice } = useCurrency();
    const [order, setOrder] = useState(null);

    const getStatusIcon = (status) => {
        switch (status) {
            case "pending":
                return <Clock className="w-4 h-4" />;
            case "confirmed":
                return <CheckCircle className="w-4 h-4 text-blue-600" />;
            case "processing":
                return <RefreshCw className="w-4 h-4" />;
            case "shipped":
                return <Truck className="w-4 h-4" />;
            case "delivered":
                return <CheckCircle className="w-4 h-4" />;
            case "cancelled":
                return <XCircle className="w-4 h-4" />;
            default:
                return <Package className="w-4 h-4" />;
        }
    };

    const getStatusColor = (status) => {
        switch (status) {
            case "pending":
                return "bg-yellow-100 text-yellow-800";
            case "confirmed":
                return "bg-cyan-100 text-cyan-800";
            case "processing":
                return "bg-blue-100 text-blue-800";
            case "shipped":
                return "bg-indigo-100 text-indigo-800";
            case "delivered":
                return "bg-green-100 text-green-800";
            case "cancelled":
                return "bg-red-100 text-red-800";
            default:
                return "bg-gray-100 text-gray-800";
        }
    };

    const { id } = useParams();
    const fetchOrderDetail = async () => {
        const token = localStorage.getItem("jwtToken");
        try {
            const res = await axios.get(
                `${import.meta.env.VITE_API_URL}api/order/detail/${id}`,
                {
                    headers: {
                        Authorization: `Bearer ${token}`,
                    },
                }
            );
            console.log(res.data);
            setOrder(res.data.order);
        } catch (error) {
            console.error(error);
            toast.error(
                error.response?.data?.msg ||
                    "Server error while fetching order detail"
            );
        }
    };

    useEffect(() => {
        fetchOrderDetail();
    }, []);

    const [isUpdating, setIsUpdating] = useState(false);
    const [newStatus, setNewStatus] = useState(null);
    const [showCancelConfirm, setShowCancelConfirm] = useState(false);

    const handleStatusUpdate = async () => {
        try {
            const token = localStorage.getItem("jwtToken");
            const res = await axios.patch(
                `${import.meta.env.VITE_API_URL}api/order/update-status/${order?._id}`,
                {
                    newStatus: newStatus,
                },
                {
                    headers: {
                        Authorization: `Bearer ${token}`,
                    },
                }
            );
            toast.success(res.data.msg || "Updated status successfully.");
            fetchOrderDetail();
        } catch (error) {
            console.error(
                error.response?.msg || "Server error while updating status"
            );
            toast.error(
                error.response?.msg || "Server error while updating status"
            );
        }
        setIsUpdating(false);
    };

    const handleCancelOrder = async () => {
        try {
            const token = localStorage.getItem("jwtToken");
            const res = await axios.patch(
                `${import.meta.env.VITE_API_URL}api/order/cancel/${id}`,
                {},
                {
                    headers: {
                        Authorization: `Bearer ${token}`,
                    },
                }
            );
            console.log(res.data.msg);
            fetchOrderDetail();
        } catch (error) {
            console.error(
                error.response?.msg || "Server error while cancelling order"
            );
            toast.error(
                error.response?.msg || "Server error while cancelling order"
            );
        } finally {
            setShowCancelConfirm(false);
        }
    };

    if (!order)
        return (
            <div className="h flex justify-center items-center">
                <Loader />
            </div>
        );

    return (
        <motion.div
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            className="bg-white rounded-lg shadow overflow-hidden"
        >
            {/* Header */}
            <div className="p-6 mt-6 border-b border-gray-200 flex items-center justify-between">
                <div className="flex items-start gap-3 sm:gap-4 mb-4 mt-12 sm:mt-0">
                    <Link to={"/user-dashboard/orders"}>
                        <button className="p-2 rounded-lg hover:bg-gray-100 flex-shrink-0 relative z-10">
                            <ArrowLeft className="w-4 h-4 sm:w-5 sm:h-5" />
                        </button>
                    </Link>
                    <div className="min-w-0 flex-1">
                        <h1 className="text-lg sm:text-2xl font-bold text-gray-800 truncate">
                            Order {order?.orderId}
                        </h1>
                        <p className="text-xs sm:text-sm text-gray-600 mt-1">
                            Placed on{" "}
                            {new Date(order?.createdAt).toLocaleDateString()}
                        </p>
                    </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                    <span
                        className={`px-2 sm:px-3 py-1 text-xs sm:text-sm rounded-full flex items-center gap-1 ${getStatusColor(
                            order?.orderStatus
                        )}`}
                    >
                        {getStatusIcon(order?.orderStatus)}
                        <span className="hidden xs:inline">
                            {order?.orderStatus?.charAt(0).toUpperCase() +
                                order?.orderStatus.slice(1)}
                        </span>
                    </span>
                    <span
                        className={`px-2 sm:px-3 py-1 text-xs sm:text-sm rounded-full ${
                            order?.isPaid
                                ? "bg-green-100 text-green-800"
                                : "bg-red-100 text-red-800"
                        }`}
                    >
                        {order?.isPaid ? "Paid" : "Unpaid"}
                    </span>
                    {order?.spinDiscount?.applied && (
                        <span className="px-2 sm:px-3 py-1 text-xs sm:text-sm rounded-full bg-gradient-to-r from-purple-500 to-pink-500 text-white font-semibold flex items-center gap-1">
                            🎉 <span className="hidden xs:inline">Spin Discount:</span> {order.spinDiscount.label}
                        </span>
                    )}
                </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6 p-4 sm:p-6">
                {/* Customer Information */}
                <div className="lg:col-span-1">
                    <div className="bg-gray-50 p-3 sm:p-4 rounded-lg">
                        <h2 className="text-base sm:text-lg font-medium text-gray-800 mb-3 sm:mb-4">
                            Customer Information
                        </h2>
                        <div className="space-y-2 sm:space-y-3">
                            <div>
                                <p className="text-xs sm:text-sm text-gray-500">Name</p>
                                <p className="text-sm sm:text-base font-medium break-words">
                                    {order?.shippingInfo.fullName}
                                </p>
                            </div>
                            <div>
                                <p className="text-xs sm:text-sm text-gray-500">Email</p>
                                <p className="text-sm sm:text-base font-medium break-all">
                                    {order?.shippingInfo.email}
                                </p>
                            </div>
                            <div>
                                <p className="text-xs sm:text-sm text-gray-500">Phone</p>
                                <p className="text-sm sm:text-base font-medium">
                                    {order?.shippingInfo.phone}
                                </p>
                            </div>
                            <div>
                                <p className="text-xs sm:text-sm text-gray-500">
                                    Address
                                </p>
                                <p className="font-medium">
                                    {order?.shippingInfo.address}
                                </p>
                                <p className="font-medium">
                                    {order?.shippingInfo.city},{" "}
                                    {order?.shippingInfo.state}{" "}
                                    {order?.shippingInfo.postalCode}
                                </p>
                                <p className="font-medium">
                                    {order?.shippingInfo.country}
                                </p>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Order Items and Summary */}
                <div className="lg:col-span-2">
                    <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                        <h2 className="text-base sm:text-lg font-medium text-gray-800 p-3 sm:p-4 border-b border-gray-200">
                            Order Items
                        </h2>
                        <div className="divide-y divide-gray-200">
                            {order?.orderItems.map((item, index) => (
                                <motion.div
                                    key={index}
                                    initial={{ opacity: 0 }}
                                    animate={{ opacity: 1 }}
                                    transition={{ delay: index * 0.1 }}
                                    className="p-3 sm:p-4 flex items-start gap-3 sm:gap-4"
                                >
                                    <div className="flex-shrink-0 h-14 w-14 sm:h-16 sm:w-16 bg-gray-200 rounded-md overflow-hidden">
                                        {item.image ? (
                                            <img
                                                src={item.image}
                                                alt={item.name}
                                                className="h-full w-full object-cover"
                                            />
                                        ) : (
                                            <div className="h-full w-full flex items-center justify-center text-gray-400">
                                                <Package className="h-6 w-6 sm:h-8 sm:w-8" />
                                            </div>
                                        )}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <h3 className="text-sm sm:text-base font-medium text-gray-800 break-words">
                                            {item.name}
                                        </h3>
                                        <p className="text-xs sm:text-sm text-gray-500 mt-1">
                                            Quantity: {item.quantity}
                                        </p>
                                        {item.hasSpinDiscount && (
                                            <span className="inline-flex items-center gap-1 mt-1 px-1.5 sm:px-2 py-0.5 bg-gradient-to-r from-purple-100 to-pink-100 text-purple-700 text-[10px] sm:text-xs font-semibold rounded-full border border-purple-200">
                                                🎉 Spin Discount
                                            </span>
                                        )}
                                        <div className="mt-2 sm:hidden">
                                            <p className="text-sm font-semibold text-gray-800">
                                                {formatPrice(item.price)}
                                            </p>
                                            {item.hasSpinDiscount && item.originalPrice && (
                                                <p className="text-xs text-gray-400 line-through">
                                                    {formatPrice(item.originalPrice)}
                                                </p>
                                            )}
                                            <p className="text-xs text-gray-500 mt-1">
                                                Subtotal: {formatPrice(item.price * item.quantity)}
                                            </p>
                                        </div>
                                    </div>
                                    <div className="text-right hidden sm:block flex-shrink-0">
                                        <p className="text-sm sm:text-base font-medium text-gray-800">
                                            {formatPrice(item.price)}
                                        </p>
                                        {item.hasSpinDiscount && item.originalPrice && (
                                            <p className="text-xs text-gray-400 line-through">
                                                {formatPrice(item.originalPrice)}
                                            </p>
                                        )}
                                        <p className="text-xs sm:text-sm text-gray-500 mt-1">
                                            Subtotal: {formatPrice(item.price * item.quantity)}
                                        </p>
                                    </div>
                                </motion.div>
                            ))}
                        </div>
                    </div>

                    {/* Order Summary */}
                    <div className="mt-6 bg-gray-50 p-4 rounded-lg">
                        <h2 className="text-lg font-medium text-gray-800 mb-4">
                            Order Summary
                        </h2>
                        <div className="space-y-2">
                            <div className="flex justify-between pt-2">
                                <span className="text-gray-600">
                                    Subtotal
                                </span>
                                <span className="text-gray-800">
                                    {formatPrice(order?.orderSummary.subtotal)}
                                </span>
                            </div>
                            
                            {(() => {
                                // Calculate actual shipping cost from sellerShipping array if available
                                let actualShippingCost = order?.orderSummary.shippingCost || 0;
                                
                                if (order?.sellerShipping && order.sellerShipping.length > 0) {
                                    actualShippingCost = order.sellerShipping.reduce((sum, sellerShip) => 
                                        sum + (sellerShip.shippingMethod.price || 0), 0
                                    );
                                }
                                
                                return actualShippingCost >= 0 || order?.sellerShipping?.length > 0 ? (
                                    <div className="space-y-1">
                                        <div className="flex justify-between">
                                            <span className="text-gray-600 font-medium">
                                                Shipping
                                            </span>
                                            <span className="text-gray-800">
                                                {formatPrice(actualShippingCost)}
                                            </span>
                                        </div>
                                        {order?.sellerShipping && order.sellerShipping.length > 0 && (
                                            <div className="pl-4 space-y-1">
                                                {order.sellerShipping.map((sellerShip, index) => (
                                                    <div key={index} className="flex justify-between text-xs text-gray-500">
                                                        <span className="capitalize">
                                                            {sellerShip.shippingMethod.name} ({sellerShip.shippingMethod.estimatedDays} days)
                                                        </span>
                                                        <span>{formatPrice(sellerShip.shippingMethod.price)}</span>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                ) : null;
                            })()}
                            
                            {order?.orderSummary.tax > 0 && (
                                <div className="flex justify-between">
                                    <span className="text-gray-600">
                                        Tax
                                    </span>
                                    <span className="text-gray-800">
                                        {formatPrice(order?.orderSummary.tax)}
                                    </span>
                                </div>
                            )}
                            
                            <div className="flex justify-between pt-2 border-t">
                                <span className="text-lg font-medium text-gray-800">
                                    Total Amount
                                </span>
                                <span className="text-lg font-bold text-gray-800">
                                    {(() => {
                                        // Recalculate total using actual shipping cost
                                        const subtotal = order?.orderSummary.subtotal || 0;
                                        const tax = order?.orderSummary.tax || 0;
                                        
                                        // Calculate actual shipping from sellerShipping array if available
                                        let actualShipping = order?.orderSummary.shippingCost || 0;
                                        if (order?.sellerShipping && order.sellerShipping.length > 0) {
                                            actualShipping = order.sellerShipping.reduce((sum, sellerShip) => 
                                                sum + (sellerShip.shippingMethod.price || 0), 0
                                            );
                                        }
                                        
                                        return formatPrice(subtotal + tax + actualShipping);
                                    })()}
                                </span>
                            </div>
                        </div>
                        
                        {/* Cancel Order Button - Only show if order is not cancelled or delivered */}
                        {order?.orderStatus !== 'cancelled' && order?.orderStatus !== 'delivered' && (
                            <div className="mt-4 pt-4 border-t border-gray-200">
                                <button
                                    onClick={() => setShowCancelConfirm(true)}
                                    className="w-full px-4 py-2 bg-red-100 text-red-700 rounded-md hover:bg-red-200 flex items-center justify-center space-x-2"
                                >
                                    <XCircle className="w-4 h-4" />
                                    <span>Cancel Order</span>
                                </button>
                            </div>
                        )}
                    </div>

                    {/* Payment */}
                    <div className="mt-6 bg-white shadow-md rounded-2xl p-6 border border-gray-200">
                        <h2 className="text-xl font-semibold text-gray-800 mb-4 flex items-center gap-2">
                            <CreditCard className="w-5 h-5 text-indigo-600" />
                            Payment Details
                        </h2>

                        <div className="space-y-4">
                            <div className="flex justify-between items-center">
                                <span className="text-gray-600 font-medium">
                                    Method:
                                </span>
                                <span className="text-gray-900 capitalize">
                                    {order.paymentMethod}
                                </span>
                            </div>

                            <div className="flex justify-between items-center">
                                <span className="text-gray-600 font-medium">
                                    Status:
                                </span>
                                {order.isPaid ? (
                                    <span className="flex items-center gap-1 text-green-600 font-semibold">
                                        <CheckCircle className="w-4 h-4" />
                                        Paid
                                    </span>
                                ) : (
                                    <span className="flex items-center gap-1 text-orange-500 font-semibold">
                                        <Clock className="w-4 h-4" />
                                        Pending
                                    </span>
                                )}
                            </div>

                            {order.paymentResult?.paymentIntentId && (
                                <div className="flex justify-between items-center">
                                    <span className="text-gray-600 font-medium">
                                        Payment Intent ID:
                                    </span>
                                    <span className="text-gray-900 break-all">
                                        {order.paymentResult.paymentIntentId}
                                    </span>
                                </div>
                            )}

                            {order.paymentResult?.emailAddress && (
                                <div className="flex justify-between items-center">
                                    <span className="text-gray-600 font-medium">
                                        Paid By:
                                    </span>
                                    <span className="text-gray-900">
                                        {order.paymentResult.emailAddress}
                                    </span>
                                </div>
                            )}

                            <div className="flex justify-between items-center">
                                <span className="text-gray-600 font-medium">
                                    Created:
                                </span>
                                <span className="text-gray-900">
                                    {new Date(
                                        order.createdAt
                                    ).toLocaleDateString()}
                                </span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {/* Cancel Confirmation Modal */}
            <AnimatePresence>
                {showCancelConfirm && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="fixed inset-0 bg-black/60 bg-opacity-50 flex items-center justify-center p-4 z-50"
                        onClick={() => setShowCancelConfirm(false)}
                    >
                        <motion.div
                            initial={{ scale: 0.9, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            exit={{ scale: 0.9, opacity: 0 }}
                            className="bg-white rounded-lg p-6 max-w-md w-full"
                            onClick={(e) => e.stopPropagation()}
                        >
                            <h3 className="text-lg font-medium text-gray-800 mb-2">
                                Cancel Order
                            </h3>
                            <p className="text-gray-600 mb-6">
                                Are you sure you want to cancel this order? This
                                action cannot be undone.
                            </p>
                            <div className="flex justify-end space-x-3">
                                <button
                                    onClick={() =>
                                        setShowCancelConfirm(false)
                                    }
                                    className="px-4 py-2 bg-gray-200 text-gray-800 rounded-md hover:bg-gray-300"
                                >
                                    Keep Order
                                </button>
                                <button
                                    onClick={handleCancelOrder}
                                    className="px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700"
                                >
                                    Cancel Order
                                </button>
                            </div>
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>
        </motion.div>
    );
};
export default OrderDetail;
