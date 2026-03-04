import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Percent, DollarSign, Tag, TrendingUp, TrendingDown, Trash2 } from 'lucide-react';
import axios from 'axios';
import { toast } from 'react-toastify';

const BulkDiscountModal = ({ isOpen, onClose, selectedProducts, onSuccess }) => {
    const [activeOperation, setActiveOperation] = useState('discount');
    const [discountType, setDiscountType] = useState('percentage');
    const [discountValue, setDiscountValue] = useState('');
    const [priceUpdateType, setPriceUpdateType] = useState('percentage');
    const [priceValue, setPriceValue] = useState('');
    const [isLoading, setIsLoading] = useState(false);

    const handleApplyDiscount = async () => {
        if (!discountValue || discountValue <= 0) { toast.error('Please enter a valid discount value'); return; }
        setIsLoading(true);
        try { const token = localStorage.getItem('jwtToken'); const productIds = selectedProducts.map(p => p._id); const res = await axios.post(`${import.meta.env.VITE_API_URL}api/products/bulk-discount`, { productIds, discountType, discountValue: parseFloat(discountValue) }, { headers: { Authorization: `Bearer ${token}` } }); toast.success(res.data.msg); onSuccess(); handleClose(); }
        catch (error) { toast.error(error.response?.data?.msg || 'Failed to apply discount'); } finally { setIsLoading(false); }
    };

    const handleUpdatePrice = async () => {
        if (priceValue === '' || (priceUpdateType !== 'set' && priceValue == 0)) { toast.error('Please enter a valid price value'); return; }
        setIsLoading(true);
        try { const token = localStorage.getItem('jwtToken'); const productIds = selectedProducts.map(p => p._id); const res = await axios.post(`${import.meta.env.VITE_API_URL}api/products/bulk-price-update`, { productIds, updateType: priceUpdateType, value: parseFloat(priceValue) }, { headers: { Authorization: `Bearer ${token}` } }); toast.success(res.data.msg); onSuccess(); handleClose(); }
        catch (error) { toast.error(error.response?.data?.msg || 'Failed to update prices'); } finally { setIsLoading(false); }
    };

    const handleRemoveDiscount = async () => {
        setIsLoading(true);
        try { const token = localStorage.getItem('jwtToken'); const productIds = selectedProducts.map(p => p._id); const res = await axios.post(`${import.meta.env.VITE_API_URL}api/products/remove-discount`, { productIds }, { headers: { Authorization: `Bearer ${token}` } }); toast.success(res.data.msg); onSuccess(); handleClose(); }
        catch (error) { toast.error(error.response?.data?.msg || 'Failed to remove discounts'); } finally { setIsLoading(false); }
    };

    const handleClose = () => { setDiscountValue(''); setPriceValue(''); setActiveOperation('discount'); onClose(); };

    if (!isOpen) return null;

    const tabButtons = [
        { key: 'discount', label: 'Apply Discount', icon: <Tag size={16} /> },
        { key: 'price', label: 'Update Prices', icon: <DollarSign size={16} /> },
        { key: 'remove', label: 'Remove Discount', icon: <Trash2 size={16} /> },
    ];

    return (
        <AnimatePresence>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-black/50 backdrop-blur-md flex items-center justify-center p-3 sm:p-4 z-50" onClick={handleClose}>
                <motion.div initial={{ scale: 0.92, opacity: 0, y: 20 }} animate={{ scale: 1, opacity: 1, y: 0 }} exit={{ scale: 0.92, opacity: 0, y: 20 }}
                    transition={{ type: 'spring', damping: 25, stiffness: 300 }}
                    onClick={(e) => e.stopPropagation()}
                    className="max-w-2xl w-full max-h-[95vh] overflow-y-auto glass-panel-strong"
                    style={{ boxShadow: '0 24px 80px rgba(0,0,0,0.2), 0 8px 32px rgba(0,0,0,0.1)' }}>
                    
                    {/* Header */}
                    <div className="p-4 sm:p-6 flex justify-between items-start gap-3" style={{ borderBottom: '1px solid var(--glass-border)' }}>
                        <div className="min-w-0 flex-1">
                            <h3 className="text-lg sm:text-xl font-bold truncate" style={{ color: 'hsl(var(--foreground))' }}>Bulk Operations</h3>
                            <p className="text-xs sm:text-sm mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>{selectedProducts.length} product(s) selected</p>
                        </div>
                        <button onClick={handleClose} className="p-1 rounded-xl glass-inner" style={{ color: 'hsl(var(--muted-foreground))' }}><X size={20} /></button>
                    </div>

                    {/* Tabs */}
                    <div className="p-3 sm:p-6" style={{ borderBottom: '1px solid var(--glass-border)' }}>
                        <div className="flex flex-col xs:flex-row gap-2">
                            {tabButtons.map(tab => (
                                <button key={tab.key} onClick={() => setActiveOperation(tab.key)}
                                    className="flex items-center justify-center gap-1.5 sm:gap-2 px-3 sm:px-4 py-2 rounded-xl transition-all text-sm font-medium"
                                    style={activeOperation === tab.key
                                        ? { background: 'rgba(99, 102, 241, 0.12)', color: 'hsl(220, 70%, 55%)' }
                                        : { background: 'rgba(255,255,255,0.05)', color: 'hsl(var(--muted-foreground))' }}>
                                    {tab.icon} <span>{tab.label}</span>
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Content */}
                    <div className="p-4 sm:p-6">
                        {activeOperation === 'discount' && (
                            <div className="space-y-3 sm:space-y-4">
                                <div>
                                    <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'hsl(var(--muted-foreground))' }}>Discount Type</label>
                                    <div className="grid grid-cols-2 gap-2 sm:gap-3">
                                        {[{ key: 'percentage', icon: <Percent size={18} />, label: 'Percentage' }, { key: 'fixed', icon: <DollarSign size={18} />, label: 'Fixed Amount' }].map(dt => (
                                            <button key={dt.key} onClick={() => setDiscountType(dt.key)}
                                                className="flex items-center justify-center gap-1.5 sm:gap-2 p-2 sm:p-3 rounded-xl transition-all text-sm font-medium"
                                                style={discountType === dt.key
                                                    ? { background: 'rgba(99, 102, 241, 0.12)', color: 'hsl(220, 70%, 55%)', border: '2px solid hsl(220, 70%, 55%)' }
                                                    : { background: 'rgba(255,255,255,0.05)', color: 'hsl(var(--muted-foreground))', border: '2px solid var(--glass-border)' }}>
                                                {dt.icon} <span>{dt.label}</span>
                                            </button>
                                        ))}
                                    </div>
                                </div>
                                <div>
                                    <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'hsl(var(--muted-foreground))' }}>Discount Value</label>
                                    <div className="relative">
                                        <input type="number" min="0" step="0.01" value={discountValue} onChange={(e) => setDiscountValue(e.target.value)}
                                            className="glass-input pr-8" placeholder={discountType === 'percentage' ? 'e.g., 20' : 'e.g., 10.00'} />
                                        <span className="absolute right-3 top-1/2 transform -translate-y-1/2 text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>{discountType === 'percentage' ? '%' : '$'}</span>
                                    </div>
                                </div>
                                <motion.button whileHover={{ scale: 1.01 }} onClick={handleApplyDiscount} disabled={isLoading}
                                    className="w-full py-2.5 sm:py-3 rounded-xl text-sm sm:text-base font-semibold text-white disabled:opacity-60"
                                    style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(200, 80%, 50%))' }}>
                                    {isLoading ? 'Applying...' : 'Apply Discount'}
                                </motion.button>
                            </div>
                        )}

                        {activeOperation === 'price' && (
                            <div className="space-y-3 sm:space-y-4">
                                <div>
                                    <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'hsl(var(--muted-foreground))' }}>Update Type</label>
                                    <div className="grid grid-cols-3 gap-2 sm:gap-3">
                                        {[{ key: 'percentage', icon: <Percent size={16} />, label: 'Percentage' }, { key: 'fixed', icon: <DollarSign size={16} />, label: 'Fixed' }, { key: 'set', icon: <Tag size={16} />, label: 'Set Price' }].map(pt => (
                                            <button key={pt.key} onClick={() => setPriceUpdateType(pt.key)}
                                                className="flex flex-col items-center justify-center gap-1 p-2 sm:p-3 rounded-xl transition-all font-medium"
                                                style={priceUpdateType === pt.key
                                                    ? { background: 'rgba(99, 102, 241, 0.12)', color: 'hsl(220, 70%, 55%)', border: '2px solid hsl(220, 70%, 55%)' }
                                                    : { background: 'rgba(255,255,255,0.05)', color: 'hsl(var(--muted-foreground))', border: '2px solid var(--glass-border)' }}>
                                                {pt.icon} <span className="text-[10px] sm:text-xs">{pt.label}</span>
                                            </button>
                                        ))}
                                    </div>
                                </div>
                                <div>
                                    <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'hsl(var(--muted-foreground))' }}>{priceUpdateType === 'set' ? 'New Price' : 'Change Value'}</label>
                                    <div className="relative">
                                        <input type="number" step="0.01" value={priceValue} onChange={(e) => setPriceValue(e.target.value)}
                                            className="glass-input pr-8" placeholder={priceUpdateType === 'percentage' ? 'e.g., 10 or -10' : priceUpdateType === 'fixed' ? 'e.g., 5 or -5' : 'e.g., 99.99'} />
                                        <span className="absolute right-3 top-1/2 transform -translate-y-1/2 text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>{priceUpdateType === 'percentage' ? '%' : '$'}</span>
                                    </div>
                                </div>
                                <motion.button whileHover={{ scale: 1.01 }} onClick={handleUpdatePrice} disabled={isLoading}
                                    className="w-full py-2.5 sm:py-3 rounded-xl text-sm sm:text-base font-semibold text-white disabled:opacity-60"
                                    style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(200, 80%, 50%))' }}>
                                    {isLoading ? 'Updating...' : 'Update Prices'}
                                </motion.button>
                            </div>
                        )}

                        {activeOperation === 'remove' && (
                            <div className="space-y-4">
                                <div className="glass-inner rounded-xl p-4 text-center" style={{ borderLeft: '3px solid hsl(30, 90%, 50%)' }}>
                                    <Trash2 className="mx-auto mb-3" size={32} style={{ color: 'hsl(0, 72%, 55%)' }} />
                                    <h4 className="font-semibold mb-2" style={{ color: 'hsl(var(--foreground))' }}>Remove All Discounts</h4>
                                    <p className="text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>This will remove all discounts from {selectedProducts.length} selected product(s). Prices will revert to their original values.</p>
                                </div>
                                <motion.button whileHover={{ scale: 1.01 }} onClick={handleRemoveDiscount} disabled={isLoading}
                                    className="w-full py-2.5 sm:py-3 rounded-xl text-sm sm:text-base font-semibold text-white disabled:opacity-60"
                                    style={{ background: 'hsl(0, 72%, 55%)' }}>
                                    {isLoading ? 'Removing...' : 'Remove Discounts'}
                                </motion.button>
                            </div>
                        )}

                        {/* Selected Products Preview */}
                        <div className="mt-6">
                            <h4 className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: 'hsl(var(--muted-foreground))' }}>Selected Products</h4>
                            <div className="max-h-36 sm:max-h-48 overflow-y-auto space-y-2">
                                {selectedProducts.map(product => (
                                    <div key={product._id} className="flex items-center gap-3 glass-inner rounded-xl p-2">
                                        {product.images?.[0] && <img src={product.images[0]} alt={product.name} className="w-10 h-10 rounded-lg object-cover" />}
                                        <div className="flex-1 min-w-0">
                                            <p className="text-xs sm:text-sm font-medium truncate" style={{ color: 'hsl(var(--foreground))' }}>{product.name}</p>
                                            <p className="text-[10px] sm:text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>${product.price?.toFixed(2)}{product.discountedPrice && <span className="ml-2" style={{ color: 'hsl(150, 60%, 45%)' }}>${product.discountedPrice.toFixed(2)}</span>}</p>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                </motion.div>
            </motion.div>
        </AnimatePresence>
    );
};

export default BulkDiscountModal;
