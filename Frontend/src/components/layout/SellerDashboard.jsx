import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { createPortal } from 'react-dom';
import {
    BarChart3, Package, X, Menu, LayoutPanelLeft, ShoppingBag,
    Star, Store, Truck, Bell, Settings, ChevronLeft, Search, Loader2,
    TrendingUp, AlertTriangle, CheckCircle, Clock, DollarSign, Info, Bot, Crown, Lock, MessageCircle, User, Sparkles, Wand2, RotateCcw, Tag, Megaphone,
} from 'lucide-react';
import axios from 'axios';
import GlassBackground from '../common/GlassBackground';
import { toast } from 'react-toastify';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { uploadImageToCloudinary } from '../../utils/uploadToCloudinary';
import { useCurrency } from '../../contexts/CurrencyContext';
import { useAuth } from '../../contexts/AuthContext';
import ChatBotComponent from '../common/ChatBot';
import CurrencySelector from '../common/CurrencySelector';
import { PRESET_CATEGORIES } from '../../utils/categories';
import { getAuthToken } from "../../utils/cookieHelper";

// Shared menu items (used by desktop sidebar + mobile inline menu)
const getSellerMenuItems = ({ pendingOrders = 0, lowStockProducts = 0 } = {}) => ([
    { id: 'home', label: 'Dashboard', icon: <BarChart3 size={18} />, link: '/seller-dashboard/seller-home' },
    { id: 'analytics', label: 'Analytics', icon: <TrendingUp size={18} />, link: '/seller-dashboard/analytics' },
    { id: 'payments', label: 'Payments', icon: <DollarSign size={18} />, link: '/seller-dashboard/payments' },
    { id: 'overview', label: 'Store Overview', icon: <Store size={18} />, link: '/seller-dashboard/store-overview' },
    { id: 'products', label: 'Products', icon: <Package size={18} />, link: '/seller-dashboard/product-management', badge: lowStockProducts },
    { id: 'orders', label: 'Orders', icon: <ShoppingBag size={18} />, link: '/seller-dashboard/order-management', badge: pendingOrders },
    { id: 'shipping', label: 'Shipping', icon: <Truck size={18} />, link: '/seller-dashboard/shipping-configuration' },
    { id: 'coupons', label: 'Coupons', icon: <Star size={18} />, link: '/seller-dashboard/coupons' },
    { id: 'subdomain', label: 'Subdomain', icon: <LayoutPanelLeft size={18} />, link: '/seller-dashboard/subdomain' },
    { id: 'subscription', label: 'Subscription', icon: <Crown size={18} />, link: '/seller-dashboard/subscription' },
    { id: 'ads', label: 'Ads', icon: <Megaphone size={18} />, link: '/seller-dashboard/ads' },
    { id: 'notifications', label: 'Notifications', icon: <Bell size={18} />, link: '/seller-dashboard/notifications' },
    { id: 'profile', label: 'Seller Profile', icon: <User size={18} />, link: '/seller-dashboard/profile' },
    { id: 'store', label: 'Store Settings', icon: <Settings size={18} />, link: '/seller-dashboard/store-settings' },
    { id: 'notif-settings', label: 'Notif Settings', icon: <Settings size={18} />, link: '/seller-dashboard/notification-settings' },
    { id: 'whatsapp', label: 'WhatsApp', icon: <MessageCircle size={18} />, link: '/seller-dashboard/whatsapp-settings' },
    { id: 'ai-assistant', label: 'AI Assistant', icon: <Bot size={18} />, action: 'ai-chat' },
]);

const DASHBOARD_PRODUCTS_PER_PAGE = 12;

const normalizeDashboardProduct = (product = {}) => ({
    ...product,
    name: product.name || '',
    brand: product.brand || '',
    category: product.category || '',
    description: product.description || '',
    price: Number.isFinite(Number(product.price)) ? Number(product.price) : 0,
    discountedPrice: Number.isFinite(Number(product.discountedPrice)) ? Number(product.discountedPrice) : 0,
    stock: Number.isFinite(Number(product.stock)) ? Number(product.stock) : 0,
    image: product.image || product.images?.[0]?.url || '',
    images: Array.isArray(product.images) ? product.images.filter(Boolean).map(img => (
        typeof img === 'string' ? { url: img } : { ...img, url: img?.url || '' }
    )).filter(img => img.url) : [],
    tags: Array.isArray(product.tags) ? product.tags.filter(Boolean) : [],
    colors: Array.isArray(product.colors) ? product.colors.filter(Boolean) : [],
    optionGroups: Array.isArray(product.optionGroups) ? product.optionGroups.map(group => ({
        ...group,
        name: group?.name || '',
        values: Array.isArray(group?.values) ? group.values.filter(Boolean) : [],
        default: group?.default || '',
    })) : [],
});

const SellerDashboard = () => {
    const { currentUser } = useAuth();
    const { currency } = useCurrency();
    const [isMobile, setIsMobile] = useState(false);
    const [aiChatOpen, setAiChatOpen] = useState(false);
    const [subscriptionData, setSubscriptionData] = useState(null);

    useEffect(() => {
        const checkIsMobile = () => setIsMobile(window.innerWidth < 1024);
        checkIsMobile();
        window.addEventListener('resize', checkIsMobile);
        return () => window.removeEventListener('resize', checkIsMobile);
    }, []);

    // Fetch subscription status
    useEffect(() => {
        const fetchSub = async () => {
            try {
                const token = getAuthToken();
                const res = await axios.get(`${import.meta.env.VITE_API_URL}api/subscription/status`, {
                    headers: { Authorization: `Bearer ${token}` }
                });
                setSubscriptionData(res.data.subscription);
            } catch (e) { /* ignore */ }
        };
        fetchSub();
    }, []);

    const isSubBlocked = subscriptionData?.status === 'blocked';
    const isTrialExpiring = subscriptionData?.isTrialExpiringSoon;
    // Subscription cancelled and approaching end
    const isSubEndingSoon = (() => {
        if (!subscriptionData?.cancelledAt || !subscriptionData?.currentPeriodEnd) return false;
        if (['blocked', 'trial'].includes(subscriptionData.status)) return false;
        const daysLeft = Math.ceil((new Date(subscriptionData.currentPeriodEnd) - new Date()) / (1000 * 60 * 60 * 24));
        return daysLeft > 0 && daysLeft <= 3;
    })();
    const subDaysRemaining = subscriptionData?.currentPeriodEnd
        ? Math.max(0, Math.ceil((new Date(subscriptionData.currentPeriodEnd) - new Date()) / (1000 * 60 * 60 * 24)))
        : 0;
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
    const [productPage, setProductPage] = useState(1);
    const [productPagination, setProductPagination] = useState({
        page: 1,
        limit: DASHBOARD_PRODUCTS_PER_PAGE,
        totalProducts: 0,
        totalPages: 1,
        hasMore: false,
    });
    const [uploadingImages, setUploadingImages] = useState(false);
    const [featuredStats, setFeaturedStats] = useState({ current: 0, max: 6, allowed: true, plan: 'free_trial' });
    const [isSidebarOpen, setIsSidebarOpen] = useState(false);
    const [notificationsOpen, setNotificationsOpen] = useState(false);
    const [notifications, setNotifications] = useState([]);
    const [notificationsLoading, setNotificationsLoading] = useState(false);
    const [productCurrencyState, setProductCurrencyState] = useState({
        activeCurrency: currency || 'USD',
        status: 'active',
        pendingCurrency: null,
        previousCurrency: null,
        productCount: 0,
        canAddProduct: true,
    });
    const notifTriggerRef = useRef(null);
    const notifMenuRef = useRef(null);
    const [notifPos, setNotifPos] = useState({ top: 0, right: 0 });

    const updateNotifPosition = useCallback(() => {
        if (notifTriggerRef.current) {
            const rect = notifTriggerRef.current.getBoundingClientRect();
            setNotifPos({
                top: rect.bottom + 8,
                right: window.innerWidth - rect.right,
            });
        }
    }, []);

    const fetchFilters = async () => {
        try {
            const res = await axios.get(`${import.meta.env.VITE_API_URL}api/products/get-filters`);
            setCategories(Array.isArray(res.data.categories) ? res.data.categories : []);
        } catch (error) { console.error(error); setCategories([]); }
    };

    useEffect(() => { fetchFilters(); }, []);

    const fetchFeaturedStats = async () => {
        try {
            const token = getAuthToken();
            const res = await axios.get(`${import.meta.env.VITE_API_URL}api/products/featured-stats`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            setFeaturedStats(res.data);
        } catch { /* keep defaults */ }
    };

    useEffect(() => { fetchFeaturedStats(); }, []);

    const fetchProductCurrencyState = async () => {
        try {
            const token = getAuthToken();
            const res = await axios.get(`${import.meta.env.VITE_API_URL}api/stores/product-currency`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            if (res.data?.productCurrency) {
                setProductCurrencyState(res.data.productCurrency);
            }
        } catch (error) {
            if (error.response?.status !== 404) {
                console.error('Failed to fetch product currency settings:', error);
            }
        }
    };

    useEffect(() => { fetchProductCurrencyState(); }, [currency]);

    const fetchProducts = async () => {
        setLoading(true);
        try {
            const query = serializeFilters();
            const token = getAuthToken();
            const res = await axios.get(`${import.meta.env.VITE_API_URL}api/products/get-seller-products?${query}`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            setProducts(Array.isArray(res.data.products) ? res.data.products.map(normalizeDashboardProduct) : []);
            setProductPagination({
                page: res.data.pagination?.page || productPage,
                limit: res.data.pagination?.limit || DASHBOARD_PRODUCTS_PER_PAGE,
                totalProducts: res.data.pagination?.totalProducts || 0,
                totalPages: Math.max(1, res.data.pagination?.totalPages || 1),
                hasMore: Boolean(res.data.pagination?.hasMore),
            });
        } catch (err) {
            toast.error(err.response?.data?.msg || 'Failed to fetch products');
            setProducts([]);
            setProductPagination(prev => ({ ...prev, totalProducts: 0, totalPages: 1, hasMore: false }));
        } finally { setLoading(false); }
    };

    const serializeFilters = () => {
        let params = new URLSearchParams();
        if (selectedCategory !== 'all') params.append('categories', selectedCategory);
        if (searchTerm !== '') params.append('search', searchTerm);
        params.append('page', productPage);
        params.append('limit', DASHBOARD_PRODUCTS_PER_PAGE);
        params.append('sortBy', 'newest');
        params.append('sortOrder', 'desc');
        return params.toString();
    };

    useEffect(() => { setProductPage(1); }, [searchTerm, selectedCategory]);
    useEffect(() => { fetchProducts(); fetchOrders(); }, [searchTerm, selectedCategory, productPage]);

    const handleCreateProduct = () => {
        if (productCurrencyState.status === 'pending_conversion') {
            toast.error(productCurrencyState.message || 'Convert existing product prices or cancel the pending currency change before adding new products.');
            return;
        }
        const productEntryCurrency = productCurrencyState.activeCurrency || currency || 'USD';
        setEditingProduct({
            name: '', description: '', price: '', discountedPrice: "",
            currency: productEntryCurrency, priceCurrency: productEntryCurrency, discountedPriceCurrency: productEntryCurrency,
            category: '', brand: '', stock: "", image: '', images: [],
            tags: [], colors: [], optionGroups: [], isFeatured: false
        });
        setIsFormOpen(true);
    };

    const handleEditProduct = (product) => {
        setEditingProduct(normalizeDashboardProduct(product));
        setIsFormOpen(true);
    };

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
                const existingImages = (Array.isArray(editingProduct.images) ? editingProduct.images : []).filter(img => !img.isFile);
                const newImages = uploadedUrls.map(url => ({ url }));
                editingProduct.images = [...existingImages, ...newImages];
                delete editingProduct.imageFiles;
            }
            if (editingProduct.images) {
                editingProduct.images = editingProduct.images.map(img => ({ url: img.url }));
            }
        } catch (error) {
            setUploadingImages(false);
            toast.error(error.message || 'Failed to upload images');
            return;
        }

        if (editingProduct._id) {
            try {
                const token = getAuthToken();
                const res = await axios.put(`${import.meta.env.VITE_API_URL}api/products/edit/${editingProduct._id}`,
                    { product: editingProduct }, { headers: { Authorization: `Bearer ${token}` } });
                toast.success(res.data.msg);
                fetchProducts(); fetchFilters(); fetchFeaturedStats();
            } catch (error) { toast.error(error.response?.data?.msg || 'Failed to update product'); }
        } else {
            try {
                const token = getAuthToken();
                const res = await axios.post(`${import.meta.env.VITE_API_URL}api/products/add`,
                    { product: editingProduct }, { headers: { Authorization: `Bearer ${token}` } });
                toast.success(res.data.msg);
                fetchProducts(); fetchFilters(); fetchFeaturedStats(); fetchProductCurrencyState();
            } catch (error) {
                if (error.response?.data?.productCurrency) setProductCurrencyState(error.response.data.productCurrency);
                toast.error(error.response?.data?.msg || 'Failed to add product');
            }
        }
        setUploadingImages(false);
        setIsFormOpen(false);
        setEditingProduct(null);
    };

    const handleConvertProductCurrency = async () => {
        try {
            const token = getAuthToken();
            const res = await axios.post(`${import.meta.env.VITE_API_URL}api/stores/product-currency/convert`, {}, {
                headers: { Authorization: `Bearer ${token}` }
            });
            toast.success(res.data.msg || 'Product prices converted');
            if (res.data?.productCurrency) setProductCurrencyState(res.data.productCurrency);
            fetchProducts();
        } catch (error) {
            toast.error(error.response?.data?.msg || 'Failed to convert product prices');
        }
    };

    const handleCancelProductCurrencyChange = async () => {
        try {
            const token = getAuthToken();
            const res = await axios.post(`${import.meta.env.VITE_API_URL}api/stores/product-currency/cancel`, {}, {
                headers: { Authorization: `Bearer ${token}` }
            });
            toast.success(res.data.msg || 'Product currency change canceled');
            if (res.data?.productCurrency) setProductCurrencyState(res.data.productCurrency);
        } catch (error) {
            toast.error(error.response?.data?.msg || 'Failed to cancel product currency change');
        }
    };

    const handleDeleteProduct = async (id) => {
        try {
            const token = getAuthToken();
            const res = await axios.delete(`${import.meta.env.VITE_API_URL}api/products/delete/${id}`,
                { headers: { Authorization: `Bearer ${token}` } });
            toast.success(res.data.msg || 'Product deleted successfully');
            fetchProducts();
        } catch (error) { toast.error(error.response?.data?.msg || 'Failed to delete product'); }
        setDeleteConfirm(null);
    };

    const handleBulkDeleteProducts = async (productIds = []) => {
        try {
            const ids = Array.isArray(productIds) ? productIds.filter(Boolean) : [];
            if (ids.length === 0) {
                toast.error('Select at least one product to delete.');
                return false;
            }
            const token = getAuthToken();
            const res = await axios.post(`${import.meta.env.VITE_API_URL}api/products/bulk-delete`,
                { productIds: ids },
                { headers: { Authorization: `Bearer ${token}` } });
            toast.success(res.data.msg || 'Selected products deleted');
            fetchProducts();
            fetchFilters();
            fetchFeaturedStats();
            fetchProductCurrencyState();
            return true;
        } catch (error) {
            toast.error(error.response?.data?.msg || 'Failed to delete selected products');
            return false;
        }
    };

    const fetchOrders = async () => {
        const token = getAuthToken();
        try {
            const params = new URLSearchParams();
            if (selectedCategory !== 'all') params.append('categories', selectedCategory);
            if (searchTerm !== '') params.append('search', searchTerm);
            const query = params.toString();
            const res = await axios.get(`${import.meta.env.VITE_API_URL}api/order/get?${query}`,
                { headers: { Authorization: `Bearer ${token}` } });
            setOrders(res.data?.orders || []);
        } catch (error) { console.error(error); setOrders([]); }
    };

    const pendingOrders = orders.filter(o => o.orderStatus === 'pending').length;
    const lowStockProducts = products.filter(p => p.stock <= 10 && p.stock > 0).length;
    const outOfStockProducts = products.filter(p => p.stock === 0).length;

    const outletContext = useMemo(() => ({
        dashboardRole: 'seller',
        products, orders, categories, searchTerm, setSearchTerm,
        selectedCategory, setSelectedCategory, deleteConfirm, setDeleteConfirm,
        handleEditProduct, handleCreateProduct, handleDeleteProduct, handleBulkDeleteProducts, loading, fetchProducts,
        productPagination,
        currentPage: productPagination.page,
        totalPages: productPagination.totalPages,
        totalProducts: productPagination.totalProducts,
        pageSize: productPagination.limit,
        setProductPage,
        isFormOpen, editingProduct, setEditingProduct, handleSaveProduct, uploadingImages,
        closeForm: () => { setIsFormOpen(false); setEditingProduct(null); },
        canFeature: subscriptionData?.status === 'trial' || subscriptionData?.bonusFeaturesActive === true || ['active', 'free_period'].includes(subscriptionData?.status),
        featuredStats, fetchFeaturedStats,
        productCurrencyState, fetchProductCurrencyState, handleConvertProductCurrency, handleCancelProductCurrencyChange,
    }), [products, orders, categories, searchTerm, selectedCategory, deleteConfirm, loading, productPagination, isFormOpen, editingProduct, uploadingImages, subscriptionData, featuredStats, productCurrencyState]);

    const location = useLocation();

    // Get current page title
    const getPageTitle = () => {
        const path = location.pathname;
        if (path.includes('store-overview')) return 'Store Overview';
        if (path.includes('product-management')) return 'Product Management';
        if (path.includes('order-management')) return 'Order Management';
        if (path.includes('shipping-configuration')) return 'Shipping';
        if (path.includes('store-settings')) return 'Store Settings';
        if (path.includes('notification-settings')) return 'Notification Settings';
        if (path.includes('whatsapp-settings')) return 'WhatsApp Settings';
        if (path.includes('notifications')) return 'Notifications';
        if (path.includes('analytics')) return 'Analytics';
        if (path.includes('subdomain')) return 'Subdomain';
        if (path.includes('ads')) return 'Ads';
        if (path.includes('coupons')) return 'Coupons';
        if (path.includes('seller-home')) return 'Dashboard';
        if (path.includes('profile')) return 'Seller Profile';
        return 'Dashboard';
    };

    const fetchNotifications = async () => {
        setNotificationsLoading(true);
        let prefs = {};
        try {
            const token = getAuthToken();
            const prefsRes = await axios.get(`${import.meta.env.VITE_API_URL}api/analytics/notification-prefs`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            prefs = prefsRes.data.prefs || {};
        } catch { /* fallback to all enabled */ }
        try {
            const token = getAuthToken();
            const res = await axios.get(`${import.meta.env.VITE_API_URL}api/analytics/notifications`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            let notifs = res.data.notifications || [];
            // Filter by preferences
            if (prefs.stockAlerts === false) notifs = notifs.filter(n => n.category !== 'stock' || n.type !== 'critical');
            if (prefs.lowStockAlerts === false) notifs = notifs.filter(n => n.category !== 'stock' || n.type !== 'warning');
            if (prefs.orderAlerts === false) notifs = notifs.filter(n => n.category !== 'order');
            if (prefs.paymentAlerts === false) notifs = notifs.filter(n => n.category !== 'payment');
            setNotifications(notifs);
        } catch (err) {
            // Fallback to local notifications from products/orders
            const localNotifs = [];
            if (prefs.stockAlerts !== false) {
                products.filter(p => p.stock === 0).forEach(p => {
                    localNotifs.push({ id: `s-${p._id}`, type: 'critical', category: 'stock', title: `${p.name} is out of stock`, description: 'Update inventory', time: new Date().toISOString() });
                });
            }
            if (prefs.lowStockAlerts !== false) {
                products.filter(p => p.stock > 0 && p.stock <= 10).forEach(p => {
                    localNotifs.push({ id: `l-${p._id}`, type: 'warning', category: 'stock', title: `${p.name} running low`, description: `${p.stock} units left`, time: new Date().toISOString() });
                });
            }
            if (prefs.orderAlerts !== false) {
                orders.filter(o => o.orderStatus === 'pending').slice(0, 5).forEach(o => {
                    localNotifs.push({ id: `o-${o._id}`, type: 'info', category: 'order', title: `Pending order ${o.orderId}`, description: o.shippingInfo?.fullName, time: o.createdAt });
                });
            }
            setNotifications(localNotifs);
        } finally { setNotificationsLoading(false); }
    };

    const handleBellClick = () => {
        if (!notificationsOpen) fetchNotifications();
        setNotificationsOpen(!notificationsOpen);
    };

    // Close notifications on outside click
    useEffect(() => {
        const handler = (e) => {
            const clickedTrigger = notifTriggerRef.current?.contains(e.target);
            const clickedMenu = notifMenuRef.current?.contains(e.target);
            if (!clickedTrigger && !clickedMenu) setNotificationsOpen(false);
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, []);

    useEffect(() => {
        if (notificationsOpen) {
            updateNotifPosition();
            window.addEventListener('scroll', updateNotifPosition, true);
            window.addEventListener('resize', updateNotifPosition);
            return () => {
                window.removeEventListener('scroll', updateNotifPosition, true);
                window.removeEventListener('resize', updateNotifPosition);
            };
        }
    }, [notificationsOpen, updateNotifPosition]);

    const notificationsDropdown = (
        <AnimatePresence>
            {notificationsOpen && (
                <motion.div
                    ref={notifMenuRef}
                    initial={{ opacity: 0, y: 8, scale: 0.96 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 8, scale: 0.96 }}
                    transition={{ duration: 0.2 }}
                    className="fixed right-0 w-80 sm:w-96 overflow-hidden z-[100] glass-panel-strong"
                    style={{ top: notifPos.top, right: notifPos.right, maxHeight: '70vh' }}>
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
                                    const iconMap = {
                                        critical: <AlertTriangle size={14} />,
                                        warning: <AlertTriangle size={14} />,
                                        info: <Info size={14} />,
                                        success: <CheckCircle size={14} />,
                                    };
                                    const colorMap = {
                                        critical: { bg: 'rgba(239,68,68,0.12)', color: 'hsl(0,72%,55%)' },
                                        warning: { bg: 'rgba(245,158,11,0.12)', color: 'hsl(45,80%,40%)' },
                                        info: { bg: 'rgba(99,102,241,0.12)', color: 'hsl(220,70%,55%)' },
                                        success: { bg: 'rgba(16,185,129,0.12)', color: 'hsl(150,60%,45%)' },
                                    };
                                    const cs = colorMap[n.type] || colorMap.info;
                                    const linkTo = n.orderId
                                        ? `/seller-dashboard/order/${n.orderId}`
                                        : '/seller-dashboard/product-management';
                                    return (
                                        <Link key={n.id || i} to={linkTo} onClick={() => setNotificationsOpen(false)}>
                                            <motion.div
                                                initial={{ opacity: 0, x: 10 }}
                                                animate={{ opacity: 1, x: 0 }}
                                                transition={{ delay: i * 0.03 }}
                                                className="flex items-start gap-3 p-3 rounded-xl transition-all hover:bg-white/5 cursor-pointer">
                                                <div className="p-1.5 rounded-lg mt-0.5 shrink-0" style={{ background: cs.bg, color: cs.color }}>
                                                    {iconMap[n.type]}
                                                </div>
                                                <div className="flex-1 min-w-0">
                                                    <p className="text-xs font-semibold truncate" style={{ color: 'hsl(var(--foreground))' }}>{n.title}</p>
                                                    {n.description && (
                                                        <p className="text-[11px] mt-0.5 truncate" style={{ color: 'hsl(var(--muted-foreground))' }}>{n.description}</p>
                                                    )}
                                                    <p className="text-[10px] mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                                        {n.time ? new Date(n.time).toLocaleDateString('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Just now'}
                                                    </p>
                                                </div>
                                            </motion.div>
                                        </Link>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                </motion.div>
            )}
        </AnimatePresence>
    );

    return (
        <div className="min-h-screen relative flex" style={{ background: 'linear-gradient(135deg, hsl(230, 35%, 88%) 0%, hsl(210, 40%, 90%) 25%, hsl(250, 30%, 92%) 50%, hsl(200, 35%, 88%) 75%, hsl(280, 25%, 90%) 100%)', backgroundAttachment: 'fixed' }}>
            <GlassBackground />
            {/* Sidebar */}
            <SellerSidebar
                activeTab={activeTab}
                setActiveTab={setActiveTab}
                isSidebarOpen={isSidebarOpen}
                setIsSidebarOpen={setIsSidebarOpen}
                isMobile={isMobile}
                pendingOrders={pendingOrders}
                lowStockProducts={lowStockProducts + outOfStockProducts}
                onAiChat={() => setAiChatOpen(true)}
            />

            {/* Main Content */}
            <div className={`flex-1 flex flex-col min-h-screen ${!isMobile ? 'ml-64' : ''}`}>
                {/* Top Header Bar */}
                <div className="sticky top-0 z-30 mx-4 mt-4 glass-panel-strong" style={{ borderRadius: 20, borderBottom: '1px solid var(--glass-border)' }}>
                    <div className="flex items-center justify-between px-4 sm:px-6 py-3">
                        <div className="flex items-center gap-3">
                            {isMobile && (
                                <motion.button whileTap={{ scale: 0.95 }} onClick={() => setIsSidebarOpen(o => !o)}
                                    className="p-2 rounded-xl glass-inner" style={{ color: 'hsl(var(--foreground))' }}>
                                    <motion.div key={isSidebarOpen ? 'x' : 'm'} initial={{ rotate: -90, opacity: 0 }} animate={{ rotate: 0, opacity: 1 }} transition={{ duration: 0.2 }}>
                                        {isSidebarOpen ? <X size={20} /> : <Menu size={20} />}
                                    </motion.div>
                                </motion.button>
                            )}
                            <div>
                                <h1 className="text-lg font-bold" style={{ color: 'hsl(var(--foreground))' }}>{getPageTitle()}</h1>
                                <p className="text-xs hidden sm:block" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                    Welcome back, {currentUser?.username || 'Seller'}
                                </p>
                            </div>
                        </div>

                        <div className="flex items-center gap-2 sm:gap-3">
                            <CurrencySelector />
                            {/* Home Button */}
                            <Link to="/" title="Back to Home">
                                <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}
                                    className="p-2.5 rounded-xl glass-inner" style={{ color: 'hsl(150, 60%, 45%)' }}>
                                    <LayoutPanelLeft size={18} />
                                </motion.button>
                            </Link>
                            {/* Notifications Bell */}
                            <div className="relative">
                                <motion.button
                                    ref={notifTriggerRef}
                                    whileHover={{ scale: 1.05 }}
                                    whileTap={{ scale: 0.95 }}
                                    onClick={handleBellClick}
                                    className="p-2.5 rounded-xl glass-inner relative"
                                    style={{ color: 'hsl(var(--foreground))' }}
                                >
                                    <Bell size={18} />
                                    {(pendingOrders + lowStockProducts + outOfStockProducts) > 0 && (
                                        <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] flex items-center justify-center rounded-full text-[10px] font-bold text-white px-1"
                                            style={{ background: 'hsl(0, 72%, 55%)' }}>
                                            {pendingOrders + lowStockProducts + outOfStockProducts}
                                        </span>
                                    )}
                                </motion.button>
                            </div>

                            {/* User Avatar */}
                            <Link to="/seller-dashboard/store-settings">
                                <motion.div whileHover={{ scale: 1.05 }} className="flex items-center gap-2 cursor-pointer">
                                    <div className="w-8 h-8 rounded-xl flex items-center justify-center text-sm font-bold border"
                                        style={{
                                            background: 'linear-gradient(135deg, hsl(150, 60%, 45%), hsl(170, 50%, 40%))',
                                            color: 'white', borderColor: 'rgba(255,255,255,0.3)'
                                        }}>
                                        {currentUser?.username?.[0]?.toUpperCase() || 'S'}
                                    </div>
                                    <span className="hidden md:block text-sm font-medium" style={{ color: 'hsl(var(--foreground))' }}>
                                        {currentUser?.username || 'Seller'}
                                    </span>
                                </motion.div>
                            </Link>
                        </div>
                    </div>

                    {/* Alert Bar for notifications */}
                    {(pendingOrders > 0 || outOfStockProducts > 0) && (
                        <div className="px-4 sm:px-6 pb-3">
                            <div className="flex flex-wrap gap-2">
                                {pendingOrders > 0 && (
                                    <Link to="/seller-dashboard/order-management">
                                        <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-all hover:scale-[1.02]"
                                            style={{ background: 'rgba(249, 115, 22, 0.12)', color: 'hsl(30, 90%, 45%)' }}>
                                            <ShoppingBag size={12} /> {pendingOrders} pending order{pendingOrders > 1 ? 's' : ''}
                                        </span>
                                    </Link>
                                )}
                                {outOfStockProducts > 0 && (
                                    <Link to="/seller-dashboard/product-management">
                                        <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-all hover:scale-[1.02]"
                                            style={{ background: 'rgba(239, 68, 68, 0.12)', color: 'hsl(0, 72%, 50%)' }}>
                                            <Package size={12} /> {outOfStockProducts} out of stock
                                        </span>
                                    </Link>
                                )}
                                {lowStockProducts > 0 && (
                                    <Link to="/seller-dashboard/product-management">
                                        <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-all hover:scale-[1.02]"
                                            style={{ background: 'rgba(245, 158, 11, 0.12)', color: 'hsl(45, 80%, 40%)' }}>
                                            <Package size={12} /> {lowStockProducts} low stock
                                        </span>
                                    </Link>
                                )}
                            </div>
                        </div>
                    )}

                    {/* Mobile inline menu — expands header height down */}
                    {isMobile && (
                        <AnimatePresence initial={false}>
                            {isSidebarOpen && (
                                <motion.div
                                    key="seller-mobile-menu"
                                    initial={{ height: 0, opacity: 0 }}
                                    animate={{ height: 'auto', opacity: 1 }}
                                    exit={{ height: 0, opacity: 0 }}
                                    transition={{ duration: 0.25, ease: 'easeOut' }}
                                    className="overflow-hidden"
                                    style={{ borderTop: '1px solid var(--glass-border)' }}
                                >
                                    <div className="px-3 py-3 space-y-1 max-h-[60vh] overflow-y-auto">
                                        {getSellerMenuItems({ pendingOrders, lowStockProducts: lowStockProducts + outOfStockProducts }).map(item => {
                                            const isActive = activeTab === item.id;
                                            const onClick = () => {
                                                if (item.action === 'ai-chat') { setAiChatOpen(true); setIsSidebarOpen(false); return; }
                                                setActiveTab(item.id); setIsSidebarOpen(false);
                                            };
                                            const inner = (
                                                <button onClick={onClick}
                                                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all hover:bg-white/10"
                                                    style={isActive ? { background: 'rgba(16,185,129,0.12)', color: 'hsl(var(--foreground))', border: '1px solid rgba(16,185,129,0.25)' } : { color: 'hsl(var(--foreground))' }}>
                                                    <span className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'var(--glass-bg)', color: item.action === 'ai-chat' ? 'hsl(150,60%,45%)' : (isActive ? 'hsl(150,60%,45%)' : 'hsl(var(--muted-foreground))') }}>{item.icon}</span>
                                                    <span className="flex-1 text-left">{item.label}</span>
                                                    {item.badge > 0 && (
                                                        <span className="min-w-[20px] h-5 flex items-center justify-center rounded-full text-[10px] font-bold text-white px-1.5" style={{ background: 'hsl(0,72%,55%)' }}>{item.badge > 99 ? '99+' : item.badge}</span>
                                                    )}
                                                </button>
                                            );
                                            return item.action ? <div key={item.id}>{inner}</div> : <Link key={item.id} to={item.link}>{inner}</Link>;
                                        })}
                                        <Link to="/" onClick={() => setIsSidebarOpen(false)}>
                                            <button className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all hover:bg-white/10" style={{ color: 'hsl(var(--foreground))' }}>
                                                <span className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'var(--glass-bg)', color: 'hsl(150,60%,45%)' }}><LayoutPanelLeft size={18} /></span>
                                                <span className="flex-1 text-left">Back to Home</span>
                                            </button>
                                        </Link>
                                    </div>
                                </motion.div>
                            )}
                        </AnimatePresence>
                    )}
                </div>

                {/* Subscription Warning Banners */}
                {isSubBlocked && (
                    <div className="mx-4 mt-3">
                        <Link to="/seller-dashboard/subscription">
                            <motion.div initial={{ opacity: 0, y: -5 }} animate={{ opacity: 1, y: 0 }}
                                className="p-4 rounded-2xl border cursor-pointer hover:scale-[1.01] transition-transform"
                                style={{ background: 'rgba(239, 68, 68, 0.08)', borderColor: 'rgba(239, 68, 68, 0.2)' }}>
                                <div className="flex items-center gap-3">
                                    <Lock size={18} style={{ color: 'hsl(0, 72%, 55%)' }} />
                                    <div className="flex-1">
                                        <p className="text-xs font-bold" style={{ color: 'hsl(0, 72%, 55%)' }}>Store Blocked — Subscribe to Reactivate</p>
                                        <p className="text-[11px]" style={{ color: 'hsl(var(--muted-foreground))' }}>Your store and products are hidden from the marketplace. You will no longer receive any orders until you activate your account. Click to subscribe.</p>
                                    </div>
                                    <Crown size={16} style={{ color: 'hsl(0, 72%, 55%)' }} />
                                </div>
                            </motion.div>
                        </Link>
                    </div>
                )}
                {isTrialExpiring && !isSubBlocked && (
                    <div className="mx-4 mt-3">
                        <Link to="/seller-dashboard/subscription">
                            <motion.div initial={{ opacity: 0, y: -5 }} animate={{ opacity: 1, y: 0 }}
                                className="p-4 rounded-2xl border cursor-pointer hover:scale-[1.01] transition-transform"
                                style={{ background: 'rgba(245, 158, 11, 0.08)', borderColor: 'rgba(245, 158, 11, 0.2)' }}>
                                <div className="flex items-center gap-3">
                                    <AlertTriangle size={18} style={{ color: 'hsl(45, 80%, 40%)' }} />
                                    <div className="flex-1">
                                        <p className="text-xs font-bold" style={{ color: 'hsl(45, 80%, 40%)' }}>
                                            Trial expires in {subscriptionData?.trialDaysRemaining} day{subscriptionData?.trialDaysRemaining !== 1 ? 's' : ''}
                                        </p>
                                        <p className="text-[11px]" style={{ color: 'hsl(var(--muted-foreground))' }}>Subscribe to keep your store active. First 30 days free, then $5.99/mo.</p>
                                    </div>
                                    <Crown size={16} style={{ color: 'hsl(45, 80%, 40%)' }} />
                                </div>
                            </motion.div>
                        </Link>
                    </div>
                )}
                {isSubEndingSoon && !isSubBlocked && !isTrialExpiring && (
                    <div className="mx-4 mt-3">
                        <Link to="/seller-dashboard/subscription">
                            <motion.div initial={{ opacity: 0, y: -5 }} animate={{ opacity: 1, y: 0 }}
                                className="p-4 rounded-2xl border cursor-pointer hover:scale-[1.01] transition-transform"
                                style={{ background: 'rgba(239, 68, 68, 0.08)', borderColor: 'rgba(239, 68, 68, 0.2)' }}>
                                <div className="flex items-center gap-3">
                                    <AlertTriangle size={18} style={{ color: 'hsl(0, 72%, 55%)' }} />
                                    <div className="flex-1">
                                        <p className="text-xs font-bold" style={{ color: 'hsl(0, 72%, 55%)' }}>
                                            Your store will be blocked in {subDaysRemaining} day{subDaysRemaining !== 1 ? 's' : ''}
                                        </p>
                                        <p className="text-[11px]" style={{ color: 'hsl(var(--muted-foreground))' }}>Your store and products will not be available to anyone on the platform. Re-subscribe to keep your store active.</p>
                                    </div>
                                    <Crown size={16} style={{ color: 'hsl(0, 72%, 55%)' }} />
                                </div>
                            </motion.div>
                        </Link>
                    </div>
                )}

                {/* Page Content */}
                <div className="flex-1">
                    {aiChatOpen ? (
                        <div className="p-3 sm:p-4 lg:p-6">
                            <div className="glass-panel-strong overflow-hidden" style={{ borderRadius: 20, height: 'calc(100vh - 140px)' }}>
                                <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: '1px solid var(--glass-border)' }}>
                                    <div className="flex items-center gap-2">
                                        <Bot size={18} style={{ color: 'hsl(150, 60%, 45%)' }} />
                                        <span className="text-sm font-bold" style={{ color: 'hsl(var(--foreground))' }}>AI Business Assistant</span>
                                    </div>
                                    <button onClick={() => setAiChatOpen(false)} className="p-1.5 rounded-lg glass-inner" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                        <X size={16} />
                                    </button>
                                </div>
                                <div className="h-[calc(100%-49px)] overflow-hidden">
                                    <ChatBotComponent embedded dashboardRole="seller" />
                                </div>
                            </div>
                        </div>
                    ) : (
                        <Outlet context={outletContext} />
                    )}
                </div>
            </div>


            {createPortal(notificationsDropdown, document.body)}
        </div>
    );
};

export default SellerDashboard;
export { ProductForm };


// ============================
// Sidebar Component
// ============================
const SellerSidebar = ({ activeTab, setActiveTab, isSidebarOpen, setIsSidebarOpen, isMobile, pendingOrders, lowStockProducts, onAiChat }) => {
    const { currentUser } = useAuth();
    const location = useLocation();

    const menuItems = [
        { id: 'home', label: 'Dashboard', icon: <BarChart3 size={18} />, link: '/seller-dashboard/seller-home' },
        { id: 'analytics', label: 'Analytics', icon: <TrendingUp size={18} />, link: '/seller-dashboard/analytics' },
        { id: 'payments', label: 'Payments', icon: <DollarSign size={18} />, link: '/seller-dashboard/payments' },
        { id: 'overview', label: 'Store Overview', icon: <Store size={18} />, link: '/seller-dashboard/store-overview' },
        { id: 'products', label: 'Products', icon: <Package size={18} />, link: '/seller-dashboard/product-management', badge: lowStockProducts },
        { id: 'orders', label: 'Orders', icon: <ShoppingBag size={18} />, link: '/seller-dashboard/order-management', badge: pendingOrders },
        { id: 'shipping', label: 'Shipping', icon: <Truck size={18} />, link: '/seller-dashboard/shipping-configuration' },
        { id: 'coupons', label: 'Coupons', icon: <Star size={18} />, link: '/seller-dashboard/coupons' },
        { id: 'subdomain', label: 'Subdomain', icon: <LayoutPanelLeft size={18} />, link: '/seller-dashboard/subdomain' },
        { id: 'subscription', label: 'Subscription', icon: <Crown size={18} />, link: '/seller-dashboard/subscription' },
        { id: 'ads', label: 'Ads', icon: <Megaphone size={18} />, link: '/seller-dashboard/ads' },
        { id: 'notifications', label: 'Notifications', icon: <Bell size={18} />, link: '/seller-dashboard/notifications' },
        { id: 'profile', label: 'Seller Profile', icon: <User size={18} />, link: '/seller-dashboard/profile' },
        { id: 'store', label: 'Store Settings', icon: <Settings size={18} />, link: '/seller-dashboard/store-settings' },
        { id: 'notif-settings', label: 'Notif Settings', icon: <Settings size={18} />, link: '/seller-dashboard/notification-settings' },
        { id: 'whatsapp', label: 'WhatsApp', icon: <MessageCircle size={18} />, link: '/seller-dashboard/whatsapp-settings' },
        { id: 'ai-assistant', label: 'AI Assistant', icon: <Bot size={18} />, action: 'ai-chat' },
    ];

    useEffect(() => {
        menuItems.forEach(item => { if (item.link && location.pathname.includes(item.link.split('/').pop())) setActiveTab(item.id); });
    }, [location]);

    const handleTabClick = (tabId, item) => {
        if (item?.action === 'ai-chat') {
            onAiChat?.();
            if (isMobile) setIsSidebarOpen(false);
            return;
        }
        setActiveTab(tabId);
        if (isMobile) setIsSidebarOpen(false);
    };

    // On mobile we use the inline expanding menu in the dashboard header instead.
    if (isMobile) return null;

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
                <div className={`flex flex-col h-full glass-panel-strong water-shimmer ${isMobile ? 'sidebar-mobile-solid' : ''}`} style={{ borderRadius: '0 28px 28px 0' }}>
                    {/* Logo / Brand */}
                    <div className="px-5 pt-6 pb-4">
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-3">
                                <div className="w-10 h-10 rounded-xl flex items-center justify-center font-bold text-sm border"
                                    style={{
                                        background: 'linear-gradient(135deg, hsl(150, 60%, 45%), hsl(170, 50%, 40%))',
                                        color: 'white', borderColor: 'rgba(255,255,255,0.3)'
                                    }}>
                                    <Store size={20} />
                                </div>
                                <div>
                                    <p className="text-sm font-bold" style={{ color: 'hsl(var(--foreground))' }}>Seller Hub</p>
                                    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full"
                                        style={{ background: 'rgba(16, 185, 129, 0.15)', color: 'hsl(150, 60%, 45%)' }}>
                                        Active
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
                            Menu
                        </p>
                        {menuItems.map(item => {
                            const isActive = activeTab === item.id;
                            const ButtonContent = (
                                <motion.button whileHover={{ x: 2 }} onClick={() => handleTabClick(item.id, item)}
                                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all ${isActive
                                        ? 'border shadow-sm' : 'hover:bg-white/8'}`}
                                    style={isActive ? {
                                        background: 'rgba(16, 185, 129, 0.12)',
                                        color: 'hsl(var(--foreground))',
                                        borderColor: 'rgba(16, 185, 129, 0.25)'
                                    } : { color: 'hsl(var(--muted-foreground))' }}>
                                    <span style={{ color: isActive ? 'hsl(150, 60%, 45%)' : item.action === 'ai-chat' ? 'hsl(150, 60%, 45%)' : 'hsl(var(--muted-foreground))' }}>{item.icon}</span>
                                    {item.label}
                                    {item.badge > 0 && (
                                        <span className="ml-auto min-w-[20px] h-5 flex items-center justify-center rounded-full text-[10px] font-bold text-white px-1.5"
                                            style={{ background: 'hsl(0, 72%, 55%)' }}>
                                            {item.badge > 99 ? '99+' : item.badge}
                                        </span>
                                    )}
                                    {isActive && !item.badge && <div className="ml-auto w-1.5 h-1.5 rounded-full" style={{ background: 'hsl(150, 60%, 45%)' }} />}
                                </motion.button>
                            );
                            return item.action ? (
                                <div key={item.id}>{ButtonContent}</div>
                            ) : (
                                <Link key={item.id} to={item.link}>{ButtonContent}</Link>
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
// Flexible Option Groups Builder (Size, Color, Material, etc.)
// ============================
const OptionGroupsBuilder = ({ product, setProduct, disabled }) => {
    const [newGroupName, setNewGroupName] = useState("");
    const [valueDrafts, setValueDrafts] = useState({}); // { groupIdx: 'draft text' }

    const groups = Array.isArray(product.optionGroups)
        ? product.optionGroups.map(group => ({
            ...group,
            name: group?.name || '',
            values: Array.isArray(group?.values) ? group.values : [],
            default: group?.default || '',
        }))
        : [];
    const update = (next) => setProduct({ ...product, optionGroups: next });

    const addGroup = () => {
        const n = newGroupName.trim();
        if (!n) return;
        if (groups.some(g => g.name.toLowerCase() === n.toLowerCase())) return;
        update([...groups, { name: n, values: [], default: '' }]);
        setNewGroupName("");
    };
    const removeGroup = (idx) => update(groups.filter((_, i) => i !== idx));
    const renameGroup = (idx, name) => update(groups.map((g, i) => i === idx ? { ...g, name } : g));
    const addValue = (idx) => {
        const v = (valueDrafts[idx] || '').trim();
        if (!v) return;
        const group = groups[idx];
        const newValues = group.values.includes(v) ? group.values : [...group.values, v];
        // If this is the first value and no default is set, auto-set it as default
        const newDefault = (!group.default && newValues.length === 1) ? v : group.default;
        update(groups.map((g, i) => i === idx ? { ...g, values: newValues, default: newDefault } : g));
        setValueDrafts({ ...valueDrafts, [idx]: '' });
    };
    const removeValue = (idx, v) => {
        const group = groups[idx];
        const newValues = group.values.filter(x => x !== v);
        // If removing the default value, reset default to first remaining or empty
        const newDefault = group.default === v ? (newValues[0] || '') : group.default;
        update(groups.map((g, i) => i === idx ? { ...g, values: newValues, default: newDefault } : g));
    };
    const setDefault = (idx, v) => update(groups.map((g, i) => i === idx ? { ...g, default: v } : g));

    return (
        <div className="space-y-3">
            {groups.map((g, idx) => (
                <div key={idx} className="glass-inner rounded-xl p-3 space-y-2">
                    <div className="flex gap-2 items-center">
                        <input type="text" disabled={disabled} value={g.name}
                            onChange={(e) => renameGroup(idx, e.target.value)}
                            className="glass-input flex-1 text-sm font-semibold"
                            placeholder="Option name (e.g. Size)" />
                        <button type="button" disabled={disabled} onClick={() => removeGroup(idx)}
                            className="p-2 rounded-lg" style={{ background: 'rgba(239,68,68,0.12)', color: 'hsl(0,72%,55%)' }}
                            title="Remove option">
                            <X size={14} />
                        </button>
                    </div>
                    <div className="flex gap-2">
                        <input type="text" disabled={disabled}
                            value={valueDrafts[idx] || ''}
                            onChange={(e) => setValueDrafts({ ...valueDrafts, [idx]: e.target.value })}
                            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addValue(idx); } }}
                            className="glass-input flex-1 text-sm"
                            placeholder={`Add a value (e.g. S, M, L or Red, Blue)`} />
                        <motion.button type="button" disabled={disabled} whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}
                            onClick={() => addValue(idx)}
                            className="px-3 py-2 rounded-lg text-white font-medium text-sm"
                            style={{ background: 'linear-gradient(135deg, hsl(220,70%,55%), hsl(260,60%,60%))' }}>
                            Add
                        </motion.button>
                    </div>
                    {g.values.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                            {g.values.map((v) => (
                                <span key={v}
                                    onClick={() => !disabled && setDefault(idx, v)}
                                    className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium cursor-pointer transition-all ${g.default === v ? 'ring-2 ring-offset-1' : ''}`}
                                    style={g.default === v
                                        ? { background: 'rgba(34,197,94,0.15)', color: 'hsl(150,60%,35%)', '--tw-ring-color': 'hsl(150,60%,45%)' }
                                        : { background: 'rgba(99,102,241,0.12)', color: 'hsl(220,70%,55%)' }}
                                    title={g.default === v ? `Default: ${v}` : `Click to set "${v}" as default`}>
                                    {g.default === v && <CheckCircle size={11} className="mr-1" />}
                                    {v}
                                    <button type="button" disabled={disabled} onClick={(e) => { e.stopPropagation(); removeValue(idx, v); }}
                                        className="ml-1.5" style={{ color: g.default === v ? 'hsl(150,60%,35%)' : 'hsl(220,70%,55%)' }}>
                                        <X size={11} />
                                    </button>
                                </span>
                            ))}
                        </div>
                    )}
                    {g.values.length > 0 && (
                        <p className="text-[10px] mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                            Click a value to set it as default. {g.default && <span style={{ color: 'hsl(150,60%,40%)' }}>Default: <strong>{g.default}</strong></span>}
                        </p>
                    )}
                </div>
            ))}
            <div className="flex gap-2">
                <input type="text" disabled={disabled} value={newGroupName}
                    onChange={(e) => setNewGroupName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addGroup(); } }}
                    className="glass-input flex-1 text-sm"
                    placeholder="New option name (e.g. Size, Color, Material)" />
                <motion.button type="button" disabled={disabled} whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}
                    onClick={addGroup}
                    className="px-4 py-2 rounded-xl text-white font-medium text-sm"
                    style={{ background: 'linear-gradient(135deg, hsl(150,60%,45%), hsl(170,50%,40%))' }}>
                    + Option
                </motion.button>
            </div>
        </div>
    );
};

// ============================
const MAX_TAGS = 15;
const MAX_DESCRIPTION_LENGTH = 2000;
const ProductForm = ({ product, setProduct, onSave, onClose, uploadingImages, canFeature = true, featuredStats = { current: 0, max: 3, allowed: true } }) => {
    const { currency, currencies } = useCurrency();
    const [newTag, setNewTag] = useState("");
    const [newImage, setNewImage] = useState("");
    const productImages = Array.isArray(product.images) ? product.images : [];
    const productTags = Array.isArray(product.tags) ? product.tags : [];
    const tagsAtLimit = productTags.length >= MAX_TAGS;
    const descLength = product.description?.length || 0;
    const descAtLimit = descLength >= MAX_DESCRIPTION_LENGTH;

    // Category combobox
    const [catOpen, setCatOpen] = useState(false);
    const [showOtherInput, setShowOtherInput] = useState(false);
    const catWrapRef = useRef(null);
    useEffect(() => {
        const onClickOutside = (e) => {
            if (catWrapRef.current && !catWrapRef.current.contains(e.target)) setCatOpen(false);
        };
        document.addEventListener('mousedown', onClickOutside);
        return () => document.removeEventListener('mousedown', onClickOutside);
    }, []);
    const categoryQuery = product.category || '';
    const filteredCategories = PRESET_CATEGORIES.filter(c =>
        c.toLowerCase().includes(categoryQuery.toLowerCase())
    );
    const exactMatch = PRESET_CATEGORIES.some(c => c.toLowerCase() === categoryQuery.toLowerCase());

    // AI improve description
    const [improvingDesc, setImprovingDesc] = useState(false);
    const [previousDescription, setPreviousDescription] = useState(null);
    const improveDescription = async () => {
        if (!product.description?.trim()) { toast.error('Write a description first'); return; }
        setImprovingDesc(true);
        try {
            const token = getAuthToken();
            const res = await axios.post(`${import.meta.env.VITE_API_URL}api/ai-assist/improve-description`,
                { name: product.name, description: product.description, category: product.category, brand: product.brand },
                { headers: { Authorization: `Bearer ${token}` } });
            setPreviousDescription(product.description);
            setProduct({ ...product, description: res.data.description });
            toast.success('Description improved');
        } catch (e) {
            toast.error(e.response?.data?.msg || 'Failed to improve description');
        } finally { setImprovingDesc(false); }
    };
    const revertDescription = () => {
        if (previousDescription !== null) {
            setProduct({ ...product, description: previousDescription });
            setPreviousDescription(null);
            toast.info('Reverted to original description');
        }
    };

    // AI generate tags
    const [generatingTags, setGeneratingTags] = useState(false);
    const generateAiTags = async () => {
        if (!product.name?.trim() && !product.description?.trim()) {
            toast.error('Add a name or description first'); return;
        }
        setGeneratingTags(true);
        try {
            const token = getAuthToken();
            const res = await axios.post(`${import.meta.env.VITE_API_URL}api/ai-assist/generate-tags`,
                { name: product.name, description: product.description, category: product.category, brand: product.brand },
                { headers: { Authorization: `Bearer ${token}` } });
            const incoming = res.data.tags || [];
            const merged = [...new Set([...productTags, ...incoming])].slice(0, MAX_TAGS);
            const added = merged.length - productTags.length;
            setProduct({ ...product, tags: merged });
            if (added > 0) toast.success(`Added ${added} AI tag${added === 1 ? '' : 's'}`);
            else toast.info(`Tag limit reached (${MAX_TAGS} max)`);
        } catch (e) {
            toast.error(e.response?.data?.msg || 'Failed to generate tags');
        } finally { setGeneratingTags(false); }
    };

    const handleAddTag = () => {
        const trimmed = newTag.trim();
        if (!trimmed) return;
        if (productTags.length >= MAX_TAGS) {
            toast.info(`Tag limit reached (${MAX_TAGS} max)`);
            return;
        }
        if (!productTags.includes(trimmed)) {
            setProduct({ ...product, tags: [...productTags, trimmed] });
            setNewTag("");
        }
    };
    const handleRemoveTag = (tagToRemove) => setProduct({ ...product, tags: productTags.filter(tag => tag !== tagToRemove) });
    const handleAddImage = () => {
        if (newImage.trim()) {
            setProduct({ ...product, images: [...productImages, { url: newImage.trim() }] });
            setNewImage("");
        }
    };
    const handleRemoveImage = (indexToRemove) => setProduct({ ...product, images: productImages.filter((_, index) => index !== indexToRemove) });
    const handleSetMainImage = (url) => setProduct({ ...product, image: url });
    const handleSubmit = (e) => { e.preventDefault(); onSave(); };
    const editingCurrency = product.currency || product.priceCurrency || currency;
    const editingCurrencySymbol = currencies?.[editingCurrency]?.symbol || editingCurrency;
    const displayAmount = (amount) => {
        if (amount === '' || amount === null || amount === undefined) return '';
        const numericAmount = Number(amount);
        return Number.isFinite(numericAmount) ? String(numericAmount) : '';
    };

    const inputClass = "glass-input w-full";
    const labelClass = "block text-xs font-semibold uppercase tracking-wider mb-2";

    return (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="p-4 sm:p-6 max-w-7xl mx-auto">
            {/* Header with back button */}
            <div className="flex items-center gap-4 mb-4">
                <button onClick={onClose} className="flex items-center gap-2 text-sm font-medium transition-colors hover:opacity-80"
                    style={{ color: 'hsl(var(--muted-foreground))' }}>
                    <ChevronLeft size={20} /> <span>Back to Products</span>
                </button>
            </div>
            <div className="mb-6">
                <div className="tag-pill mb-3">
                    <Sparkles size={12} /> {product._id ? 'Edit Product' : 'New Product'}
                </div>
                <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight" style={{ color: 'hsl(var(--foreground))' }}>
                    {product._id ? "Edit Product" : "Add New Product"}
                </h1>
                <p className="text-sm mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                    {product._id ? 'Update product details below' : 'Fill in the details to list a new product'}
                </p>
            </div>

                <form onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }} onSubmit={handleSubmit} className="glass-panel p-4 sm:p-6 space-y-6">
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
                        <div ref={catWrapRef} className="relative">
                            <label className={labelClass} style={{ color: 'hsl(var(--muted-foreground))' }}>Category *</label>
                            <input type="text" required disabled={uploadingImages} value={product.category}
                                onFocus={() => setCatOpen(true)}
                                onChange={(e) => { setProduct({ ...product, category: e.target.value }); setCatOpen(true); setShowOtherInput(false); }}
                                className={inputClass} placeholder="Tap to choose or type a category" autoComplete="off" />
                            <AnimatePresence>
                                {catOpen && (
                                    <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.15 }}
                                        className="absolute z-50 mt-2 left-0 right-0 max-h-64 overflow-y-auto rounded-xl p-2 shadow-2xl border"
                                        style={{ background: 'hsl(var(--popover))', color: 'hsl(var(--popover-foreground))', borderColor: 'var(--glass-border)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
                                        {filteredCategories.length === 0 && !showOtherInput && (
                                            <p className="text-xs italic px-2 py-1.5" style={{ color: 'hsl(var(--muted-foreground))' }}>No matches</p>
                                        )}
                                        {filteredCategories.map((c) => (
                                            <button type="button" key={c}
                                                onClick={() => { setProduct({ ...product, category: c }); setCatOpen(false); setShowOtherInput(false); }}
                                                className="w-full text-left px-3 py-2 rounded-lg text-sm hover:bg-white/10 transition-colors flex items-center justify-between"
                                                style={{ color: 'hsl(var(--foreground))' }}>
                                                <span>{c}</span>
                                                {product.category?.toLowerCase() === c.toLowerCase() && <CheckCircle size={14} style={{ color: 'hsl(150,60%,45%)' }} />}
                                            </button>
                                        ))}
                                        <div className="mt-1 pt-2" style={{ borderTop: '1px solid var(--glass-border)' }}>
                                            {!showOtherInput ? (
                                                <button type="button" onClick={() => { setShowOtherInput(true); setProduct({ ...product, category: exactMatch ? '' : product.category }); }}
                                                    className="w-full text-left px-3 py-2 rounded-lg text-sm font-semibold hover:bg-white/10 transition-colors flex items-center gap-2"
                                                    style={{ color: 'hsl(280, 60%, 60%)' }}>
                                                    <Sparkles size={14} /> Other (custom category)
                                                </button>
                                            ) : (
                                                <div className="flex gap-2 p-1">
                                                    <input type="text" autoFocus value={product.category}
                                                        onChange={(e) => setProduct({ ...product, category: e.target.value })}
                                                        placeholder="Type your category"
                                                        className="glass-input flex-1 text-sm" />
                                                    <button type="button" onClick={() => { setCatOpen(false); setShowOtherInput(false); }}
                                                        className="px-3 py-2 rounded-xl text-white font-medium text-sm"
                                                        style={{ background: 'linear-gradient(135deg, hsl(150,60%,45%), hsl(170,50%,40%))' }}>
                                                        Save
                                                    </button>
                                                </div>
                                            )}
                                        </div>
                                    </motion.div>
                                )}
                            </AnimatePresence>
                        </div>
                        <div>
                            <label className={labelClass} style={{ color: 'hsl(var(--muted-foreground))' }}>Stock *</label>
                            <input type="number" min={0} required disabled={uploadingImages} value={product.stock}
                                onChange={(e) => setProduct({ ...product, stock: Math.round(e.target.value) || 0 })}
                                className={inputClass} placeholder="Enter stock quantity" />
                        </div>
                        <div>
                            <label className={labelClass} style={{ color: 'hsl(var(--muted-foreground))' }}>
                                Price ({editingCurrencySymbol}) * <span className="text-[10px] normal-case font-normal ml-1">in {editingCurrency}</span>
                            </label>
                            <div className="relative">
                                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm font-medium" style={{ color: 'hsl(var(--muted-foreground))' }}>{editingCurrencySymbol}</span>
                                <input type="number" min="0" step="0.01" required disabled={uploadingImages}
                                    value={displayAmount(product.price)}
                                    onChange={(e) => {
                                        const inputAmount = e.target.value === '' ? '' : parseFloat(e.target.value) || 0;
                                        setProduct({
                                            ...product,
                                            price: inputAmount,
                                            currency: editingCurrency,
                                            priceCurrency: editingCurrency,
                                            priceInputAmount: inputAmount === '' ? null : inputAmount,
                                        });
                                    }}
                                    className={`${inputClass} pl-9`} placeholder={`0.00`} />
                            </div>
                        </div>
                        <div>
                            <label className={labelClass} style={{ color: 'hsl(var(--muted-foreground))' }}>
                                Discounted Price ({editingCurrencySymbol}) <span className="text-[10px] normal-case font-normal ml-1">in {editingCurrency}</span>
                            </label>
                            <div className="relative">
                                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm font-medium" style={{ color: 'hsl(var(--muted-foreground))' }}>{editingCurrencySymbol}</span>
                                <input type="number" min="0" step="0.01" disabled={uploadingImages}
                                    value={displayAmount(product.discountedPrice)}
                                    onChange={(e) => {
                                        const inputAmount = parseFloat(e.target.value) || 0;
                                        setProduct({
                                            ...product,
                                            currency: editingCurrency,
                                            priceCurrency: editingCurrency,
                                            discountedPrice: inputAmount,
                                            discountedPriceCurrency: editingCurrency,
                                            discountedPriceInputAmount: inputAmount,
                                        });
                                    }}
                                    className={`${inputClass} pl-9`} placeholder={`Discounted price (optional)`} />
                            </div>
                        </div>
                    </div>

                    {/* Description */}
                    <div>
                        <div className="flex items-center justify-between gap-2 mb-1.5 flex-wrap">
                            <label className={labelClass + ' mb-0'} style={{ color: 'hsl(var(--muted-foreground))' }}>Description *</label>
                            <span className="text-[10px] font-medium" style={{ color: descAtLimit ? 'hsl(0, 72%, 55%)' : 'hsl(var(--muted-foreground))' }}>
                                {descLength} / {MAX_DESCRIPTION_LENGTH}
                            </span>
                        </div>
                        <textarea required disabled={uploadingImages || improvingDesc} value={product.description}
                            maxLength={MAX_DESCRIPTION_LENGTH}
                            onChange={(e) => { setProduct({ ...product, description: e.target.value.slice(0, MAX_DESCRIPTION_LENGTH) }); if (previousDescription !== null) setPreviousDescription(null); }}
                            rows={4} className={inputClass} placeholder="Enter product description" />
                        {product.description?.trim() && (
                            <div className="mt-2 flex flex-wrap gap-2">
                                <motion.button type="button" disabled={improvingDesc || uploadingImages}
                                    whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}
                                    onClick={improveDescription}
                                    className="flex items-center gap-2 px-3.5 py-2 rounded-xl text-white font-semibold text-xs disabled:opacity-60"
                                    style={{ background: 'linear-gradient(135deg, hsl(280, 70%, 50%), hsl(320, 60%, 55%))' }}>
                                    {improvingDesc ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
                                    {improvingDesc ? 'Improving…' : 'Improve with AI'}
                                </motion.button>
                                {previousDescription !== null && (
                                    <motion.button type="button" disabled={uploadingImages}
                                        initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }}
                                        whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}
                                        onClick={revertDescription}
                                        className="flex items-center gap-2 px-3.5 py-2 rounded-xl glass-inner font-semibold text-xs"
                                        style={{ color: 'hsl(var(--foreground))' }}>
                                        <RotateCcw size={14} /> Revert
                                    </motion.button>
                                )}
                            </div>
                        )}
                    </div>

                    {/* Main Image */}
                    <div>
                        <label className={labelClass} style={{ color: 'hsl(var(--muted-foreground))' }}>Main Image *</label>
                        <div className="flex gap-2 mb-3">
                            <button type="button" disabled={uploadingImages}
                                onClick={() => setProduct({ ...product, imageInputType: 'url' })}
                                className={`flex-1 px-3 py-2 rounded-xl text-sm font-medium transition-all ${(product.imageInputType || 'url') === 'url' ? 'border' : 'glass-inner'}`}
                                style={(product.imageInputType || 'url') === 'url'
                                    ? { background: 'rgba(16, 185, 129, 0.12)', color: 'hsl(150, 60%, 45%)', borderColor: 'rgba(16, 185, 129, 0.3)' }
                                    : { color: 'hsl(var(--muted-foreground))' }}>
                                URL
                            </button>
                            <button type="button" disabled={uploadingImages}
                                onClick={() => setProduct({ ...product, imageInputType: 'file' })}
                                className={`flex-1 px-3 py-2 rounded-xl text-sm font-medium transition-all ${product.imageInputType === 'file' ? 'border' : 'glass-inner'}`}
                                style={product.imageInputType === 'file'
                                    ? { background: 'rgba(16, 185, 129, 0.12)', color: 'hsl(150, 60%, 45%)', borderColor: 'rgba(16, 185, 129, 0.3)' }
                                    : { color: 'hsl(var(--muted-foreground))' }}>
                                Upload File
                            </button>
                        </div>

                        {(product.imageInputType || 'url') === 'url' && (
                            <input type="text" required={!product.image} disabled={uploadingImages}
                                value={product.image || ''}
                                onChange={(e) => setProduct({ ...product, image: e.target.value })}
                                className={inputClass} placeholder="Enter main image URL" />
                        )}

                        {product.imageInputType === 'file' && (
                            <div>
                                <input type="file" accept="image/*" disabled={uploadingImages}
                                    onChange={(e) => {
                                        const file = e.target.files[0];
                                        if (file) {
                                            if (file.size > 5 * 1024 * 1024) { alert('File size should be less than 5MB'); e.target.value = ''; return; }
                                            setProduct({ ...product, imageFile: file, image: URL.createObjectURL(file) });
                                        }
                                    }}
                                    className="glass-input w-full file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-white/10 file:text-current hover:file:bg-white/15" />
                                <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>Max 5MB (uploads on save)</p>
                            </div>
                        )}

                        {product.image && (
                            <div className="mt-3">
                                <img src={product.image} alt="Main preview" className="h-40 object-cover rounded-xl" style={{ border: '1px solid var(--glass-border)' }} />
                            </div>
                        )}
                    </div>

                    {/* Additional Images */}
                    <div>
                        <label className={labelClass} style={{ color: 'hsl(var(--muted-foreground))' }}>Additional Images</label>
                        <div className="flex gap-2 mb-3">
                            <button type="button" disabled={uploadingImages}
                                onClick={() => setProduct({ ...product, additionalImageInputType: 'url' })}
                                className={`flex-1 px-3 py-2 rounded-xl text-sm font-medium transition-all ${(product.additionalImageInputType || 'url') === 'url' ? 'border' : 'glass-inner'}`}
                                style={(product.additionalImageInputType || 'url') === 'url'
                                    ? { background: 'rgba(16, 185, 129, 0.12)', color: 'hsl(150, 60%, 45%)', borderColor: 'rgba(16, 185, 129, 0.3)' }
                                    : { color: 'hsl(var(--muted-foreground))' }}>
                                URL
                            </button>
                            <button type="button" disabled={uploadingImages}
                                onClick={() => setProduct({ ...product, additionalImageInputType: 'file' })}
                                className={`flex-1 px-3 py-2 rounded-xl text-sm font-medium transition-all ${product.additionalImageInputType === 'file' ? 'border' : 'glass-inner'}`}
                                style={product.additionalImageInputType === 'file'
                                    ? { background: 'rgba(16, 185, 129, 0.12)', color: 'hsl(150, 60%, 45%)', borderColor: 'rgba(16, 185, 129, 0.3)' }
                                    : { color: 'hsl(var(--muted-foreground))' }}>
                                Upload File
                            </button>
                        </div>

                        {(product.additionalImageInputType || 'url') === 'url' && (
                            <div className="flex gap-2">
                                <input type="text" disabled={uploadingImages} value={newImage}
                                    onChange={(e) => setNewImage(e.target.value)}
                                    className={`${inputClass} flex-1`} placeholder="Enter image URL" />
                                <motion.button type="button" disabled={uploadingImages} whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}
                                    onClick={handleAddImage}
                                    className="px-4 py-2 rounded-xl text-white font-medium text-sm"
                                    style={{ background: 'linear-gradient(135deg, hsl(150, 60%, 45%), hsl(170, 50%, 40%))' }}>
                                    Add
                                </motion.button>
                            </div>
                        )}

                        {product.additionalImageInputType === 'file' && (
                            <div>
                                <input type="file" accept="image/*" disabled={uploadingImages}
                                    onChange={(e) => {
                                        const file = e.target.files[0];
                                        if (file) {
                                            if (file.size > 5 * 1024 * 1024) { alert('File size should be less than 5MB'); e.target.value = ''; return; }
                                            const imageFiles = product.imageFiles || [];
                                            imageFiles.push(file);
                                            setProduct({ ...product, imageFiles, images: [...productImages, { url: URL.createObjectURL(file), isFile: true }] });
                                            e.target.value = '';
                                        }
                                    }}
                                    className="glass-input w-full file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-white/10 file:text-current hover:file:bg-white/15" />
                                <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>Max 5MB (uploads on save)</p>
                            </div>
                        )}

                        {productImages.length > 0 && (
                            <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-3">
                                {productImages.map((img, index) => (
                                    <div key={index} className="relative group rounded-xl overflow-hidden" style={{ border: '1px solid var(--glass-border)' }}>
                                        <img src={img.url} alt={`Product view ${index + 1}`} className="h-28 w-full object-cover" />
                                        <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 flex items-center justify-center gap-2 transition-opacity">
                                            <button type="button" disabled={uploadingImages} onClick={() => handleSetMainImage(img.url)}
                                                className="p-1.5 rounded-lg bg-white/20 backdrop-blur-sm" style={{ color: 'hsl(150, 60%, 60%)' }} title="Set as main">
                                                <Star size={14} />
                                            </button>
                                            <button type="button" disabled={uploadingImages} onClick={() => handleRemoveImage(index)}
                                                className="p-1.5 rounded-lg bg-white/20 backdrop-blur-sm" style={{ color: 'hsl(0, 72%, 60%)' }} title="Remove">
                                                <X size={14} />
                                            </button>
                                        </div>
                                        {img.url === product.image && (
                                            <div className="absolute top-2 left-2 text-[10px] px-2 py-0.5 rounded-full font-semibold text-white"
                                                style={{ background: 'hsl(150, 60%, 45%)' }}>
                                                Main
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* Tags */}
                    <div>
                        <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
                            <label className={labelClass + ' mb-0'} style={{ color: 'hsl(var(--muted-foreground))' }}>
                                Tags <span className="text-[10px] normal-case font-normal" style={{ color: tagsAtLimit ? 'hsl(0, 72%, 55%)' : 'hsl(var(--muted-foreground))' }}>({productTags.length}/{MAX_TAGS})</span>
                            </label>
                            <motion.button type="button" disabled={generatingTags || uploadingImages || tagsAtLimit}
                                whileHover={{ scale: tagsAtLimit ? 1 : 1.02 }} whileTap={{ scale: tagsAtLimit ? 1 : 0.98 }}
                                onClick={generateAiTags}
                                title={tagsAtLimit ? `Tag limit reached (${MAX_TAGS} max)` : 'Generate tags with AI'}
                                className="flex items-center gap-2 px-3 py-1.5 rounded-xl text-white font-semibold text-xs disabled:opacity-50 disabled:cursor-not-allowed"
                                style={{ background: 'linear-gradient(135deg, hsl(280, 70%, 50%), hsl(320, 60%, 55%))' }}>
                                {generatingTags ? <Loader2 size={13} className="animate-spin" /> : <Wand2 size={13} />}
                                {generatingTags ? 'Generating…' : 'Generate Tags with AI'}
                            </motion.button>
                        </div>
                        <div className="flex gap-2">
                            <input type="text" disabled={uploadingImages || tagsAtLimit} value={newTag}
                                onChange={(e) => setNewTag(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddTag(); } }}
                                className={`${inputClass} flex-1`} placeholder={tagsAtLimit ? `Maximum ${MAX_TAGS} tags reached` : 'Enter a tag'} />
                            <motion.button type="button" disabled={uploadingImages || tagsAtLimit}
                                whileHover={{ scale: tagsAtLimit ? 1 : 1.02 }} whileTap={{ scale: tagsAtLimit ? 1 : 0.98 }}
                                onClick={handleAddTag}
                                className="px-4 py-2 rounded-xl text-white font-medium text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                                style={{ background: 'linear-gradient(135deg, hsl(150, 60%, 45%), hsl(170, 50%, 40%))' }}>
                                Add
                            </motion.button>
                        </div>
                        {productTags.length > 0 && (
                            <div className="mt-3 flex flex-wrap gap-2">
                                {productTags.map((tag, index) => (
                                    <span key={index} className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium"
                                        style={{ background: 'rgba(16, 185, 129, 0.12)', color: 'hsl(150, 60%, 45%)' }}>
                                        {tag}
                                        <button type="button" disabled={uploadingImages} onClick={() => handleRemoveTag(tag)}
                                            className="ml-1.5 rounded-full flex-shrink-0" style={{ color: 'hsl(150, 60%, 45%)' }}>
                                            <X size={12} />
                                        </button>
                                    </span>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* Product Options (Size, Color, Material, etc.) */}
                    <div>
                        <label className={labelClass} style={{ color: 'hsl(var(--muted-foreground))' }}>
                            Product Options <span className="text-[10px] normal-case font-normal">(Optional — let buyers pick size, color, etc.)</span>
                        </label>
                        <OptionGroupsBuilder product={product} setProduct={setProduct} disabled={uploadingImages} />
                    </div>


                    {/* Custom Return Policy Toggle Card */}
                    {(() => {
                        const customOn = !(product.returnPolicy?.useStorePolicy ?? true);
                        return (
                            <div className="rounded-2xl p-5 transition-all" style={{ background: customOn ? 'linear-gradient(135deg, rgba(16,185,129,0.10), rgba(99,102,241,0.06))' : 'rgba(255,255,255,0.04)', border: `1px solid ${customOn ? 'rgba(16,185,129,0.3)' : 'var(--glass-border)'}` }}>
                                <button type="button" onClick={() => setProduct({ ...product, returnPolicy: { ...(product.returnPolicy || {}), useStorePolicy: customOn ? true : false } })}
                                    className="w-full flex items-start gap-4 text-left">
                                    <div className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0" style={{ background: customOn ? 'linear-gradient(135deg, hsl(150,60%,45%), hsl(170,50%,40%))' : 'rgba(0,0,0,0.05)', color: customOn ? 'white' : 'hsl(var(--muted-foreground))' }}>
                                        <Truck size={20} />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <p className="text-sm font-semibold" style={{ color: 'hsl(var(--foreground))' }}>Custom Return Policy</p>
                                        <p className="text-xs mt-0.5" style={{ color: 'hsl(var(--muted-foreground))' }}>Override the store-default policy for this product only.</p>
                                    </div>
                                    <span className="relative inline-flex h-6 w-11 items-center rounded-full transition-colors shrink-0 mt-1" style={{ background: customOn ? 'hsl(150,60%,45%)' : 'rgba(0,0,0,0.15)' }}>
                                        <span className="inline-block h-5 w-5 rounded-full bg-white shadow transition-transform" style={{ transform: customOn ? 'translateX(22px)' : 'translateX(2px)' }} />
                                    </span>
                                </button>
                                <AnimatePresence initial={false}>
                                    {customOn && (
                                        <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
                                            <div className="space-y-3 pt-4 mt-4" style={{ borderTop: '1px solid var(--glass-border)' }}>
                                                <label className="flex items-center gap-3 cursor-pointer">
                                                    <input type="checkbox" checked={product.returnPolicy?.returnsEnabled || false}
                                                        onChange={e => setProduct({ ...product, returnPolicy: { ...product.returnPolicy, returnsEnabled: e.target.checked } })}
                                                        className="h-4 w-4 rounded" style={{ accentColor: 'hsl(150, 60%, 45%)' }} />
                                                    <span className="text-sm font-medium" style={{ color: 'hsl(var(--foreground))' }}>Allow Returns</span>
                                                </label>
                                                {product.returnPolicy?.returnsEnabled && (
                                                    <div className="grid grid-cols-2 gap-3 pl-7">
                                                        <div>
                                                            <label className="block text-xs font-semibold mb-1" style={{ color: 'hsl(var(--muted-foreground))' }}>Days</label>
                                                            <input type="number" min={1} value={product.returnPolicy?.returnDuration || ''} onChange={e => setProduct({ ...product, returnPolicy: { ...product.returnPolicy, returnDuration: parseInt(e.target.value) || 0 } })} className="glass-input text-sm py-2" />
                                                        </div>
                                                        <div>
                                                            <label className="block text-xs font-semibold mb-1" style={{ color: 'hsl(var(--muted-foreground))' }}>Refund Type</label>
                                                            <select value={product.returnPolicy?.refundType || 'none'} onChange={e => setProduct({ ...product, returnPolicy: { ...product.returnPolicy, refundType: e.target.value } })} className="glass-input text-sm py-2 cursor-pointer">
                                                                <option value="none">No Refund</option><option value="full_refund">Full Refund</option><option value="replacement_only">Replacement</option><option value="store_credit">Store Credit</option>
                                                            </select>
                                                        </div>
                                                    </div>
                                                )}
                                                <label className="flex items-center gap-3 cursor-pointer">
                                                    <input type="checkbox" checked={product.returnPolicy?.warrantyEnabled || false}
                                                        onChange={e => setProduct({ ...product, returnPolicy: { ...product.returnPolicy, warrantyEnabled: e.target.checked } })}
                                                        className="h-4 w-4 rounded" style={{ accentColor: 'hsl(45, 80%, 45%)' }} />
                                                    <span className="text-sm font-medium" style={{ color: 'hsl(var(--foreground))' }}>Warranty</span>
                                                    {product.returnPolicy?.warrantyEnabled && (
                                                        <input type="number" min={1} placeholder="Months" value={product.returnPolicy?.warrantyDuration || ''} onChange={e => setProduct({ ...product, returnPolicy: { ...product.returnPolicy, warrantyDuration: parseInt(e.target.value) || 0 } })} className="glass-input text-sm py-1.5 w-24" />
                                                    )}
                                                </label>
                                            </div>
                                        </motion.div>
                                    )}
                                </AnimatePresence>
                            </div>
                        );
                    })()}

                    {/* Featured Toggle Card — gated by plan tier featured limits */}
                    {(() => {
                        const featOn = !!product.isFeatured && canFeature;
                        const disabled = uploadingImages || !canFeature || (!product.isFeatured && !featuredStats.allowed);
                        return (
                            <div className="rounded-2xl p-5 transition-all" style={{ background: featOn ? 'linear-gradient(135deg, rgba(245,158,11,0.10), rgba(139,92,246,0.06))' : 'rgba(255,255,255,0.04)', border: `1px solid ${featOn ? 'rgba(245,158,11,0.3)' : 'var(--glass-border)'}`, opacity: !canFeature ? 0.85 : 1 }}>
                                <button type="button" disabled={disabled}
                                    onClick={() => setProduct({ ...product, isFeatured: !product.isFeatured })}
                                    className="w-full flex items-start gap-4 text-left disabled:cursor-not-allowed">
                                    <div className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0" style={{ background: featOn ? 'linear-gradient(135deg, hsl(45,80%,55%), hsl(35,90%,50%))' : 'rgba(0,0,0,0.05)', color: featOn ? 'white' : 'hsl(var(--muted-foreground))' }}>
                                        <Star size={20} />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2 flex-wrap">
                                            <p className="text-sm font-semibold" style={{ color: 'hsl(var(--foreground))' }}>Feature on Homepage</p>
                                            <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full" style={{ background: 'rgba(139, 92, 246, 0.12)', color: 'hsl(270, 60%, 55%)' }}>
                                                <Crown size={10} /> PREMIUM
                                            </span>
                                            {canFeature && (
                                                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full" style={{ background: featuredStats.current >= featuredStats.max ? 'rgba(239,68,68,0.12)' : 'rgba(16,185,129,0.12)', color: featuredStats.current >= featuredStats.max ? 'hsl(0,72%,55%)' : 'hsl(150,60%,45%)' }}>
                                                    {featuredStats.current}/{featuredStats.max} used
                                                </span>
                                            )}
                                        </div>
                                        <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                            {canFeature
                                                ? (!featuredStats.allowed && !product.isFeatured
                                                    ? `You've reached your limit of ${featuredStats.max} featured products. Upgrade your plan to feature more.`
                                                    : `Adds a Featured badge to your product. Your plan allows up to ${featuredStats.max} featured products.`)
                                                : (<>Available with an active subscription. <Link to="/seller-dashboard/subscription" className="underline font-semibold" style={{ color: 'hsl(270, 60%, 55%)' }}>Upgrade now →</Link></>)}
                                        </p>
                                    </div>
                                    <span className="relative inline-flex h-6 w-11 items-center rounded-full transition-colors shrink-0 mt-1" style={{ background: featOn ? 'hsl(45,80%,50%)' : 'rgba(0,0,0,0.15)', opacity: disabled ? 0.5 : 1 }}>
                                        <span className="inline-block h-5 w-5 rounded-full bg-white shadow transition-transform" style={{ transform: featOn ? 'translateX(22px)' : 'translateX(2px)' }} />
                                    </span>
                                </button>
                            </div>
                        );
                    })()}

                    {/* Action Buttons */}
                    <div className="flex justify-end gap-3 pt-4" style={{ borderTop: '1px solid var(--glass-border)' }}>
                        <button type="button" onClick={onClose} disabled={uploadingImages}
                            className="px-5 py-2.5 rounded-xl glass-inner font-medium text-sm disabled:opacity-50"
                            style={{ color: 'hsl(var(--foreground))' }}>
                            Cancel
                        </button>
                        <motion.button type="submit" disabled={uploadingImages} whileHover={!uploadingImages ? { scale: 1.02 } : {}} whileTap={!uploadingImages ? { scale: 0.98 } : {}}
                            className="px-5 py-2.5 rounded-xl text-white font-semibold text-sm flex items-center gap-2 disabled:opacity-60"
                            style={{ background: 'linear-gradient(135deg, hsl(150, 60%, 45%), hsl(170, 50%, 40%))', boxShadow: '0 0 20px -4px hsl(150, 60%, 45%, 0.3)' }}>
                            {uploadingImages && <Loader2 className="w-4 h-4 animate-spin" />}
                            {uploadingImages ? 'Uploading...' : (product._id ? "Update Product" : "Create Product")}
                        </motion.button>
                    </div>
                </form>
        </motion.div>
    );
};
