import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Percent, DollarSign, Tag, TrendingUp, TrendingDown, Trash2 } from 'lucide-react';
import axios from 'axios';
import { toast } from 'react-toastify';

const BulkDiscountModal = ({ isOpen, onClose, selectedProducts, onSuccess }) => {
    const [activeOperation, setActiveOperation] = useState('discount'); // 'discount', 'price', 'remove'
    const [discountType, setDiscountType] = useState('percentage');
    const [discountValue, setDiscountValue] = useState('');
    const [priceUpdateType, setPriceUpdateType] = useState('percentage');
    const [priceValue, setPriceValue] = useState('');
    const [isLoading, setIsLoading] = useState(false);

    const handleApplyDiscount = async () => {
        if (!discountValue || discountValue <= 0) {
            toast.error('Please enter a valid discount value');
            return;
        }

        setIsLoading(true);
        try {
            const token = localStorage.getItem('jwtToken');
            const productIds = selectedProducts.map(p => p._id);

            const res = await axios.post(
                `${import.meta.env.VITE_API_URL}api/products/bulk-discount`,
                {
                    productIds,
                    discountType,
                    discountValue: parseFloat(discountValue)
                },
                {
                    headers: {
                        Authorization: `Bearer ${token}`
                    }
                }
            );

            toast.success(res.data.msg);
            onSuccess();
            handleClose();
        } catch (error) {
            console.error(error);
            toast.error(error.response?.data?.msg || 'Failed to apply discount');
        } finally {
            setIsLoading(false);
        }
    };

    const handleUpdatePrice = async () => {
        if (priceValue === '' || (priceUpdateType !== 'set' && priceValue == 0)) {
            toast.error('Please enter a valid price value');
            return;
        }

        setIsLoading(true);
        try {
            const token = localStorage.getItem('jwtToken');
            const productIds = selectedProducts.map(p => p._id);

            const res = await axios.post(
                `${import.meta.env.VITE_API_URL}api/products/bulk-price-update`,
                {
                    productIds,
                    updateType: priceUpdateType,
                    value: parseFloat(priceValue)
                },
                {
                    headers: {
                        Authorization: `Bearer ${token}`
                    }
                }
            );

            toast.success(res.data.msg);
            onSuccess();
            handleClose();
        } catch (error) {
            console.error(error);
            toast.error(error.response?.data?.msg || 'Failed to update prices');
        } finally {
            setIsLoading(false);
        }
    };

    const handleRemoveDiscount = async () => {
        setIsLoading(true);
        try {
            const token = localStorage.getItem('jwtToken');
            const productIds = selectedProducts.map(p => p._id);

            const res = await axios.post(
                `${import.meta.env.VITE_API_URL}api/products/remove-discount`,
                { productIds },
                {
                    headers: {
                        Authorization: `Bearer ${token}`
                    }
                }
            );

            toast.success(res.data.msg);
            onSuccess();
            handleClose();
        } catch (error) {
            console.error(error);
            toast.error(error.response?.data?.msg || 'Failed to remove discounts');
        } finally {
            setIsLoading(false);
        }
    };

    const handleClose = () => {
        setDiscountValue('');
        setPriceValue('');
        setActiveOperation('discount');
        onClose();
    };

    if (!isOpen) return null;

    return (
        <AnimatePresence>
            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 bg-black/60 flex items-center justify-center p-3 sm:p-4 z-50"
                onClick={handleClose}
            >
                <motion.div
                    initial={{ scale: 0.9, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ scale: 0.9, opacity: 0 }}
                    onClick={(e) => e.stopPropagation()}
                    className="bg-white rounded-lg sm:rounded-xl shadow-lg max-w-2xl w-full max-h-[95vh] overflow-y-auto"
                >
                    {/* Header */}
                    <div className="p-4 sm:p-6 border-b border-gray-200 flex justify-between items-start gap-3">
                        <div className="min-w-0 flex-1">
                            <h3 className="text-lg sm:text-xl font-semibold text-gray-900 truncate">
                                Bulk Operations
                            </h3>
                            <p className="text-xs sm:text-sm text-gray-500 mt-1">
                                {selectedProducts.length} product(s) selected
                            </p>
                        </div>
                        <button
                            onClick={handleClose}
                            className="text-gray-400 hover:text-gray-600 transition-colors flex-shrink-0 p-1"
                        >
                            <X size={20} className="sm:w-6 sm:h-6" />
                        </button>
                    </div>

                    {/* Operation Tabs */}
                    <div className="p-3 sm:p-6 border-b border-gray-200">
                        <div className="flex flex-col xs:flex-row gap-2">
                            <button
                                onClick={() => setActiveOperation('discount')}
                                className={`flex items-center justify-center gap-1.5 sm:gap-2 px-3 sm:px-4 py-2 rounded-lg transition-colors text-sm ${
                                    activeOperation === 'discount'
                                        ? 'bg-blue-100 text-blue-700'
                                        : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                                }`}
                            >
                                <Tag size={16} className="sm:w-[18px] sm:h-[18px]" />
                                <span>Apply Discount</span>
                            </button>
                            <button
                                onClick={() => setActiveOperation('price')}
                                className={`flex items-center justify-center gap-1.5 sm:gap-2 px-3 sm:px-4 py-2 rounded-lg transition-colors text-sm ${
                                    activeOperation === 'price'
                                        ? 'bg-blue-100 text-blue-700'
                                        : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                                }`}
                            >
                                <DollarSign size={16} className="sm:w-[18px] sm:h-[18px]" />
                                <span>Update Prices</span>
                            </button>
                            <button
                                onClick={() => setActiveOperation('remove')}
                                className={`flex items-center justify-center gap-1.5 sm:gap-2 px-3 sm:px-4 py-2 rounded-lg transition-colors text-sm ${
                                    activeOperation === 'remove'
                                        ? 'bg-blue-100 text-blue-700'
                                        : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                                }`}
                            >
                                <Trash2 size={16} className="sm:w-[18px] sm:h-[18px]" />
                                <span>Remove Discount</span>
                            </button>
                        </div>
                    </div>

                    {/* Content */}
                    <div className="p-4 sm:p-6">
                        {/* Apply Discount */}
                        {activeOperation === 'discount' && (
                            <div className="space-y-3 sm:space-y-4">
                                <div>
                                    <label className="block text-xs sm:text-sm font-medium text-gray-700 mb-2">
                                        Discount Type
                                    </label>
                                    <div className="grid grid-cols-2 gap-2 sm:gap-3">
                                        <button
                                            onClick={() => setDiscountType('percentage')}
                                            className={`flex items-center justify-center gap-1.5 sm:gap-2 p-2 sm:p-3 rounded-lg border-2 transition-all text-sm ${
                                                discountType === 'percentage'
                                                    ? 'border-blue-500 bg-blue-50 text-blue-700'
                                                    : 'border-gray-200 hover:border-gray-300'
                                            }`}
                                        >
                                            <Percent size={18} className="sm:w-5 sm:h-5" />
                                            <span>Percentage</span>
                                        </button>
                                        <button
                                            onClick={() => setDiscountType('fixed')}
                                            className={`flex items-center justify-center gap-1.5 sm:gap-2 p-2 sm:p-3 rounded-lg border-2 transition-all text-sm ${
                                                discountType === 'fixed'
                                                    ? 'border-blue-500 bg-blue-50 text-blue-700'
                                                    : 'border-gray-200 hover:border-gray-300'
                                            }`}
                                        >
                                            <DollarSign size={18} className="sm:w-5 sm:h-5" />
                                            <span>Fixed Amount</span>
                                        </button>
                                    </div>
                                </div>

                                <div>
                                    <label className="block text-xs sm:text-sm font-medium text-gray-700 mb-2">
                                        Discount Value
                                    </label>
                                    <div className="relative">
                                        <input
                                            type="number"
                                            min="0"
                                            step="0.01"
                                            value={discountValue}
                                            onChange={(e) => setDiscountValue(e.target.value)}
                                            className="w-full px-3 sm:px-4 py-2 sm:py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
                                            placeholder={discountType === 'percentage' ? 'e.g., 20' : 'e.g., 10.00'}
                                        />
                                        <span className="absolute right-3 sm:right-4 top-1/2 transform -translate-y-1/2 text-gray-500 text-sm">
                                            {discountType === 'percentage' ? '%' : '$'}
                                        </span>
                                    </div>
                                    <p className="text-[10px] sm:text-xs text-gray-500 mt-1">
                                        {discountType === 'percentage'
                                            ? 'Enter percentage to discount (e.g., 20 for 20% off)'
                                            : 'Enter fixed amount to discount (e.g., 10 for $10 off)'}
                                    </p>
                                </div>

                                <button
                                    onClick={handleApplyDiscount}
                                    disabled={isLoading}
                                    className="w-full bg-linear-to-r from-indigo-600 to-sky-500 hover:from-indigo-700 hover:to-sky-600 disabled:opacity-60 disabled:cursor-not-allowed text-white py-2.5 sm:py-3 rounded-lg transition-colors text-sm sm:text-base font-medium"
                                >
                                    {isLoading ? 'Applying...' : 'Apply Discount'}
                                </button>
                            </div>
                        )}

                        {/* Update Prices */}
                        {activeOperation === 'price' && (
                            <div className="space-y-3 sm:space-y-4">
                                <div>
                                    <label className="block text-xs sm:text-sm font-medium text-gray-700 mb-2">
                                        Update Type
                                    </label>
                                    <div className="grid grid-cols-3 gap-2 sm:gap-3">
                                        <button
                                            onClick={() => setPriceUpdateType('percentage')}
                                            className={`flex flex-col items-center justify-center gap-1 p-2 sm:p-3 rounded-lg border-2 transition-all ${
                                                priceUpdateType === 'percentage'
                                                    ? 'border-blue-500 bg-blue-50 text-blue-700'
                                                    : 'border-gray-200 hover:border-gray-300'
                                            }`}
                                        >
                                            <Percent size={16} className="sm:w-5 sm:h-5" />
                                            <span className="text-[10px] sm:text-xs">Percentage</span>
                                        </button>
                                        <button
                                            onClick={() => setPriceUpdateType('fixed')}
                                            className={`flex flex-col items-center justify-center gap-1 p-2 sm:p-3 rounded-lg border-2 transition-all ${
                                                priceUpdateType === 'fixed'
                                                    ? 'border-blue-500 bg-blue-50 text-blue-700'
                                                    : 'border-gray-200 hover:border-gray-300'
                                            }`}
                                        >
                                            <DollarSign size={16} className="sm:w-5 sm:h-5" />
                                            <span className="text-[10px] sm:text-xs">Fixed</span>
                                        </button>
                                        <button
                                            onClick={() => setPriceUpdateType('set')}
                                            className={`flex flex-col items-center justify-center gap-1 p-2 sm:p-3 rounded-lg border-2 transition-all ${
                                                priceUpdateType === 'set'
                                                    ? 'border-blue-500 bg-blue-50 text-blue-700'
                                                    : 'border-gray-200 hover:border-gray-300'
                                            }`}
                                        >
                                            <Tag size={16} className="sm:w-5 sm:h-5" />
                                            <span className="text-[10px] sm:text-xs">Set Price</span>
                                        </button>
                                    </div>
                                </div>

                                <div>
                                    <label className="block text-xs sm:text-sm font-medium text-gray-700 mb-2">
                                        {priceUpdateType === 'set' ? 'New Price' : 'Change Value'}
                                    </label>
                                    <div className="relative">
                                        <input
                                            type="number"
                                            step="0.01"
                                            value={priceValue}
                                            onChange={(e) => setPriceValue(e.target.value)}
                                            className="w-full px-3 sm:px-4 py-2 sm:py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
                                            placeholder={
                                                priceUpdateType === 'percentage'
                                                    ? 'e.g., 10 or -10'
                                                    : priceUpdateType === 'fixed'
                                                    ? 'e.g., 5 or -5'
                                                    : 'e.g., 99.99'
                                            }
                                        />
                                        <span className="absolute right-3 sm:right-4 top-1/2 transform -translate-y-1/2 text-gray-500 text-sm">
                                            {priceUpdateType === 'percentage' ? '%' : '$'}
                                        </span>
                                    </div>
                                    <p className="text-[10px] sm:text-xs text-gray-500 mt-1">
                                        {priceUpdateType === 'percentage' && 'Positive to increase, negative to decrease (e.g., 10 for +10%, -10 for -10%)'}
                                        {priceUpdateType === 'fixed' && 'Positive to increase, negative to decrease (e.g., 5 for +$5, -5 for -$5)'}
                                        {priceUpdateType === 'set' && 'Set all selected products to this specific price'}
                                    </p>
                                </div>

                                <button
                                    onClick={handleUpdatePrice}
                                    disabled={isLoading}
                                    className="w-full bg-linear-to-r from-indigo-600 to-sky-500 hover:from-indigo-700 hover:to-sky-600 disabled:opacity-60 disabled:cursor-not-allowed text-white py-2.5 sm:py-3 rounded-lg transition-colors text-sm sm:text-base font-medium"
                                >
                                    {isLoading ? 'Updating...' : 'Update Prices'}
                                </button>
                            </div>
                        )}

                        {/* Remove Discount */}
                        {activeOperation === 'remove' && (
                            <div className="space-y-3 sm:space-y-4">
                                <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 sm:p-4">
                                    <p className="text-xs sm:text-sm text-yellow-800">
                                        This will remove all discounts from the selected products and reset their discounted price to $0.
                                    </p>
                                </div>

                                <div className="bg-gray-50 rounded-lg p-3 sm:p-4">
                                    <h4 className="text-xs sm:text-sm font-medium text-gray-700 mb-2">Selected Products:</h4>
                                    <div className="space-y-2 max-h-32 sm:max-h-40 overflow-y-auto">
                                        {selectedProducts.map((product) => (
                                            <div key={product._id} className="flex justify-between items-center gap-2 text-xs sm:text-sm">
                                                <span className="text-gray-600 truncate flex-1">{product.name}</span>
                                                {product.discountedPrice > 0 && (
                                                    <span className="text-red-600 font-medium flex-shrink-0">
                                                        ${product.discountedPrice.toFixed(2)}
                                                    </span>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                </div>

                                <button
                                    onClick={handleRemoveDiscount}
                                    disabled={isLoading}
                                    className="w-full bg-red-600 text-white py-2.5 sm:py-3 rounded-lg hover:bg-red-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors text-sm sm:text-base font-medium"
                                >
                                    {isLoading ? 'Removing...' : 'Remove All Discounts'}
                                </button>
                            </div>
                        )}
                    </div>
                </motion.div>
            </motion.div>
        </AnimatePresence>
    );
};

export default BulkDiscountModal;
