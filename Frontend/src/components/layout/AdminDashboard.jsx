import React, { useState, useEffect, useMemo, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
    BarChart3, Package, Plus, Edit, Trash2, Search, Filter,
    ChevronLeft, ChevronRight, X, Home, Tag, Star,
    Image as ImageIcon, DollarSign, Hash, BookOpen, Grid,
    CheckSquare, AlertCircle, Menu, TriangleAlert, TrafficCone,
    LayoutPanelLeft, ShoppingBag, Users, CheckCircle, Bell,
    Settings, TrendingUp, Info, AlertTriangle, Loader2,
    Shield, Store,
} from 'lucide-react';
import { uploadImageToCloudinary } from '../../utils/uploadToCloudinary';
import axios from 'axios';
import { useAuth } from '../../contexts/AuthContext';
import { toast } from 'react-toastify';
import { Link, Navigate, Outlet, useLocation } from 'react-router-dom';
import GlassBackground from '../common/GlassBackground';
import { useCurrency } from '../../contexts/CurrencyContext';


const AdminDashboard = () => {
    const { currentUser } = useAuth();
    const [isMobile, setIsMobile] = useState(false);

    useEffect(() => {
        const checkIsMobile = () => setIsMobile(window.innerWidth < 1024);
        checkIsMobile();
        window.addEventListener('resize', checkIsMobile);
        return () => window.removeEventListener('resize', checkIsMobile);
    }, []);

    const [activeTab, setActiveTab] = useState('overview');
    const [products, setProducts] = useState([]);
    const [orders, setOrders] = useState([]);
    const [editingProduct, setEditingProduct] = useState(null);
    const [isFormOpen, setIsFormOpen] = useState(false);
    const [searchTerm, setSearchTerm] = useState('');
    const [categories, setCategories] = useState([]);
    const [selectedCategory, setSelectedCategory] = useState('all');
    const [deleteConfirm, setDeleteConfirm] = useState(null);
    const [loading, setLoading] = useState(true);
    const [uploadingImages, setUploadingImages] = useState(false);
    const [isSidebarOpen, setIsSidebarOpen] = useState(false);
    const [notificationsOpen, setNotificationsOpen] = useState(false);
    const [notifications, setNotifications] = useState([]);
    const [notificationsLoading, setNotificationsLoading] = useState(false);
    const notifRef = useRef(null);

    const fetchFilters = async () => {
        try {
            const res = await axios.get(`${import.meta.env.VITE_API_URL}api/products/get-filters`);
            setCategories(res.data.categories);
        } catch (error) { console.error(error); setCategories([]); }
    };

    useEffect(() => { fetchFilters(); }, []);

    const fetchProducts = async () => {
        setLoading(true);
        try {
            const query = serializeFilters();
            const res = await axios.get(`${import.meta.env.VITE_API_URL}api/products/get-products?${query}`);
            setProducts(res.data.products);
        } catch (err) { console.log(err); } finally { setLoading(false); }
    };

    const serializeFilters = () => {
        let params = new URLSearchParams();
        if (selectedCategory !== 'all') params.append('categories', selectedCategory);
        if (searchTerm !== '') params.append('search', searchTerm);
        return params.toString();
    };

    useEffect(() => { fetchProducts(); fetchOrders(); }, [searchTerm, selectedCategory]);

    const handleCreateProduct = () => {
        setEditingProduct({
            name: '', description: '', price: '', discountedPrice: "",
            category: '', brand: '', stock: "", image: '', images: [],
            tags: [], isFeatured: false
        });
        setIsFormOpen(true);
    };

    const handleEditProduct = (product) => { setEditingProduct({ ...product }); setIsFormOpen(true); };

    const handleSaveProduct = async () => {
        setUploadingImages(true);
        try {
            if (editingProduct.imageFile) {
                const imageUrl = await uploadImageToCloudinary(editingProduct.imageFile);
                editingProduct.image = imageUrl;
                delete editingProduct.imageFile;
            }
            if (editingProduct.imageFiles && editingProduct.imageFiles.length > 0) {
                const uploadedUrls = await Promise.all(editingProduct.imageFiles.map(file => uploadImageToCloudinary(file)));
                const existingImages = editingProduct.images.filter(img => !img.isFile);
                const newImages = uploadedUrls.map(url => ({ url }));
                editingProduct.images = [...existingImages, ...newImages];
                delete editingProduct.imageFiles;
            }
            if (editingProduct.images) {
                editingProduct.images = editingProduct.images.map(img => ({ url: img.url }));
            }
        } catch (error) { setUploadingImages(false); toast.error(error.message || 'Failed to upload images'); return; }

        if (editingProduct._id) {
            try {
                const token = localStorage.getItem('jwtToken');
                const res = await axios.put(`${import.meta.env.VITE_API_URL}api/products/edit/${editingProduct._id}`,
                    { product: editingProduct }, { headers: { Authorization: `Bearer ${token}` } });
                toast.success(res.data.msg); fetchProducts(); fetchFilters();
            } catch (error) { toast.error(error.response?.data?.msg || 'Failed'); }
        } else {
            try {
                const token = localStorage.getItem('jwtToken');
                const res = await axios.post(`${import.meta.env.VITE_API_URL}api/products/add`,
                    { product: editingProduct }, { headers: { Authorization: `Bearer ${token}` } });
                toast.success(res.data.msg); fetchProducts(); fetchFilters();
            } catch (error) { toast.error(error.response?.data?.msg || 'Failed'); }
        }
        setUploadingImages(false); setIsFormOpen(false); setEditingProduct(null);
    };

    const handleDeleteProduct = async (id) => {
        try {
            const token = localStorage.getItem('jwtToken');
            const res = await axios.delete(`${import.meta.env.VITE_API_URL}api/products/delete/${id}`,
                { headers: { Authorization: `Bearer ${token}` } });
            toast.success(res.data.msg || 'success'); fetchProducts();
        } catch (error) { toast.error(error.response?.data?.msg || 'Failed to delete product'); }
        setDeleteConfirm(null);
    };

    const fetchOrders = async () => {
        const token = localStorage.getItem('jwtToken');
        try {
            const query = serializeFilters();
            const res = await axios.get(`${import.meta.env.VITE_API_URL}api/order/get?${query}`,
                { headers: { Authorization: `Bearer ${token}` } });
            setOrders(res.data?.orders || []);
        } catch (error) { console.error(error); setOrders([]); }
    };

    const pendingOrders = orders.filter(o => o.orderStatus === 'pending').length;
    const lowStockProducts = products.filter(p => p.stock <= 10 && p.stock > 0).length;
    const outOfStockProducts = products.filter(p => p.stock === 0).length;

    const outletContext = useMemo(() => ({
        products, orders, categories, searchTerm, setSearchTerm,
        selectedCategory, setSelectedCategory, deleteConfirm, setDeleteConfirm,
        handleEditProduct, handleCreateProduct, handleDeleteProduct, loading, fetchProducts
    }), [products, orders, categories, searchTerm, selectedCategory, deleteConfirm, loading]);

    const location = useLocation();

    const getPageTitle = () => {
        const path = location.pathname;
        if (path.includes('store-overview')) return 'Store Overview';
        if (path.includes('analytics')) return 'Analytics';
        if (path.includes('user-management')) return 'User Management';
        if (path.includes('product-management')) return 'Product Management';
        if (path.includes('order-management')) return 'Order Management';
        if (path.includes('store-verifications')) return 'Store Verifications';
        if (path.includes('tax-configuration')) return 'Tax Configuration';
        if (path.includes('notifications')) return 'Notifications';
        if (path.includes('notification-settings')) return 'Settings';
        return 'Admin Dashboard';
    };

    // Fetch notifications from backend API
    const fetchNotifications = async () => {
        setNotificationsLoading(true);
        const token = localStorage.getItem('jwtToken');
        try {
            const res = await axios.get(`${import.meta.env.VITE_API_URL}api/analytics/admin/notifications`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            setNotifications(res.data.notifications || []);
        } catch {
            // Fallback to local data
            const notifs = [];
            products.filter(p => p.stock === 0).forEach(p => {
                notifs.push({ id: `s-${p._id}`, type: 'critical', title: `${p.name} is out of stock`, description: 'Update inventory', time: new Date().toISOString() });
            });
            orders.filter(o => o.orderStatus === 'pending').slice(0, 5).forEach(o => {
                notifs.push({ id: `o-${o._id}`, type: 'info', title: `Pending order #${o.orderId}`, description: o.shippingInfo?.fullName || '', time: o.createdAt });
            });
            setNotifications(notifs);
        } finally { setNotificationsLoading(false); }
    };

    const handleBellClick = () => {
        if (!notificationsOpen) fetchNotifications();
        setNotificationsOpen(!notificationsOpen);
    };

    useEffect(() => {
        const handler = (e) => {
            if (notifRef.current && !notifRef.current.contains(e.target)) setNotificationsOpen(false);
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, []);

    return (
        <div className="min-h-screen relative flex" style={{ background: 'linear-gradient(135deg, hsl(230, 35%, 88%) 0%, hsl(210, 40%, 90%) 25%, hsl(250, 30%, 92%) 50%, hsl(200, 35%, 88%) 75%, hsl(280, 25%, 90%) 100%)', backgroundAttachment: 'fixed' }}>
            <GlassBackground />

            {/* Sidebar */}
            <AdminSidebar
                activeTab={activeTab}
                setActiveTab={setActiveTab}
                isSidebarOpen={isSidebarOpen}
                setIsSidebarOpen={setIsSidebarOpen}
                isMobile={isMobile}
                pendingOrders={pendingOrders}
                lowStockProducts={lowStockProducts + outOfStockProducts}
            />

            {/* Main Content */}
            <div className={`flex-1 flex flex-col min-h-screen ${!isMobile ? 'ml-64' : ''}`}>
                {/* Top Header Bar */}
                <div className="sticky top-0 z-30 mx-4 mt-4 glass-panel-strong" style={{ borderRadius: 20, borderBottom: '1px solid var(--glass-border)' }}>
                    <div className="flex items-center justify-between px-4 sm:px-6 py-3">
                        <div className="flex items-center gap-3">
                            {isMobile && (
                                <motion.button whileTap={{ scale: 0.95 }} onClick={() => setIsSidebarOpen(true)}
                                    className="p-2 rounded-xl glass-inner" style={{ color: 'hsl(var(--foreground))' }}>
                                    <Menu size={20} />
                                </motion.button>
                            )}
                            <div>
                                <h1 className="text-lg font-bold" style={{ color: 'hsl(var(--foreground))' }}>{getPageTitle()}</h1>
                                <p className="text-xs hidden sm:block" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                    Welcome back, {currentUser?.username || 'Admin'}
                                </p>
                            </div>
                        </div>

                        <div className="flex items-center gap-2 sm:gap-3">
                            {/* Notifications Bell */}
                            <div className="relative" ref={notifRef}>
                                <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}
                                    onClick={handleBellClick}
                                    className="p-2.5 rounded-xl glass-inner relative" style={{ color: 'hsl(var(--foreground))' }}>
                                    <Bell size={18} />
                                    {(pendingOrders + lowStockProducts + outOfStockProducts) > 0 && (
                                        <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] flex items-center justify-center rounded-full text-[10px] font-bold text-white px-1"
                                            style={{ background: 'hsl(0, 72%, 55%)' }}>
                                            {pendingOrders + lowStockProducts + outOfStockProducts}
                                        </span>
                                    )}
                                </motion.button>

                                {/* Notifications Dropdown */}
                                <AnimatePresence>
                                    {notificationsOpen && (
                                        <motion.div
                                            initial={{ opacity: 0, y: 8, scale: 0.96 }}
                                            animate={{ opacity: 1, y: 0, scale: 1 }}
                                            exit={{ opacity: 0, y: 8, scale: 0.96 }}
                                            transition={{ duration: 0.2 }}
                                            className="absolute right-0 top-full mt-2 w-80 sm:w-96 overflow-hidden z-50 glass-panel-strong"
                                            style={{ maxHeight: '70vh' }}>
                                            <div className="p-4 flex items-center justify-between" style={{ borderBottom: '1px solid var(--glass-border)' }}>
                                                <h3 className="text-sm font-bold" style={{ color: 'hsl(var(--foreground))' }}>Notifications</h3>
                                                <span className="text-[10px] font-medium px-2 py-0.5 rounded-full"
                                                    style={{ background: 'rgba(99,102,241,0.12)', color: 'hsl(220,70%,55%)' }}>
                                                    {notifications.length} alerts
                                                </span>
                                            </div>
                                            <div className="overflow-y-auto" style={{ maxHeight: 'calc(70vh - 60px)' }}>
                                                {notificationsLoading ? (
                                                    <div className="flex items-center justify-center py-8">
                                                        <Loader2 size={20} className="animate-spin" style={{ color: 'hsl(var(--muted-foreground))' }} />
                                                    </div>
                                                ) : notifications.length === 0 ? (
                                                    <div className="text-center py-8 px-4">
                                                        <Bell size={28} style={{ color: 'hsl(var(--muted-foreground))' }} className="mx-auto mb-2 opacity-50" />
                                                        <p className="text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>All caught up!</p>
                                                    </div>
                                                ) : (
                                                    <div className="p-2 space-y-1">
                                                        {notifications.map((n, i) => {
                                                            const iconMap = { critical: <AlertTriangle size={14} />, warning: <AlertTriangle size={14} />, info: <Info size={14} />, success: <CheckCircle size={14} /> };
                                                            const colorMap = {
                                                                critical: { bg: 'rgba(239,68,68,0.12)', color: 'hsl(0,72%,55%)' },
                                                                warning: { bg: 'rgba(245,158,11,0.12)', color: 'hsl(45,80%,40%)' },
                                                                info: { bg: 'rgba(99,102,241,0.12)', color: 'hsl(220,70%,55%)' },
                                                                success: { bg: 'rgba(16,185,129,0.12)', color: 'hsl(150,60%,45%)' },
                                                            };
                                                            const cs = colorMap[n.type] || colorMap.info;
                                                            return (
                                                                <motion.div key={n.id || i}
                                                                    initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.03 }}
                                                                    className="flex items-start gap-3 p-3 rounded-xl transition-all hover:bg-white/5">
                                                                    <div className="p-1.5 rounded-lg mt-0.5 shrink-0" style={{ background: cs.bg, color: cs.color }}>{iconMap[n.type]}</div>
                                                                    <div className="flex-1 min-w-0">
                                                                        <p className="text-xs font-semibold truncate" style={{ color: 'hsl(var(--foreground))' }}>{n.title}</p>
                                                                        {n.description && <p className="text-[11px] mt-0.5 truncate" style={{ color: 'hsl(var(--muted-foreground))' }}>{n.description}</p>}
                                                                        <p className="text-[10px] mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                                                            {n.time ? new Date(n.time).toLocaleDateString('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Just now'}
                                                                        </p>
                                                                    </div>
                                                                </motion.div>
                                                            );
                                                        })}
                                                    </div>
                                                )}
                                            </div>
                                        </motion.div>
                                    )}
                                </AnimatePresence>
                            </div>

                            {/* Admin Avatar */}
                            <motion.div whileHover={{ scale: 1.05 }} className="flex items-center gap-2 cursor-pointer">
                                <div className="w-8 h-8 rounded-xl flex items-center justify-center text-sm font-bold border"
                                    style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))', color: 'white', borderColor: 'rgba(255,255,255,0.3)' }}>
                                    {currentUser?.username?.[0]?.toUpperCase() || 'A'}
                                </div>
                                <span className="hidden md:block text-sm font-medium" style={{ color: 'hsl(var(--foreground))' }}>
                                    {currentUser?.username || 'Admin'}
                                </span>
                            </motion.div>
                        </div>
                    </div>

                    {/* Alert Bar */}
                    {(pendingOrders > 0 || outOfStockProducts > 0) && (
                        <div className="px-4 sm:px-6 pb-3">
                            <div className="flex flex-wrap gap-2">
                                {pendingOrders > 0 && (
                                    <Link to="/admin-dashboard/order-management">
                                        <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-all hover:scale-[1.02]"
                                            style={{ background: 'rgba(249, 115, 22, 0.12)', color: 'hsl(30, 90%, 45%)' }}>
                                            <ShoppingBag size={12} /> {pendingOrders} pending order{pendingOrders > 1 ? 's' : ''}
                                        </span>
                                    </Link>
                                )}
                                {outOfStockProducts > 0 && (
                                    <Link to="/admin-dashboard/product-management">
                                        <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-all hover:scale-[1.02]"
                                            style={{ background: 'rgba(239, 68, 68, 0.12)', color: 'hsl(0, 72%, 50%)' }}>
                                            <Package size={12} /> {outOfStockProducts} out of stock
                                        </span>
                                    </Link>
                                )}
                            </div>
                        </div>
                    )}
                </div>

                {/* Page Content */}
                <div className="flex-1">
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
                        onClose={() => { setIsFormOpen(false); setEditingProduct(null); }}
                        uploadingImages={uploadingImages}
                    />
                )}
            </AnimatePresence>
        </div>
    );
};

// ============================
// Admin Sidebar Component
// ============================
const AdminSidebar = ({ activeTab, setActiveTab, isSidebarOpen, setIsSidebarOpen, isMobile, pendingOrders, lowStockProducts }) => {
    const { currentUser } = useAuth();
    const location = useLocation();

    const menuItems = [
        { id: 'overview', label: 'Store Overview', icon: <BarChart3 size={18} />, link: '/admin-dashboard/store-overview' },
        { id: 'analytics', label: 'Analytics', icon: <TrendingUp size={18} />, link: '/admin-dashboard/analytics' },
        { id: 'users', label: 'User Management', icon: <Users size={18} />, link: '/admin-dashboard/user-management' },
        { id: 'products', label: 'Products', icon: <Package size={18} />, link: '/admin-dashboard/product-management', badge: lowStockProducts },
        { id: 'orders', label: 'Orders', icon: <ShoppingBag size={18} />, link: '/admin-dashboard/order-management', badge: pendingOrders },
        { id: 'verifications', label: 'Verifications', icon: <CheckCircle size={18} />, link: '/admin-dashboard/store-verifications' },
        { id: 'tax', label: 'Tax Config', icon: <DollarSign size={18} />, link: '/admin-dashboard/tax-configuration' },
        { id: 'notifications', label: 'Notifications', icon: <Bell size={18} />, link: '/admin-dashboard/notifications' },
        { id: 'settings', label: 'Settings', icon: <Settings size={18} />, link: '/admin-dashboard/notification-settings' },
    ];

    useEffect(() => {
        menuItems.forEach(item => { if (location.pathname.includes(item.link.split('/').pop())) setActiveTab(item.id); });
    }, [location]);

    const handleTabClick = (tabId) => { setActiveTab(tabId); if (isMobile) setIsSidebarOpen(false); };

    return (
        <>
            {/* Mobile Overlay */}
            <AnimatePresence>
                {isMobile && isSidebarOpen && (
                    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                        className="fixed inset-0 bg-black/50 backdrop-blur-sm z-40"
                        onClick={() => setIsSidebarOpen(false)} />
                )}
            </AnimatePresence>

            {/* Sidebar */}
            <motion.div
                initial={isMobile ? { x: '-100%' } : false}
                animate={isMobile ? { x: isSidebarOpen ? 0 : '-100%' } : { x: 0 }}
                transition={{ type: 'tween', ease: 'easeInOut', duration: 0.28 }}
                className="fixed top-0 left-0 h-full w-64 z-50 shadow-2xl overflow-hidden"
            >
                <div className="flex flex-col h-full glass-panel-strong water-shimmer" style={{ borderRadius: '0 28px 28px 0' }}>
                    {/* Logo / Brand */}
                    <div className="px-5 pt-6 pb-4">
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-3">
                                <div className="w-10 h-10 rounded-xl flex items-center justify-center font-bold text-sm border"
                                    style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))', color: 'white', borderColor: 'rgba(255,255,255,0.3)' }}>
                                    <Shield size={20} />
                                </div>
                                <div>
                                    <p className="text-sm font-bold" style={{ color: 'hsl(var(--foreground))' }}>Admin Panel</p>
                                    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full"
                                        style={{ background: 'rgba(99, 102, 241, 0.15)', color: 'hsl(220, 70%, 55%)' }}>
                                        Administrator
                                    </span>
                                </div>
                            </div>
                            {isMobile && (
                                <button onClick={() => setIsSidebarOpen(false)} className="p-1.5 rounded-lg glass-inner transition-colors"
                                    style={{ color: 'hsl(var(--muted-foreground))' }}>
                                    <X size={16} />
                                </button>
                            )}
                        </div>
                    </div>

                    <div className="mx-4 h-px" style={{ background: 'var(--glass-border)' }} />

                    {/* Navigation */}
                    <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
                        <p className="text-[10px] font-semibold uppercase tracking-wider px-3 mb-2" style={{ color: 'hsl(var(--muted-foreground))' }}>
                            Management
                        </p>
                        {menuItems.map(item => {
                            const isActive = activeTab === item.id;
                            return (
                                <Link key={item.id} to={item.link}>
                                    <motion.button whileHover={{ x: 2 }} onClick={() => handleTabClick(item.id)}
                                        className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all ${isActive ? 'border shadow-sm' : 'hover:bg-white/8'}`}
                                        style={isActive ? {
                                            background: 'rgba(99, 102, 241, 0.12)',
                                            color: 'hsl(var(--foreground))',
                                            borderColor: 'rgba(99, 102, 241, 0.25)'
                                        } : { color: 'hsl(var(--muted-foreground))' }}>
                                        <span style={{ color: isActive ? 'hsl(220, 70%, 55%)' : 'hsl(var(--muted-foreground))' }}>{item.icon}</span>
                                        {item.label}
                                        {item.badge > 0 && (
                                            <span className="ml-auto min-w-[20px] h-5 flex items-center justify-center rounded-full text-[10px] font-bold text-white px-1.5"
                                                style={{ background: 'hsl(0, 72%, 55%)' }}>
                                                {item.badge > 99 ? '99+' : item.badge}
                                            </span>
                                        )}
                                        {isActive && !item.badge && <div className="ml-auto w-1.5 h-1.5 rounded-full" style={{ background: 'hsl(220, 70%, 55%)' }} />}
                                    </motion.button>
                                </Link>
                            );
                        })}
                    </nav>

                    {/* Footer */}
                    <div className="px-3 pb-5 pt-3" style={{ borderTop: '1px solid var(--glass-border)' }}>
                        <Link to="/">
                            <motion.button whileHover={{ x: 2 }}
                                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all"
                                style={{ color: 'hsl(var(--muted-foreground))' }}>
                                <ChevronLeft size={18} />
                                Back to Store
                            </motion.button>
                        </Link>
                    </div>
                </div>
            </motion.div>
        </>
    );
};


// ============================
// Product Form (Glass Design)
// ============================
const ProductForm = ({ product, setProduct, onSave, onClose, uploadingImages }) => {
    const { currency, convertPrice, convertToUSD, getCurrencySymbol } = useCurrency();
    const [newTag, setNewTag] = useState("");
    const [newImage, setNewImage] = useState("");

    const handleAddTag = () => {
        if (newTag.trim() && !product.tags.includes(newTag.trim())) {
            setProduct({ ...product, tags: [...product.tags, newTag.trim()] });
            setNewTag("");
        }
    };
    const handleRemoveTag = (tagToRemove) => setProduct({ ...product, tags: product.tags.filter(tag => tag !== tagToRemove) });
    const handleAddImage = () => {
        if (newImage.trim()) {
            setProduct({ ...product, images: [...product.images, { url: newImage.trim() }] });
            setNewImage("");
        }
    };
    const handleRemoveImage = (indexToRemove) => setProduct({ ...product, images: product.images.filter((_, index) => index !== indexToRemove) });
    const handleSetMainImage = (url) => setProduct({ ...product, image: url });
    const handleSubmit = (e) => { e.preventDefault(); onSave(); };

    const inputClass = "glass-input w-full";
    const labelClass = "block text-xs font-semibold uppercase tracking-wider mb-2";

    return (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/50 backdrop-blur-md flex items-start justify-center p-4 pt-8 sm:pt-12 z-50 overflow-y-auto">
            <motion.div initial={{ scale: 0.92, opacity: 0, y: 30 }} animate={{ scale: 1, opacity: 1, y: 0 }} exit={{ scale: 0.92, opacity: 0, y: 30 }}
                transition={{ type: 'spring', damping: 25, stiffness: 300 }}
                className="w-full max-w-4xl mb-8 glass-panel-strong"
                style={{ boxShadow: '0 24px 80px rgba(0,0,0,0.2), 0 8px 32px rgba(0,0,0,0.1)' }}>
                <div className="max-h-[85vh] overflow-y-auto" style={{ borderRadius: 28 }}>

                {/* Header */}
                <div className="sticky top-0 z-10 p-5 sm:p-6 flex justify-between items-center glass-panel-strong" style={{ borderBottom: '1px solid var(--glass-border)', borderRadius: '28px 28px 0 0' }}>
                    <div>
                        <h3 className="text-xl font-bold" style={{ color: 'hsl(var(--foreground))' }}>
                            {product._id ? "Edit Product" : "Add New Product"}
                        </h3>
                        <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                            {product._id ? 'Update product details below' : 'Fill in the details to create a new product'}
                        </p>
                    </div>
                    <motion.button whileHover={{ scale: 1.1, rotate: 90 }} whileTap={{ scale: 0.9 }} onClick={onClose} 
                        className="p-2.5 rounded-xl transition-colors" style={{ background: 'rgba(0,0,0,0.05)', color: 'hsl(var(--muted-foreground))' }}>
                        <X size={20} />
                    </motion.button>
                </div>

                <form onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }} onSubmit={handleSubmit} className="p-6 space-y-6">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                        <div>
                            <label className={labelClass} style={{ color: 'hsl(var(--muted-foreground))' }}>Product Name *</label>
                            <input type="text" required disabled={uploadingImages} value={product.name}
                                onChange={(e) => setProduct({ ...product, name: e.target.value })}
                                className={inputClass} placeholder="Enter product name" />
                        </div>
                        <div>
                            <label className={labelClass} style={{ color: 'hsl(var(--muted-foreground))' }}>Brand *</label>
                            <input type="text" required disabled={uploadingImages} value={product.brand}
                                onChange={(e) => setProduct({ ...product, brand: e.target.value })}
                                className={inputClass} placeholder="Enter brand name" />
                        </div>
                        <div>
                            <label className={labelClass} style={{ color: 'hsl(var(--muted-foreground))' }}>Category *</label>
                            <input type="text" required disabled={uploadingImages} value={product.category}
                                onChange={(e) => setProduct({ ...product, category: e.target.value })}
                                className={inputClass} placeholder="Enter category" />
                        </div>
                        <div>
                            <label className={labelClass} style={{ color: 'hsl(var(--muted-foreground))' }}>Stock *</label>
                            <input type="number" min={0} required disabled={uploadingImages} value={product.stock}
                                onChange={(e) => setProduct({ ...product, stock: Math.round(e.target.value) || 0 })}
                                className={inputClass} placeholder="Enter stock quantity" />
                        </div>
                        <div>
                            <label className={labelClass} style={{ color: 'hsl(var(--muted-foreground))' }}>
                                Price ({getCurrencySymbol()}) * <span className="normal-case font-normal">in {currency}</span>
                            </label>
                            <div className="relative">
                                <span className="absolute left-3 top-1/2 -translate-y-1/2 font-medium" style={{ color: 'hsl(var(--muted-foreground))' }}>{getCurrencySymbol()}</span>
                                <input type="number" min="0" step="0.01" required disabled={uploadingImages}
                                    value={convertPrice(product.price).toFixed(2)}
                                    onChange={(e) => setProduct({ ...product, price: convertToUSD(parseFloat(e.target.value) || 0) })}
                                    className={`${inputClass} pl-10`} placeholder={`Enter price in ${currency}`} />
                            </div>
                        </div>
                        <div>
                            <label className={labelClass} style={{ color: 'hsl(var(--muted-foreground))' }}>
                                Discounted Price ({getCurrencySymbol()}) <span className="normal-case font-normal">in {currency}</span>
                            </label>
                            <div className="relative">
                                <span className="absolute left-3 top-1/2 -translate-y-1/2 font-medium" style={{ color: 'hsl(var(--muted-foreground))' }}>{getCurrencySymbol()}</span>
                                <input type="number" min="0" step="0.01" disabled={uploadingImages}
                                    value={product.discountedPrice ? convertPrice(product.discountedPrice).toFixed(2) : ''}
                                    onChange={(e) => setProduct({ ...product, discountedPrice: convertToUSD(parseFloat(e.target.value) || 0) })}
                                    className={`${inputClass} pl-10`} placeholder={`Discounted price (optional)`} />
                            </div>
                        </div>
                    </div>

                    <div>
                        <label className={labelClass} style={{ color: 'hsl(var(--muted-foreground))' }}>Description *</label>
                        <textarea required disabled={uploadingImages} value={product.description}
                            onChange={(e) => setProduct({ ...product, description: e.target.value })}
                            rows={3} className={inputClass} placeholder="Enter product description" />
                    </div>

                    {/* Main Image */}
                    <div>
                        <label className={labelClass} style={{ color: 'hsl(var(--muted-foreground))' }}>Main Image *</label>
                        <div className="flex gap-2 mb-3">
                            {['url', 'file'].map(type => (
                                <button key={type} type="button"
                                    onClick={() => setProduct({ ...product, imageInputType: type })}
                                    className="flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors"
                                    style={(product.imageInputType || 'url') === type
                                        ? { background: 'rgba(99, 102, 241, 0.15)', color: 'hsl(220, 70%, 55%)', border: '2px solid hsl(220, 70%, 55%)' }
                                        : { background: 'var(--glass-bg)', color: 'hsl(var(--muted-foreground))', border: '2px solid var(--glass-border)' }}>
                                    {type === 'url' ? 'URL' : 'Upload File'}
                                </button>
                            ))}
                        </div>
                        {(product.imageInputType || 'url') === 'url' && (
                            <input type="text" required={!product.image} value={product.image || ''}
                                onChange={(e) => setProduct({ ...product, image: e.target.value })}
                                className={inputClass} placeholder="Enter main image URL" />
                        )}
                        {product.imageInputType === 'file' && (
                            <div>
                                <input type="file" accept="image/*"
                                    onChange={(e) => {
                                        const file = e.target.files[0];
                                        if (file) {
                                            if (file.size > 5 * 1024 * 1024) { alert('File size should be less than 5MB'); e.target.value = ''; return; }
                                            setProduct({ ...product, imageFile: file, image: URL.createObjectURL(file) });
                                        }
                                    }}
                                    className={inputClass} />
                                <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>Max file size: 5MB</p>
                            </div>
                        )}
                        {product.image && <img src={product.image} alt="Main preview" className="mt-2 h-40 object-cover rounded-lg" />}
                    </div>

                    {/* Additional Images */}
                    <div>
                        <label className={labelClass} style={{ color: 'hsl(var(--muted-foreground))' }}>Additional Images</label>
                        <div className="flex gap-2 mb-3">
                            {['url', 'file'].map(type => (
                                <button key={type} type="button"
                                    onClick={() => setProduct({ ...product, additionalImageInputType: type })}
                                    className="flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors"
                                    style={(product.additionalImageInputType || 'url') === type
                                        ? { background: 'rgba(99, 102, 241, 0.15)', color: 'hsl(220, 70%, 55%)', border: '2px solid hsl(220, 70%, 55%)' }
                                        : { background: 'var(--glass-bg)', color: 'hsl(var(--muted-foreground))', border: '2px solid var(--glass-border)' }}>
                                    {type === 'url' ? 'URL' : 'Upload Files'}
                                </button>
                            ))}
                        </div>
                        {(product.additionalImageInputType || 'url') === 'url' && (
                            <div className="flex gap-2">
                                <input type="text" value={newImage} onChange={(e) => setNewImage(e.target.value)}
                                    className={`${inputClass} flex-1`} placeholder="Enter image URL" />
                                <motion.button type="button" whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}
                                    onClick={handleAddImage}
                                    className="px-4 py-2 rounded-xl font-semibold text-sm text-white"
                                    style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(200, 80%, 50%))' }}>
                                    Add
                                </motion.button>
                            </div>
                        )}
                        {product.additionalImageInputType === 'file' && (
                            <div>
                                <input type="file" accept="image/*" multiple
                                    onChange={(e) => {
                                        const files = Array.from(e.target.files);
                                        const valid = files.filter(f => f.size <= 5 * 1024 * 1024);
                                        if (valid.length < files.length) alert('Some files exceeded 5MB and were skipped');
                                        const previews = valid.map(f => ({ url: URL.createObjectURL(f), isFile: true }));
                                        setProduct({
                                            ...product,
                                            images: [...product.images, ...previews],
                                            imageFiles: [...(product.imageFiles || []), ...valid]
                                        });
                                    }}
                                    className={inputClass} />
                                <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>Max 5MB per file</p>
                            </div>
                        )}
                        {product.images?.length > 0 && (
                            <div className="flex flex-wrap gap-2 mt-3">
                                {product.images.map((img, index) => (
                                    <div key={index} className="relative group">
                                        <img src={img.url} alt={`Additional ${index + 1}`} className="h-20 w-20 object-cover rounded-xl"
                                            style={{ border: product.image === img.url ? '2px solid hsl(var(--primary))' : '1px solid var(--glass-border)' }} />
                                        <div className="absolute inset-0 flex gap-1 items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity rounded-xl"
                                            style={{ background: 'rgba(0,0,0,0.5)' }}>
                                            <button type="button" onClick={() => handleSetMainImage(img.url)} className="p-1 rounded bg-white/20 text-white"><Star size={12} /></button>
                                            <button type="button" onClick={() => handleRemoveImage(index)} className="p-1 rounded bg-white/20 text-white"><X size={12} /></button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* Tags */}
                    <div>
                        <label className={labelClass} style={{ color: 'hsl(var(--muted-foreground))' }}>Tags</label>
                        <div className="flex gap-2 mb-2">
                            <input type="text" value={newTag} onChange={(e) => setNewTag(e.target.value)}
                                className={`${inputClass} flex-1`} placeholder="Add a tag" />
                            <motion.button type="button" whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}
                                onClick={handleAddTag}
                                className="px-4 py-2 rounded-xl font-semibold text-sm text-white"
                                style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(200, 80%, 50%))' }}>
                                Add
                            </motion.button>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            {product.tags.map(tag => (
                                <span key={tag} className="tag-pill flex items-center gap-1.5">
                                    {tag}
                                    <button type="button" onClick={() => handleRemoveTag(tag)} className="hover:opacity-70"><X size={12} /></button>
                                </span>
                            ))}
                        </div>
                    </div>

                    {/* Featured */}
                    <label className="glass-checkbox-box flex items-center gap-3 p-4 cursor-pointer">
                        <input type="checkbox" checked={product.isFeatured || false}
                            onChange={(e) => setProduct({ ...product, isFeatured: e.target.checked })}
                            className="hidden" />
                        <div className={`w-5 h-5 rounded flex items-center justify-center transition-colors ${product.isFeatured ? '' : ''}`}
                            style={product.isFeatured ? { background: 'hsl(var(--primary))' } : { background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}>
                            {product.isFeatured && <CheckSquare size={14} className="text-white" />}
                        </div>
                        <div>
                            <p className="text-sm font-medium" style={{ color: 'hsl(var(--foreground))' }}>Featured Product</p>
                            <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>Display on homepage featured section</p>
                        </div>
                    </label>

                    {/* Actions */}
                    <div className="flex justify-end gap-3 pt-4" style={{ borderTop: '1px solid var(--glass-border)' }}>
                        <button type="button" onClick={onClose}
                            className="px-6 py-2.5 rounded-xl glass-inner font-medium text-sm" style={{ color: 'hsl(var(--foreground))' }}>
                            Cancel
                        </button>
                        <motion.button type="submit" whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}
                            disabled={uploadingImages}
                            className="px-6 py-2.5 rounded-xl font-semibold text-sm text-white disabled:opacity-60 flex items-center gap-2"
                            style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(200, 80%, 50%))', boxShadow: '0 0 20px -4px hsl(220, 70%, 55%, 0.3)' }}>
                            {uploadingImages ? <><Loader2 size={16} className="animate-spin" /> Uploading...</> : <>{product._id ? 'Update' : 'Create'} Product</>}
                        </motion.button>
                    </div>
                </form>
                </div>
            </motion.div>
        </motion.div>
    );
};

export default AdminDashboard;