import React, { useState, useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Plus, Search, Filter, Package, Tag, CheckSquare, Square, Trash2, Store, AlertTriangle, ChevronLeft, ChevronRight } from "lucide-react";
import Loader from '../common/Loader'
import ProductCard from "./ProductCard";
import { useOutletContext, useNavigate } from "react-router-dom";
import BulkDiscountModal from "./BulkDiscountModal";
import { ProductForm } from "./SellerDashboard";
import axios from "axios";
import { getAuthToken } from "../../utils/cookieHelper";
import { inspectProductPagination, inspectSellerProductPresentation } from '../../utils/productCardSafety';

const ProductManagement = () => {
    const context = useOutletContext() || {};
    const { dashboardRole = 'seller', products = [], loading, categories = [], searchTerm = '', setSearchTerm, selectedCategory = 'all', setSelectedCategory, deleteConfirm, setDeleteConfirm, handleEditProduct, handleCreateProduct, handleDeleteProduct, handleBulkDeleteProducts, fetchProducts, isFormOpen, editingProduct, setEditingProduct, handleSaveProduct, uploadingImages, closeForm, canFeature, featuredStats, productCurrencyState, handleConvertProductCurrency, handleCancelProductCurrencyChange, currentPage = null, totalPages = null, totalProducts = null, pageSize = null, setProductPage } = context;
    const safeProducts = Array.isArray(products) ? products : [];
    const selectableProducts = safeProducts.filter(product => (
        inspectSellerProductPresentation(product).managementSafe
    ));
    const safeCategories = Array.isArray(categories) ? categories : [];
    const [selectedProducts, setSelectedProducts] = useState([]);
    const [isBulkModalOpen, setIsBulkModalOpen] = useState(false);
    const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState(false);
    const [selectMode, setSelectMode] = useState(false);
    const [hasStore, setHasStore] = useState(true);
    const [storeLoading, setStoreLoading] = useState(true);
    const navigate = useNavigate();
    const isAdminDashboard = dashboardRole === 'admin';
    const hasPendingCurrencyChange = productCurrencyState?.status === 'pending_conversion';
    const canAddProduct = isAdminDashboard || (
        hasStore
        && productCurrencyState?.valid === true
        && productCurrencyState.canAddProduct === true
        && !hasPendingCurrencyChange
    );
    const pagination = inspectProductPagination({
        page: currentPage,
        limit: pageSize,
        totalProducts,
        totalPages,
        hasMore: Number.isSafeInteger(currentPage) && Number.isSafeInteger(totalPages)
            ? currentPage < totalPages
            : null,
    }, {
        productCount: safeProducts.length,
        expectedPage: currentPage,
        expectedLimit: pageSize,
    });
    const safeTotalPages = pagination.valid ? pagination.totalPages : null;
    const safeCurrentPage = pagination.valid ? pagination.page : null;
    const pageNumbers = useMemo(() => {
        if (!pagination.valid) return [];
        const pages = [];
        const maxVisible = 5;
        let start = Math.max(1, safeCurrentPage - Math.floor(maxVisible / 2));
        const end = Math.min(safeTotalPages, start + maxVisible - 1);
        if (end - start + 1 < maxVisible) start = Math.max(1, end - maxVisible + 1);
        for (let page = start; page <= end; page += 1) pages.push(page);
        return pages;
    }, [pagination.valid, safeCurrentPage, safeTotalPages]);

    const goToPage = (page) => {
        if (!pagination.valid) return;
        const nextPage = Math.min(safeTotalPages, Math.max(1, page));
        setProductPage?.(nextPage);
        window.scrollTo({ top: 0, behavior: 'smooth' });
    };

    useEffect(() => {
        if (isAdminDashboard) {
            setHasStore(true);
            setStoreLoading(false);
            return;
        }
        const checkStore = async () => {
            try {
                const token = getAuthToken();
                
                if (!token) {
                    console.error('No JWT token found');
                    setHasStore(false);
                    setStoreLoading(false);
                    return;
                }
                
                console.log('Checking store with API URL:', import.meta.env.VITE_API_URL);
                const res = await axios.get(`${import.meta.env.VITE_API_URL}api/stores/my-store`, { 
                    headers: { Authorization: `Bearer ${token}` } 
                });
                
                console.log('Store check response:', res.data);
                setHasStore(!!res.data?.store);
            } catch (err) {
                console.error('Store check error:', err.response?.status, err.response?.data);
                
                // Only treat a confirmed "no store" (404) as missing.
                // 401/403/network errors shouldn't show the misleading "Store Required" banner.
                if (err?.response?.status === 404) {
                    setHasStore(false);
                } else if (err?.response?.status === 401 || err?.response?.status === 403) {
                    // Authentication error - user needs to log in again
                    console.error('Authentication error - token may be invalid');
                    setHasStore(false);
                } else {
                    // Network or other errors - assume store exists to avoid false negative
                    setHasStore(true);
                }
            }
            finally { setStoreLoading(false); }
        };
        checkStore();
    }, [isAdminDashboard]);

    const handleToggleSelectMode = () => { setSelectMode(!selectMode); setSelectedProducts([]); };
    const handleSelectProduct = (product) => {
        if (!inspectSellerProductPresentation(product).managementSafe) return;
        setSelectedProducts(prev => prev.find(p => p._id === product._id)
            ? prev.filter(p => p._id !== product._id)
            : [...prev, product]);
    };
    const handleSelectAll = () => {
        selectedProducts.length === selectableProducts.length
            ? setSelectedProducts([])
            : setSelectedProducts([...selectableProducts]);
    };
    const selectedMoneySafe = selectedProducts.length > 0 && selectedProducts.every(product => (
        inspectSellerProductPresentation(product).valid
    ));
    const handleBulkOperationSuccess = () => { setSelectedProducts([]); setSelectMode(false); fetchProducts?.(); };
    const confirmBulkDelete = async () => {
        if (!handleBulkDeleteProducts) return;
        const deleted = await handleBulkDeleteProducts(selectedProducts.map(product => product._id));
        if (deleted) {
            setBulkDeleteConfirm(false);
            setSelectedProducts([]);
            setSelectMode(false);
        }
    };

    return (
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }} transition={{ duration: 0.3 }} className='p-3 sm:p-4 lg:p-6'>
            {/* Inline Product Form (replaces list when open) */}
            {isFormOpen && editingProduct && (
                <ProductForm
                    product={editingProduct}
                    setProduct={setEditingProduct}
                    onSave={handleSaveProduct}
                    onClose={closeForm}
                    uploadingImages={uploadingImages}
                    canFeature={canFeature}
                    featuredStats={featuredStats}
                />
            )}

            {/* Product List (hidden when form is open) */}
            {(!isFormOpen || !editingProduct) && (<>
            {/* No Store Warning */}
            {!storeLoading && !hasStore && (
                <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="glass-panel p-6 mb-4 sm:mb-6 flex flex-col sm:flex-row items-center gap-4"
                    style={{ borderLeft: '4px solid hsl(45, 93%, 47%)' }}>
                    <div className="p-3 rounded-2xl" style={{ background: 'rgba(245, 158, 11, 0.12)' }}>
                        <AlertTriangle size={28} style={{ color: 'hsl(45, 93%, 47%)' }} />
                    </div>
                    <div className="flex-1 text-center sm:text-left">
                        <h3 className="font-bold text-base mb-1" style={{ color: 'hsl(var(--foreground))' }}>Store Required</h3>
                        <p className="text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>You need to create a store before you can add products. Set up your store to get started.</p>
                    </div>
                    <motion.button whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }} onClick={() => navigate('/seller-dashboard/store-settings')}
                        className="px-5 py-2.5 rounded-xl font-semibold text-white text-sm whitespace-nowrap"
                        style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(200, 80%, 50%))' }}>
                        <Store size={16} className="inline mr-1.5" /> Create Store
                    </motion.button>
                </motion.div>
            )}

            {hasStore && hasPendingCurrencyChange && (
                <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="glass-panel p-5 mb-4 sm:mb-6 flex flex-col lg:flex-row items-start lg:items-center gap-4"
                    style={{ borderLeft: '4px solid hsl(45, 93%, 47%)' }}>
                    <div className="p-3 rounded-2xl" style={{ background: 'rgba(245, 158, 11, 0.12)' }}>
                        <AlertTriangle size={26} style={{ color: 'hsl(45, 93%, 47%)' }} />
                    </div>
                    <div className="flex-1">
                        <h3 className="font-bold text-base mb-1" style={{ color: 'hsl(var(--foreground))' }}>Product Currency Change Pending</h3>
                        <p className="text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>
                            Your existing products are in {productCurrencyState.previousCurrency || productCurrencyState.activeCurrency}. Convert all product prices to {productCurrencyState.pendingCurrency}, or cancel and keep {productCurrencyState.previousCurrency || productCurrencyState.activeCurrency}. New products are paused until this is finished.
                        </p>
                    </div>
                    <div className="flex flex-wrap gap-2 w-full lg:w-auto">
                        <button onClick={handleCancelProductCurrencyChange}
                            className="px-4 py-2.5 rounded-xl font-semibold text-sm"
                            style={{ background: 'rgba(255,255,255,0.08)', color: 'hsl(var(--foreground))', border: '1px solid var(--glass-border)' }}>
                            Keep {productCurrencyState.previousCurrency || productCurrencyState.activeCurrency}
                        </button>
                        <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.97 }} onClick={handleConvertProductCurrency}
                            className="px-4 py-2.5 rounded-xl font-semibold text-white text-sm"
                            style={{ background: 'linear-gradient(135deg, hsl(150, 60%, 45%), hsl(170, 50%, 40%))' }}>
                            Convert to {productCurrencyState.pendingCurrency}
                        </motion.button>
                    </div>
                </motion.div>
            )}

            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 sm:gap-4 mb-4 sm:mb-6 mt-4 sm:mt-6">
                <h2 className="text-xl sm:text-2xl font-extrabold tracking-tight" style={{ color: 'hsl(var(--foreground))' }}>Product Management</h2>
                <div className="flex flex-wrap items-center gap-2 sm:gap-3 w-full sm:w-auto">
                    {selectMode && selectedProducts.length > 0 && (
                        <>
                            <motion.button initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}
                                onClick={() => { if (selectedMoneySafe) setIsBulkModalOpen(true); }}
                                disabled={!selectedMoneySafe}
                                title={selectedMoneySafe ? 'Change selected product prices' : 'Refresh products with unavailable money or stock before changing prices'}
                                className="flex items-center gap-1.5 sm:gap-2 px-3 sm:px-4 py-2 rounded-xl text-sm sm:text-base font-semibold text-white disabled:opacity-50 disabled:cursor-not-allowed"
                                style={{ background: 'hsl(150, 60%, 45%)' }}>
                                <Tag size={16} className="sm:w-5 sm:h-5" /> <span className="hidden xs:inline">Bulk</span> ({selectedProducts.length})
                            </motion.button>
                            <motion.button initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}
                                onClick={() => setBulkDeleteConfirm(true)}
                                className="flex items-center gap-1.5 sm:gap-2 px-3 sm:px-4 py-2 rounded-xl text-sm sm:text-base font-semibold text-white"
                                style={{ background: 'linear-gradient(135deg, hsl(0, 72%, 55%), hsl(340, 65%, 50%))' }}>
                                <Trash2 size={16} className="sm:w-5 sm:h-5" /> <span className="hidden xs:inline">Delete</span> ({selectedProducts.length})
                            </motion.button>
                        </>
                    )}
                    <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} onClick={handleToggleSelectMode}
                        className="flex items-center gap-1.5 sm:gap-2 px-3 sm:px-4 py-2 rounded-xl text-sm sm:text-base font-semibold"
                        style={selectMode ? { background: 'rgba(255,255,255,0.08)', color: 'hsl(var(--foreground))', border: '1px solid var(--glass-border)' } : { background: 'linear-gradient(135deg, hsl(260, 60%, 55%), hsl(280, 50%, 55%))', color: 'white' }}>
                        {selectMode ? <Square size={16} className="sm:w-5 sm:h-5" /> : <CheckSquare size={16} className="sm:w-5 sm:h-5" />}
                        <span>{selectMode ? 'Cancel' : 'Select'}</span>
                    </motion.button>
                    <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} onClick={handleCreateProduct}
                        disabled={!canAddProduct}
                        className="flex items-center gap-1.5 sm:gap-2 px-3 sm:px-4 py-2 rounded-xl text-sm sm:text-base font-semibold text-white transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                        style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(200, 80%, 50%))', boxShadow: '0 0 20px -4px hsl(220, 70%, 55%, 0.3)' }}
                        title={!hasStore ? 'Create a store first' : hasPendingCurrencyChange ? 'Finish product currency conversion first' : 'Add new product'}>
                        <Plus size={16} className="sm:w-5 sm:h-5" /> <span>Add</span>
                    </motion.button>
                </div>
            </div>

            {/* Filters */}
            <div className="glass-panel p-3 sm:p-4 mb-4 sm:mb-6">
                <div className="flex flex-col gap-3 sm:gap-4">
                    <div className="search-input-wrapper flex-1">
                        <div className="search-input-icon"><Search size={16} /></div>
                        <input type="text" placeholder="Search products..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} className="glass-input glass-input-search" />
                    </div>
                    <div className="flex flex-col xs:flex-row items-stretch xs:items-center gap-2 sm:gap-3">
                        <div className="flex items-center gap-2 flex-1">
                            <Filter size={18} style={{ color: 'hsl(var(--muted-foreground))' }} className="flex-shrink-0" />
                            <select value={selectedCategory} onChange={(e) => setSelectedCategory(e.target.value)} className="glass-input cursor-pointer font-medium flex-1">
                                {['all', ...safeCategories].map(category => (<option key={category} value={category}>{category.charAt(0).toUpperCase() + category.slice(1)}</option>))}
                            </select>
                        </div>
                        {selectMode && selectableProducts.length > 0 && (
                            <button onClick={handleSelectAll} className="px-3 sm:px-4 py-2 rounded-xl text-sm whitespace-nowrap font-medium"
                                style={{ background: 'rgba(99, 102, 241, 0.12)', color: 'hsl(220, 70%, 55%)' }}>
                                {selectedProducts.length === selectableProducts.length ? 'Deselect All' : 'Select All'}
                            </button>
                        )}
                    </div>
                </div>
            </div>

            {/* Products Grid */}
            {loading ? (
                <div className="glass-panel flex justify-center items-center min-h-[300px]"><Loader /></div>
            ) : (
                <div className="glass-panel p-4 sm:p-6 overflow-hidden">
                    {safeProducts.length === 0 ? (
                        <div className="p-8 text-center">
                            <div className="glass-inner inline-flex p-4 rounded-2xl mb-3"><Package size={40} style={{ color: 'hsl(var(--muted-foreground))' }} /></div>
                            <p className="text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>No products found. Try adjusting your search or add a new product.</p>
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                            {safeProducts.map((product, index) => (
                                <div key={index} className="relative">
                                    {selectMode && (
                                        <div className="absolute top-2 left-2 z-10">
                                            <motion.button whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.9 }} onClick={() => handleSelectProduct(product)}
                                                disabled={!inspectSellerProductPresentation(product).managementSafe}
                                                className="p-2 rounded-xl shadow-lg"
                                                style={selectedProducts.find(p => p._id === product._id)
                                                    ? { background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))', color: 'white' }
                                                    : { background: 'rgba(255,255,255,0.9)', color: 'hsl(var(--foreground))' }}>
                                                {selectedProducts.find(p => p._id === product._id) ? <CheckSquare size={20} /> : <Square size={20} />}
                                            </motion.button>
                                        </div>
                                    )}
                                    <ProductCard product={product} index={index} onEditProduct={handleEditProduct} setDeleteConfirm={setDeleteConfirm} selectMode={selectMode} displayNativeCurrency={!isAdminDashboard} />
                                </div>
                            ))}
                        </div>
                    )}

                    {safeProducts.length > 0 && (
                        <div className="mt-6 flex flex-col sm:flex-row items-center justify-between gap-3">
                            <p className="text-xs sm:text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                {pagination.valid
                                    ? `Showing ${((safeCurrentPage - 1) * pageSize) + 1}-${Math.min(safeCurrentPage * pageSize, totalProducts)} of ${totalProducts} products`
                                    : 'Product count unavailable. Refresh before changing pages.'}
                            </p>
                            {pagination.valid && <div className="flex items-center gap-1.5">
                                <button
                                    type="button"
                                    onClick={() => goToPage(safeCurrentPage - 1)}
                                    disabled={safeCurrentPage <= 1}
                                    className="h-9 w-9 rounded-xl glass-button flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed"
                                    aria-label="Previous products page"
                                >
                                    <ChevronLeft size={16} />
                                </button>
                                {pageNumbers.map(page => (
                                    <button
                                        key={page}
                                        type="button"
                                        onClick={() => goToPage(page)}
                                        className="h-9 min-w-9 px-3 rounded-xl text-sm font-semibold transition-all"
                                        style={page === safeCurrentPage
                                            ? { background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))', color: 'white' }
                                            : { background: 'var(--glass-inner)', color: 'hsl(var(--foreground))', border: '1px solid var(--glass-border)' }}
                                    >
                                        {page}
                                    </button>
                                ))}
                                <button
                                    type="button"
                                    onClick={() => goToPage(safeCurrentPage + 1)}
                                    disabled={safeCurrentPage >= safeTotalPages}
                                    className="h-9 w-9 rounded-xl glass-button flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed"
                                    aria-label="Next products page"
                                >
                                    <ChevronRight size={16} />
                                </button>
                            </div>}
                        </div>
                    )}
                </div>
            )}

            {/* Delete Confirmation Modal */}
            {createPortal(
                <AnimatePresence>
                    {deleteConfirm && (
                        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-[110]">
                            <motion.div initial={{ scale: 0.92, opacity: 0, y: 20 }} animate={{ scale: 1, opacity: 1, y: 0 }} exit={{ scale: 0.92, opacity: 0, y: 20 }}
                                transition={{ type: 'spring', damping: 25, stiffness: 300 }}
                                className="max-w-md w-full p-6 glass-panel-strong"
                                style={{ boxShadow: '0 24px 80px rgba(0,0,0,0.2)' }}>
                                <div className="text-center mb-5">
                                    <div className="mx-auto w-14 h-14 rounded-2xl flex items-center justify-center mb-3" style={{ background: 'rgba(239,68,68,0.12)' }}>
                                        <Trash2 size={24} style={{ color: 'hsl(0, 72%, 55%)' }} />
                                    </div>
                                    <h3 className="text-lg font-bold" style={{ color: 'hsl(var(--foreground))' }}>Delete Product?</h3>
                                    <p className="text-sm mt-2" style={{ color: 'hsl(var(--muted-foreground))' }}>This action cannot be undone. The product will be permanently removed.</p>
                                </div>
                                <div className="flex gap-3">
                                    <button onClick={() => setDeleteConfirm(null)} className="flex-1 px-4 py-2.5 rounded-xl font-medium text-sm"
                                        style={{ background: 'rgba(0,0,0,0.05)', color: 'hsl(var(--foreground))' }}>Cancel</button>
                                    <motion.button whileTap={{ scale: 0.95 }} onClick={() => handleDeleteProduct(deleteConfirm)} className="flex-1 px-4 py-2.5 rounded-xl text-white font-semibold text-sm"
                                        style={{ background: 'linear-gradient(135deg, hsl(0, 72%, 55%), hsl(340, 65%, 50%))', boxShadow: '0 4px 16px rgba(239,68,68,0.3)' }}>Delete</motion.button>
                                </div>
                            </motion.div>
                        </motion.div>
                    )}
                </AnimatePresence>,
                document.body
            )}

            <BulkDiscountModal isOpen={isBulkModalOpen} onClose={() => setIsBulkModalOpen(false)} selectedProducts={selectedProducts} onSuccess={handleBulkOperationSuccess} isAdmin={isAdminDashboard} />
            {createPortal(
                <AnimatePresence>
                    {bulkDeleteConfirm && (
                        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-[110]">
                            <motion.div initial={{ scale: 0.92, opacity: 0, y: 20 }} animate={{ scale: 1, opacity: 1, y: 0 }} exit={{ scale: 0.92, opacity: 0, y: 20 }}
                                transition={{ type: 'spring', damping: 25, stiffness: 300 }}
                                className="max-w-md w-full p-6 glass-panel-strong"
                                style={{ boxShadow: '0 24px 80px rgba(0,0,0,0.2)' }}>
                                <div className="text-center mb-5">
                                    <div className="mx-auto w-14 h-14 rounded-2xl flex items-center justify-center mb-3" style={{ background: 'rgba(239,68,68,0.12)' }}>
                                        <Trash2 size={24} style={{ color: 'hsl(0, 72%, 55%)' }} />
                                    </div>
                                    <h3 className="text-lg font-bold" style={{ color: 'hsl(var(--foreground))' }}>Delete Selected Products?</h3>
                                    <p className="text-sm mt-2" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                        {selectedProducts.length} product{selectedProducts.length === 1 ? '' : 's'} will be permanently removed. This action cannot be undone.
                                    </p>
                                </div>
                                <div className="flex gap-3">
                                    <button onClick={() => setBulkDeleteConfirm(false)} className="flex-1 px-4 py-2.5 rounded-xl font-medium text-sm"
                                        style={{ background: 'rgba(0,0,0,0.05)', color: 'hsl(var(--foreground))' }}>Cancel</button>
                                    <motion.button whileTap={{ scale: 0.95 }} onClick={confirmBulkDelete} className="flex-1 px-4 py-2.5 rounded-xl text-white font-semibold text-sm"
                                        style={{ background: 'linear-gradient(135deg, hsl(0, 72%, 55%), hsl(340, 65%, 50%))', boxShadow: '0 4px 16px rgba(239,68,68,0.3)' }}>Delete</motion.button>
                                </div>
                            </motion.div>
                        </motion.div>
                    )}
                </AnimatePresence>,
                document.body
            )}
            </>)}
        </motion.div>
    );
};
export default ProductManagement
