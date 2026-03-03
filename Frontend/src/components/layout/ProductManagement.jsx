import React, { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Plus, Search, Filter, Package, Tag, CheckSquare, Square } from "lucide-react";
import Loader from '../common/Loader'
import ProductCard from "./ProductCard";
import { useOutletContext } from "react-router-dom";
import BulkDiscountModal from "./BulkDiscountModal";


// Product Management Component
const ProductManagement = () => {

    const {
        products,
        loading,
        categories,
        searchTerm,
        setSearchTerm,
        selectedCategory,
        setSelectedCategory,
        deleteConfirm,
        setDeleteConfirm,
        handleEditProduct,
        handleCreateProduct,
        handleDeleteProduct,
        fetchProducts
    } = useOutletContext()

    const [selectedProducts, setSelectedProducts] = useState([]);
    const [isBulkModalOpen, setIsBulkModalOpen] = useState(false);
    const [selectMode, setSelectMode] = useState(false);

    const handleToggleSelectMode = () => {
        setSelectMode(!selectMode);
        setSelectedProducts([]);
    };

    const handleSelectProduct = (product) => {
        setSelectedProducts(prev => {
            const isSelected = prev.find(p => p._id === product._id);
            if (isSelected) {
                return prev.filter(p => p._id !== product._id);
            } else {
                return [...prev, product];
            }
        });
    };

    const handleSelectAll = () => {
        if (selectedProducts.length === products.length) {
            setSelectedProducts([]);
        } else {
            setSelectedProducts([...products]);
        }
    };

    const handleBulkOperationSuccess = () => {
        setSelectedProducts([]);
        setSelectMode(false);
        fetchProducts();
    };

    return (
        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.3 }}
            className='p-3 sm:p-4 lg:p-6'
        >
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 sm:gap-4 mb-4 sm:mb-6 mt-4 sm:mt-6">
                <h2 className="text-xl sm:text-2xl font-bold text-gray-800">Product Management</h2>
                <div className="flex flex-wrap items-center gap-2 sm:gap-3 w-full sm:w-auto">
                    {selectMode && selectedProducts.length > 0 && (
                        <motion.button
                            initial={{ opacity: 0, scale: 0.9 }}
                            animate={{ opacity: 1, scale: 1 }}
                            whileHover={{ scale: 1.02 }}
                            whileTap={{ scale: 0.98 }}
                            onClick={() => setIsBulkModalOpen(true)}
                            className="flex items-center gap-1.5 sm:gap-2 bg-green-600 text-white px-3 sm:px-4 py-2 rounded-lg text-sm sm:text-base"
                        >
                            <Tag size={16} className="sm:w-5 sm:h-5" />
                            <span className="hidden xs:inline">Bulk</span> ({selectedProducts.length})
                        </motion.button>
                    )}
                    <motion.button
                        whileHover={{ scale: 1.02 }}
                        whileTap={{ scale: 0.98 }}
                        onClick={handleToggleSelectMode}
                        className={`flex items-center gap-1.5 sm:gap-2 px-3 sm:px-4 py-2 rounded-lg text-sm sm:text-base ${
                            selectMode 
                                ? 'bg-gray-600 text-white' 
                                : 'bg-indigo-600 text-white'
                        }`}
                    >
                        {selectMode ? <Square size={16} className="sm:w-5 sm:h-5" /> : <CheckSquare size={16} className="sm:w-5 sm:h-5" />}
                        <span>{selectMode ? 'Cancel' : 'Select'}</span>
                    </motion.button>
                    <motion.button
                        whileHover={{ scale: 1.02 }}
                        whileTap={{ scale: 0.98 }}
                        onClick={handleCreateProduct}
                        className="flex items-center gap-1.5 sm:gap-2 bg-linear-to-r from-indigo-600 to-sky-500 hover:from-indigo-700 hover:to-sky-600 text-white px-3 sm:px-4 py-2 rounded-lg text-sm sm:text-base transition-colors"
                    >
                        <Plus size={16} className="sm:w-5 sm:h-5" />
                        <span>Add</span>
                    </motion.button>
                </div>
            </div>

            <div className="bg-white p-3 sm:p-4 rounded-xl shadow-sm border border-gray-100 mb-4 sm:mb-6">
                <div className="flex flex-col gap-3 sm:gap-4">
                    <div className="relative flex-1">
                        <Search className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-400" size={18} />
                        <input
                            type="text"
                            placeholder="Search products..."
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            className="w-full pr-10 py-2 px-3 border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
                        />
                    </div>
                    <div className="flex flex-col xs:flex-row items-stretch xs:items-center gap-2 sm:gap-3">
                        <div className="flex items-center gap-2 flex-1">
                            <Filter size={18} className="text-gray-400 flex-shrink-0" />
                            <select
                                value={selectedCategory}
                                onChange={(e) => setSelectedCategory(e.target.value)}
                                className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
                            >
                                {['all', ...categories].map(category => (
                                    <option key={category} value={category}>
                                        {category.charAt(0).toUpperCase() + category.slice(1)}
                                    </option>
                                ))}
                            </select>
                        </div>
                        {selectMode && products.length > 0 && (
                            <button
                                onClick={handleSelectAll}
                                className="px-3 sm:px-4 py-2 bg-blue-50 text-blue-600 rounded-lg hover:bg-blue-100 transition-colors text-sm whitespace-nowrap"
                            >
                                {selectedProducts.length === products.length ? 'Deselect All' : 'Select All'}
                            </button>
                        )}
                    </div>
                </div>
            </div>

            {
                loading ? (
                    <div className="bg-white flex justify-center  items-center min-h-[300px] p-8 rounded-xl shadow-sm border border-gray-100 overflow-hidden">
                        < Loader />
                    </div>
                ) : (
                    <div className="bg-white p-8 rounded-xl shadow-sm border border-gray-100 overflow-hidden">
                        {products.length === 0 ? (
                            <div className="p-8 text-center">
                                <Package size={48} className="mx-auto text-gray-300 mb-4" />
                                <p className="text-gray-600">No products found. Try adjusting your search or add a new product.</p>
                            </div>
                        ) : (
                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                                {products.map((product, index) => (
                                    <div key={index} className="relative">
                                        {selectMode && (
                                            <div className="absolute top-2 left-2 z-10">
                                                <motion.button
                                                    whileHover={{ scale: 1.1 }}
                                                    whileTap={{ scale: 0.9 }}
                                                    onClick={() => handleSelectProduct(product)}
                                                    className={`p-2 rounded-lg shadow-lg ${
                                                        selectedProducts.find(p => p._id === product._id)
                                                            ? 'bg-indigo-600 text-white'
                                                            : 'bg-white text-gray-600'
                                                    }`}
                                                >
                                                    {selectedProducts.find(p => p._id === product._id) ? (
                                                        <CheckSquare size={20} />
                                                    ) : (
                                                        <Square size={20} />
                                                    )}
                                                </motion.button>
                                            </div>
                                        )}
                                        <ProductCard 
                                            product={product} 
                                            index={index} 
                                            onEditProduct={handleEditProduct} 
                                            setDeleteConfirm={setDeleteConfirm}
                                            selectMode={selectMode}
                                        />
                                    </div>
                                ))}
                            </div>

                        )}
                    </div>
                )
            }

            {/* Delete Confirmation Modal */}
            <AnimatePresence>
                {deleteConfirm && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="fixed inset-0 bg-black/60 bg-opacity-50 flex items-center justify-center p-4 z-50"
                    >
                        <motion.div
                            initial={{ scale: 0.9, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            exit={{ scale: 0.9, opacity: 0 }}
                            className="bg-white p-6 rounded-xl shadow-lg max-w-md w-full"
                        >
                            <h3 className="text-lg font-medium text-gray-900 mb-4">Confirm Deletion</h3>
                            <p className="text-gray-600 mb-6">Are you sure you want to delete this product? This action cannot be undone.</p>
                            <div className="flex justify-end space-x-3">
                                <button
                                    
                                    onClick={() => setDeleteConfirm(null)}
                                    className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={() => handleDeleteProduct(deleteConfirm)}
                                    className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700"
                                >
                                    Delete
                                </button>
                            </div>
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Bulk Discount Modal */}
            <BulkDiscountModal
                isOpen={isBulkModalOpen}
                onClose={() => setIsBulkModalOpen(false)}
                selectedProducts={selectedProducts}
                onSuccess={handleBulkOperationSuccess}
            />
        </motion.div>
    );
};
export default ProductManagement