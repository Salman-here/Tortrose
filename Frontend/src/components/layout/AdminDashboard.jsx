import React, { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
    BarChart3,
    Package,
    Plus,
    Edit,
    Trash2,
    Search,
    Filter,
    ChevronLeft,
    ChevronRight,
    X,
    Home,
    Tag,
    Star,
    Image as ImageIcon,
    DollarSign,
    Hash,
    BookOpen,
    Grid,
    CheckSquare,
    AlertCircle,
    Menu,
    TriangleAlert,
    TrafficCone,
    LayoutPanelLeft,
    ShoppingBag,
    Users,
    CheckCircle,
} from 'lucide-react';
import { uploadImageToCloudinary } from '../../utils/uploadToCloudinary';
import axios from 'axios';
import { useAuth } from '../../contexts/AuthContext';
import { toast } from 'react-toastify';
import { Link, Navigate, Outlet, useLocation } from 'react-router-dom';
import OrderManagement from './orders';
import StoreOverview from './StoreOverview';
import ProductManagement from './ProductManagement';
import { useCurrency } from '../../contexts/CurrencyContext';



const AdminDashboard = () => {

    const [isMobile, setIsMobile] = useState(false);
    // Check if device is mobile on initial render and resize
    useEffect(() => {
        const checkIsMobile = () => {
            setIsMobile(window.innerWidth < 1024);
        };

        // Initial check
        checkIsMobile();

        // Add event listener for window resize
        window.addEventListener('resize', checkIsMobile);

        // Cleanup
        return () => {
            window.removeEventListener('resize', checkIsMobile);
        };
    }, []);


    const [activeTab, setActiveTab] = useState('overview');
    const [products, setProducts] = useState([]);
    const [orders, setOrders] = useState([]);
    const [editingProduct, setEditingProduct] = useState(null);
    const [isFormOpen, setIsFormOpen] = useState(false);
    const [searchTerm, setSearchTerm] = useState('');
    const [categories, setCategories] = useState([])
    const [selectedCategory, setSelectedCategory] = useState('all');
    const [deleteConfirm, setDeleteConfirm] = useState(null);
    const [loading, setLoading] = useState(true);
    const [uploadingImages, setUploadingImages] = useState(false);

    const fetchFilters = async () => {
        try {
            const res = await axios.get(`${import.meta.env.VITE_API_URL}api/products/get-filters`)
            setCategories(res.data.categories)
        } catch (error) {
            console.error(error)
            setCategories([])
        }
    }
    useEffect(() => {
        fetchFilters()
    }, [])

    const fetchProducts = async () => {
        setLoading(true)
        // setError(null)
        try {
            const query = serializeFilters()
            // const query = ''
            // navigate(`${location.pathname}?${query}`)
            const res = await axios.get(`${import.meta.env.VITE_API_URL}api/products/get-products?${query}`)
            setProducts(res.data.products)
        } catch (err) {
            console.log(err)
            // setError(err)
        } finally {
            setLoading(false)
        }
    }

    const serializeFilters = () => {
        let params = new URLSearchParams()
        if (selectedCategory !== 'all') params.append('categories', selectedCategory)
        if (searchTerm !== '') params.append('search', searchTerm)

        // console.log(params.toString());
        return params.toString()
    }

    useEffect(() => {
        fetchProducts()
        fetchOrders()
    }, [searchTerm, selectedCategory])

    // GET ORDERS



    // Handle form operations
    const handleCreateProduct = () => {
        setEditingProduct({
            name: '',
            description: '',
            price: '',
            discountedPrice: "",
            category: '',
            brand: '',
            stock: "",
            image: '',
            images: [],
            tags: [],
            isFeatured: false
        });
        setIsFormOpen(true);
    };

    const handleEditProduct = (product) => {
        setEditingProduct({ ...product });
        setIsFormOpen(true);
    };

    const handleSaveProduct = async () => {
        setUploadingImages(true);
        try {
            // Upload main image if it's a file
            if (editingProduct.imageFile) {
                const imageUrl = await uploadImageToCloudinary(editingProduct.imageFile);
                editingProduct.image = imageUrl;
                delete editingProduct.imageFile;
            }

            // Upload additional images if they are files
            if (editingProduct.imageFiles && editingProduct.imageFiles.length > 0) {
                const uploadedUrls = await Promise.all(
                    editingProduct.imageFiles.map(file => uploadImageToCloudinary(file))
                );
                
                // Replace file previews with actual URLs
                const existingImages = editingProduct.images.filter(img => !img.isFile);
                const newImages = uploadedUrls.map(url => ({ url }));
                editingProduct.images = [...existingImages, ...newImages];
                delete editingProduct.imageFiles;
            }

            // Clean up any isFile flags
            if (editingProduct.images) {
                editingProduct.images = editingProduct.images.map(img => ({ url: img.url }));
            }
        } catch (error) {
            setUploadingImages(false);
            toast.error(error.message || 'Failed to upload images');
            return;
        }

        if (editingProduct._id) {
            // Update existing product
            try {
                const token = localStorage.getItem('jwtToken')
                const res = await axios.put(`${import.meta.env.VITE_API_URL}api/products/edit/${editingProduct._id}`,
                    {
                        product: editingProduct
                    },
                    {
                        headers: {
                            Authorization: `Bearer ${token}`
                        }
                    }
                )
                console.log(res.data.msg);
                toast.success(res.data.msg);
                fetchProducts()
                fetchFilters()
            } catch (error) {
                console.error(error.response.data.msg);
                toast.error(error.response.data.msg);
            }
        } else {
            try {
                const token = localStorage.getItem('jwtToken')
                const res = await axios.post(`${import.meta.env.VITE_API_URL}api/products/add`,
                    {
                        product: editingProduct
                    },
                    {
                        headers: {
                            Authorization: `Bearer ${token}`
                        }
                    }
                )
                console.log(res.data.msg);
                toast.success(res.data.msg);
                fetchProducts()
                fetchFilters()
            } catch (error) {
                console.error(error.response.data.msg);
                toast.error(error.response.data.msg);
            }
        }
        setUploadingImages(false);
        setIsFormOpen(false);
        setEditingProduct(null);
    };

    const handleDeleteProduct = async (id) => {
        console.log(id);

        try {
            const token = localStorage.getItem('jwtToken')
            const res = await axios.delete(`${import.meta.env.VITE_API_URL}api/products/delete/${id}`,
                {
                    headers: {
                        Authorization: `Bearer ${token}`
                    }
                }
            )
            console.log(res.data.msg || 'success');
            toast.success(res.data.msg || 'success')
            fetchProducts()
        } catch (error) {
            console.error(error.response.data.msg || 'Failed to delete product');
            toast.error(error.response.data.msg || 'Failed to delete product')
        }
        setDeleteConfirm(null);
    };

    const fetchOrders = async () => {

        const token = localStorage.getItem('jwtToken')
        try {
            const query = serializeFilters()
            // console.log(query);

            const res = await axios.get(`${import.meta.env.VITE_API_URL}api/order/get?${query}`,
                {
                    headers: {
                        Authorization: `Bearer ${token}`
                    }
                }
            )
            console.log(res.data);
            setOrders(res.data?.orders)
        } catch (error) {
            console.error(error);
        }
        finally {
        }
    }


    const outletContext = useMemo(() => ({
        products,
        orders,
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
        loading,
        fetchProducts
    }), [
        products, categories, searchTerm, selectedCategory, deleteConfirm,
        handleEditProduct, handleCreateProduct, handleDeleteProduct, loading
    ]);


    return (
        <div className="min-h-screen relative bg-gray-50 flex">

            {/* Sidebar */}
            <Sidebar activeTab={activeTab} setActiveTab={setActiveTab} />

            {/* Main Content */}
            <div className={`flex-1 ${!isMobile && 'ml-64'} `}>
                <div className="">
                    <Outlet context={outletContext} />
                </div>
            </div>

            {/* Product Form Modal */}
            <AnimatePresence>
                {isFormOpen && (
                    <ProductForm
                        product={editingProduct}
                        setProduct={setEditingProduct}
                        onSave={handleSaveProduct}
                        onClose={() => {
                            setIsFormOpen(false);
                            setEditingProduct(null);
                        }}
                        uploadingImages={uploadingImages}
                    />
                )}
            </AnimatePresence>
        </div>
    );
};

// Sidebar Component
// import React, { useState, useEffect } from 'react';
// import { motion, AnimatePresence } from 'framer-motion';
// import { BarChart3, Package, X, Menu } from 'lucide-react';

const Sidebar = ({ activeTab, setActiveTab }) => {
    const { currentUser } = useAuth();

    const menuItems = [
        { id: 'overview', label: 'Store Overview', icon: <BarChart3 size={18} />, link: '/admin-dashboard/store-overview' },
        { id: 'users', label: 'User Management', icon: <Users size={18} />, link: '/admin-dashboard/user-management' },
        { id: 'products', label: 'Product Management', icon: <Package size={18} />, link: '/admin-dashboard/product-management' },
        { id: 'orders', label: 'Order Management', icon: <ShoppingBag size={18} />, link: '/admin-dashboard/order-management' },
        { id: 'verifications', label: 'Store Verifications', icon: <CheckCircle size={18} />, link: '/admin-dashboard/store-verifications' },
        { id: 'tax', label: 'Tax Configuration', icon: <DollarSign size={18} />, link: '/admin-dashboard/tax-configuration' },
    ];

    const [isSidebarOpen, setIsSidebarOpen] = useState(false);
    const [isMobile, setIsMobile] = useState(false);
    const location = useLocation();

    useEffect(() => {
        const checkIsMobile = () => setIsMobile(window.innerWidth < 1024);
        checkIsMobile();
        window.addEventListener('resize', checkIsMobile);
        return () => window.removeEventListener('resize', checkIsMobile);
    }, []);

    useEffect(() => {
        menuItems.forEach(item => { if (item.link === location.pathname) setActiveTab(item.id); });
    }, [location]);

    const handleTabClick = (tabId) => { setActiveTab(tabId); if (isMobile) setIsSidebarOpen(false); };

    const SidebarContent = () => (
        <div className="flex flex-col h-full bg-linear-to-b from-slate-900 via-blue-950 to-slate-900">
            {/* Header */}
            <div className="flex items-center justify-between px-5 pt-6 pb-4">
                <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-xl bg-blue-500/30 flex items-center justify-center text-blue-200 font-bold text-sm border border-blue-400/30">
                        {currentUser?.username?.[0]?.toUpperCase() || 'A'}
                    </div>
                    <div>
                        <p className="text-white font-semibold text-sm leading-tight truncate max-w-[120px]">{currentUser?.username || 'Admin'}</p>
                        <span className="text-[10px] font-medium bg-blue-500/30 text-blue-300 px-1.5 py-0.5 rounded-full">Admin</span>
                    </div>
                </div>
                {isMobile && (
                    <button onClick={() => setIsSidebarOpen(false)} className="p-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-white/70 transition-colors">
                        <X size={16} />
                    </button>
                )}
            </div>

            <div className="mx-4 h-px bg-white/10 mb-4" />

            {/* Nav */}
            <nav className="flex-1 px-3 space-y-1 overflow-y-auto">
                {menuItems.map(item => {
                    const isActive = activeTab === item.id;
                    return (
                        <Link key={item.id} to={item.link}>
                            <motion.button whileHover={{ x: 2 }} onClick={() => handleTabClick(item.id)}
                                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all ${isActive
                                    ? 'bg-blue-500/25 text-white border border-blue-400/30 shadow-sm'
                                    : 'text-white/60 hover:text-white hover:bg-white/8'}`}>
                                <span className={`${isActive ? 'text-blue-300' : 'text-white/50'}`}>{item.icon}</span>
                                {item.label}
                                {isActive && <div className="ml-auto w-1.5 h-1.5 rounded-full bg-blue-400" />}
                            </motion.button>
                        </Link>
                    );
                })}
            </nav>

            {/* Footer */}
            <div className="px-3 pb-5 pt-4 border-t border-white/10 mt-4">
                <Link to="/">
                    <motion.button whileHover={{ x: 2 }}
                        className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-white/50 hover:text-white hover:bg-white/8 transition-all">
                        <LayoutPanelLeft size={18} className="text-white/40" />
                        Back to Store
                    </motion.button>
                </Link>
            </div>
        </div>
    );

    return (
        <>
            {isMobile && (
                <motion.button whileTap={{ scale: 0.95 }} onClick={() => setIsSidebarOpen(true)}
                    className="fixed top-4 left-4 z-50 bg-indigo-600 text-white p-2.5 rounded-xl shadow-lg shadow-indigo-500/30">
                    <Menu size={20} />
                </motion.button>
            )}

            <AnimatePresence>
                {isMobile && isSidebarOpen && (
                    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                        className="fixed inset-0 bg-black/50 backdrop-blur-sm z-40"
                        onClick={() => setIsSidebarOpen(false)} />
                )}
            </AnimatePresence>

            <motion.div
                initial={isMobile ? { x: '-100%' } : false}
                animate={isMobile ? { x: isSidebarOpen ? 0 : '-100%' } : { x: 0 }}
                transition={{ type: 'tween', ease: 'easeInOut', duration: 0.28 }}
                className="fixed top-0 left-0 h-full w-64 z-50 shadow-2xl overflow-hidden">
                <SidebarContent />
            </motion.div>
        </>
    );
};






// Product Form Component
// import { useState } from "react";
// import { motion } from "framer-motion";
// import { X, Star } from "lucide-react";

const ProductForm = ({ product, setProduct, onSave, onClose, uploadingImages }) => {
    const { currency, convertPrice, convertToUSD, getCurrencySymbol } = useCurrency();
    const [newTag, setNewTag] = useState("");
    const [newImage, setNewImage] = useState("");

    const handleAddTag = () => {
        if (newTag.trim() && !product.tags.includes(newTag.trim())) {
            setProduct({
                ...product,
                tags: [...product.tags, newTag.trim()],
            });
            setNewTag("");
        }
    };

    const handleRemoveTag = (tagToRemove) => {
        setProduct({
            ...product,
            tags: product.tags.filter((tag) => tag !== tagToRemove),
        });
    };

    const handleAddImage = () => {
        if (newImage.trim()) {
            setProduct({
                ...product,
                images: [...product.images, { url: newImage.trim() }],
            });
            setNewImage("");
        }
    };

    const handleRemoveImage = (indexToRemove) => {
        setProduct({
            ...product,
            images: product.images.filter((_, index) => index !== indexToRemove),
        });
    };

    const handleSetMainImage = (url) => {
        setProduct({
            ...product,
            image: url,
        });
    };

    const handleSubmit = (e) => {
        e.preventDefault(); // prevent browser refresh
        onSave(); // your save function
    };


    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/20 backdrop-blur-sm flex items-center justify-center p-4 z-50 overflow-y-auto"
        >
            <motion.div
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.9, opacity: 0 }}
                className="bg-white rounded-xl shadow-lg max-w-4xl w-full max-h-[90vh] overflow-y-auto"
            >
                {/* Header */}
                <div className="p-6 border-b border-gray-200 flex justify-between items-center">
                    <h3 className="text-lg font-medium text-gray-900">
                        {product._id ? "Edit Product" : "Add New Product"}
                    </h3>
                    <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
                        <X size={24} />
                    </button>
                </div>

                {/* Form Content */}
                <form
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            e.preventDefault();
                        }
                    }}
                    onSubmit={handleSubmit} className="p-6 space-y-6">

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        {/* Required fields */}
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                                Product Name *
                            </label>
                            <input
                                type="text"
                                required
                                disabled={uploadingImages}
                                value={product.name}
                                onChange={(e) => setProduct({ ...product, name: e.target.value })}
                                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
                                placeholder="Enter product name"
                            />
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                                Brand *
                            </label>
                            <input
                                type="text"
                                required
                                disabled={uploadingImages}
                                value={product.brand}
                                onChange={(e) => setProduct({ ...product, brand: e.target.value })}
                                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
                                placeholder="Enter brand name"
                            />
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                                Category *
                            </label>
                            <input
                                type="text"
                                required
                                disabled={uploadingImages}
                                value={product.category}
                                onChange={(e) =>
                                    setProduct({ ...product, category: e.target.value })
                                }
                                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
                                placeholder="Enter category"
                            />
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                                Stock *
                            </label>
                            <input
                                type="number"
                                min={0}
                                required
                                disabled={uploadingImages}
                                value={product.stock}
                                onChange={(e) =>
                                    setProduct({ ...product, stock: Math.round(e.target.value) || 0 })
                                }
                                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
                                placeholder="Enter stock quantity"
                            />
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                                Price ({getCurrencySymbol()}) *
                                <span className="text-xs text-gray-500 ml-2">in {currency}</span>
                            </label>
                            <div className="relative">
                                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 font-medium">
                                    {getCurrencySymbol()}
                                </span>
                                <input
                                    type="number"
                                    min="0"
                                    step="0.01"
                                    required
                                    disabled={uploadingImages}
                                    value={convertPrice(product.price).toFixed(2)}
                                    onChange={(e) => {
                                        const priceInCurrency = parseFloat(e.target.value) || 0;
                                        const priceInUSD = convertToUSD(priceInCurrency);
                                        setProduct({
                                            ...product,
                                            price: priceInUSD,
                                        });
                                    }}
                                    className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
                                    placeholder={`Enter price in ${currency}`}
                                />
                            </div>
                        </div>

                        {/* Optional discounted price */}
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                                Discounted Price ({getCurrencySymbol()})
                                <span className="text-xs text-gray-500 ml-2">in {currency}</span>
                            </label>
                            <div className="relative">
                                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 font-medium">
                                    {getCurrencySymbol()}
                                </span>
                                <input
                                    type="number"
                                    min="0"
                                    step="0.01"
                                    disabled={uploadingImages}
                                    value={product.discountedPrice ? convertPrice(product.discountedPrice).toFixed(2) : ''}
                                    onChange={(e) => {
                                        const priceInCurrency = parseFloat(e.target.value) || 0;
                                        const priceInUSD = convertToUSD(priceInCurrency);
                                        setProduct({
                                            ...product,
                                            discountedPrice: priceInUSD,
                                        });
                                    }}
                                    className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
                                    placeholder={`Enter discounted price in ${currency} (optional)`}
                                />
                            </div>
                        </div>
                    </div>

                    {/* Required Description */}
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                            Description *
                        </label>
                        <textarea
                            required
                            disabled={uploadingImages}
                            value={product.description}
                            onChange={(e) =>
                                setProduct({ ...product, description: e.target.value })
                            }
                            rows={3}
                            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
                            placeholder="Enter product description"
                        />
                    </div>

                    {/* Required Main Image */}
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                            Main Image *
                        </label>
                        
                        {/* Tab Selection */}
                        <div className="flex gap-2 mb-3">
                            <button
                                type="button"
                                onClick={() => setProduct({ ...product, imageInputType: 'url' })}
                                className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                                    (product.imageInputType || 'url') === 'url'
                                        ? 'bg-blue-100 text-blue-700 border-2 border-blue-500'
                                        : 'bg-gray-100 text-gray-600 border-2 border-gray-200'
                                }`}
                            >
                                URL
                            </button>
                            <button
                                type="button"
                                onClick={() => setProduct({ ...product, imageInputType: 'file' })}
                                className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                                    product.imageInputType === 'file'
                                        ? 'bg-blue-100 text-blue-700 border-2 border-blue-500'
                                        : 'bg-gray-100 text-gray-600 border-2 border-gray-200'
                                }`}
                            >
                                Upload File
                            </button>
                        </div>

                        {/* URL Input */}
                        {(product.imageInputType || 'url') === 'url' && (
                            <input
                                type="text"
                                required={!product.image}
                                value={product.image || ''}
                                onChange={(e) => setProduct({ ...product, image: e.target.value })}
                                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                                placeholder="Enter main image URL"
                            />
                        )}

                        {/* File Upload */}
                        {product.imageInputType === 'file' && (
                            <div>
                                <input
                                    type="file"
                                    accept="image/*"
                                    onChange={(e) => {
                                        const file = e.target.files[0];
                                        if (file) {
                                            if (file.size > 5 * 1024 * 1024) {
                                                alert('File size should be less than 5MB');
                                                e.target.value = '';
                                                return;
                                            }
                                            // Store file object for later upload
                                            setProduct({ ...product, imageFile: file, image: URL.createObjectURL(file) });
                                        }
                                    }}
                                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
                                />
                                <p className="text-xs text-gray-500 mt-1">Max file size: 5MB (will upload when you save)</p>
                            </div>
                        )}

                        {product.image && (
                            <div className="mt-2">
                                <img
                                    src={product.image}
                                    alt="Main preview"
                                    className="h-40 object-cover rounded-lg"
                                />
                            </div>
                        )}
                    </div>

                    {/* Additional Images (optional) */}
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                            Additional Images
                        </label>
                        
                        {/* Tab Selection for Additional Images */}
                        <div className="flex gap-2 mb-3">
                            <button
                                type="button"
                                onClick={() => setProduct({ ...product, additionalImageInputType: 'url' })}
                                className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                                    (product.additionalImageInputType || 'url') === 'url'
                                        ? 'bg-blue-100 text-blue-700 border-2 border-blue-500'
                                        : 'bg-gray-100 text-gray-600 border-2 border-gray-200'
                                }`}
                            >
                                URL
                            </button>
                            <button
                                type="button"
                                onClick={() => setProduct({ ...product, additionalImageInputType: 'file' })}
                                className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                                    product.additionalImageInputType === 'file'
                                        ? 'bg-blue-100 text-blue-700 border-2 border-blue-500'
                                        : 'bg-gray-100 text-gray-600 border-2 border-gray-200'
                                }`}
                            >
                                Upload File
                            </button>
                        </div>

                        {/* URL Input */}
                        {(product.additionalImageInputType || 'url') === 'url' && (
                            <div className="flex space-x-2">
                                <input
                                    type="text"
                                    value={newImage}
                                    onChange={(e) => setNewImage(e.target.value)}
                                    className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                                    placeholder="Enter image URL"
                                />
                                <motion.button
                                    type='button'
                                    whileHover={{ scale: 1.05 }}
                                    whileTap={{ scale: 0.95 }}
                                    onClick={handleAddImage}
                                    className="bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-2 rounded-lg transition-colors"
                                >
                                    Add
                                </motion.button>
                            </div>
                        )}

                        {/* File Upload */}
                        {product.additionalImageInputType === 'file' && (
                            <div>
                                <input
                                    type="file"
                                    accept="image/*"
                                    onChange={(e) => {
                                        const file = e.target.files[0];
                                        if (file) {
                                            if (file.size > 5 * 1024 * 1024) {
                                                alert('File size should be less than 5MB');
                                                e.target.value = '';
                                                return;
                                            }
                                            // Store file object and create preview
                                            const imageFiles = product.imageFiles || [];
                                            imageFiles.push(file);
                                            setProduct({
                                                ...product,
                                                imageFiles: imageFiles,
                                                images: [...product.images, { url: URL.createObjectURL(file), isFile: true }],
                                            });
                                            e.target.value = '';
                                        }
                                    }}
                                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
                                />
                                <p className="text-xs text-gray-500 mt-1">Max file size: 5MB (will upload when you save)</p>
                            </div>
                        )}

                        {product.images.length > 0 && (
                            <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-4">
                                {product.images.map((img, index) => (
                                    <div key={index} className="relative group">
                                        <img
                                            src={img.url}
                                            alt={`Product view ${index + 1}`}
                                            className="h-32 w-full object-cover rounded-lg"
                                        />
                                        <div className="absolute inset-0 bg-black bg-opacity-50 opacity-0 group-hover:opacity-100 flex items-center justify-center space-x-2 transition-opacity rounded-lg">
                                            <button
                                                onClick={() => handleSetMainImage(img.url)}
                                                className="p-1 bg-white rounded-full text-blue-600"
                                                title="Set as main image"
                                            >
                                                <Star size={16} />
                                            </button>
                                            <button
                                                onClick={() => handleRemoveImage(index)}
                                                className="p-1 bg-white rounded-full text-red-600"
                                                title="Remove image"
                                            >
                                                <X size={16} />
                                            </button>
                                        </div>
                                        {img.url === product.image && (
                                            <div className="absolute top-2 left-2 bg-indigo-600 text-white text-xs px-2 py-1 rounded-full">
                                                Main
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* Tags (optional) */}
                    <div>
                        <div className="flex justify-between items-center mb-1">
                            <label className="block text-sm font-medium text-gray-700">
                                Tags
                            </label>
                            <div className="flex space-x-2">
                                <input
                                    type="text"
                                    value={newTag}
                                    onChange={(e) => setNewTag(e.target.value)}
                                    className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                                    placeholder="Enter tag"
                                />
                                <motion.button
                                    type='button'

                                    whileHover={{ scale: 1.05 }}
                                    whileTap={{ scale: 0.95 }}
                                    onClick={handleAddTag}
                                    className="bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-2 rounded-lg transition-colors"
                                >
                                    Add
                                </motion.button>
                            </div>
                        </div>

                        {product.tags.length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-2">
                                {product.tags.map((tag, index) => (
                                    <span
                                        key={index}
                                        className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-blue-100 text-blue-800"
                                    >
                                        {tag}
                                        <button
                                            type="button"
                                            onClick={() => handleRemoveTag(tag)}
                                            className="ml-1.5 rounded-full flex-shrink-0 text-blue-600 hover:text-blue-800"
                                        >
                                            <X size={14} />
                                        </button>
                                    </span>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* Feature checkbox */}
                    <div className="flex items-center">
                        <input
                            id="featured"
                            type="checkbox"
                            disabled={uploadingImages}
                            checked={product.isFeatured}
                            onChange={(e) =>
                                setProduct({ ...product, isFeatured: e.target.checked })
                            }
                            className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded disabled:opacity-50 disabled:cursor-not-allowed"
                        />
                        <label htmlFor="featured" className="ml-2 block text-sm text-gray-900">
                            Feature this product on homepage
                        </label>
                    </div>



                    {/* Footer */}
                    <div className="px-6 py-4 bg-gray-50 border-t border-gray-200 flex justify-end space-x-3">
                        <button
                            type="button"
                            onClick={onClose}
                            disabled={uploadingImages}
                            className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            Cancel
                        </button>
                        <motion.button
                            type="submit"
                            disabled={uploadingImages}
                            whileHover={!uploadingImages ? { scale: 1.02 } : {}}
                            whileTap={!uploadingImages ? { scale: 0.98 } : {}}
                            className="px-4 py-2 bg-linear-to-r from-indigo-600 to-sky-500 hover:from-indigo-700 hover:to-sky-600 text-white rounded-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 transition-colors"
                        >
                            {uploadingImages && (
                                <svg className="animate-spin h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                </svg>
                            )}
                            {uploadingImages ? 'Uploading...' : (product._id ? "Update Product" : "Create Product")}
                        </motion.button>
                    </div>
                </form>
            </motion.div>
        </motion.div >
    );
};



// import { motion } from "framer-motion";
// import { Edit, Trash2 } from "lucide-react";





export default AdminDashboard;