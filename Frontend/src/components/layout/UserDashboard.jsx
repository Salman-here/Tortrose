import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import GlassBackground from '../common/GlassBackground';
import {
    // ✅ User Dashboard essentials
    User,
    ShoppingCart,
    CreditCard,
    HelpCircle,
    LogOut,
    Home,

    // ✅ Extra icons (for Admin dashboard or other features)
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
    LayoutDashboard,
    MessageCircle,
    WalletCards,
    Bell,
} from "lucide-react";

import { useAuth } from '../../contexts/AuthContext';
import { Link, Navigate, Outlet, useLocation } from 'react-router-dom';
import OrderManagement from './orders';
import StoreOverview from './StoreOverview';
import ProductManagement from './ProductManagement';



const UserDashboard = () => {

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




    const [activeTab, setActiveTab] = useState('account overview');

    // useEffect(() => {
    //     fetchOrders()
    // }, [searchTerm, selectedCategory])





    // GET ORDERS
    // const fetchOrders = async () => {

    //     const token = getAuthToken()
    //     setLoading(true)
    //     try {
    //         const query = serializeFilters()
    //         // console.log(query);
    //         const res = await axios.get(`${import.meta.env.VITE_API_URL}api/order/get?${query}`,
    //             {
    //                 headers: {
    //                     Authorization: `Bearer ${token}`
    //                 }
    //             }
    //         )
    //         console.log(res.data);
    //         setOrders(res.data?.orders)
    //     } catch (error) {
    //         console.error(error);
    //     }
    //     finally {
    //         setLoading(false)
    //     }
    // }


    const outletContext = { dashboardRole: 'user' };


    return (
        <div className="min-h-screen relative flex" style={{ background: 'linear-gradient(135deg, hsl(230, 35%, 88%) 0%, hsl(210, 40%, 90%) 25%, hsl(250, 30%, 92%) 50%, hsl(200, 35%, 88%) 75%, hsl(280, 25%, 90%) 100%)', backgroundAttachment: 'fixed' }}>
            <GlassBackground />

            {/* Sidebar */}
            <Sidebar activeTab={activeTab} setActiveTab={setActiveTab} />

            {/* Main Content */}
            <div className={`flex-1 ${!isMobile ? 'ml-64' : 'pt-24'} `}>
                <Outlet context={outletContext} />
            </div>


        </div>
    );
};

// Sidebar Component
const Sidebar = ({ activeTab, setActiveTab }) => {
    const { currentUser } = useAuth()

    const menuItems = [
        { id: 'account overview', label: 'Account Overview', icon: <LayoutDashboard size={18} />, link: '/user-dashboard/account-overview' },
        { id: 'profile', label: 'Profile', icon: <User size={18} />, link: '/user-dashboard/profile' },
        { id: 'orders', label: 'Your Orders', icon: <ShoppingCart size={18} />, link: '/user-dashboard/orders' },
        { id: 'wallet', label: 'Rozare Wallet', icon: <WalletCards size={18} />, link: '/user-dashboard/wallet' },
        { id: 'notifications', label: 'Notifications', icon: <Bell size={18} />, link: '/user-dashboard/notifications' },
        { id: 'payment methods', label: 'Saved Cards', icon: <CreditCard size={18} />, link: '/user-dashboard/payment-methods' },
        { id: 'whatsapp', label: 'WhatsApp AI', icon: <MessageCircle size={18} />, link: '/user-dashboard/whatsapp' },
    ];

    const [isSidebarOpen, setIsSidebarOpen] = useState(false);
    const [isMobile, setIsMobile] = useState(false);
    const location = useLocation()

    useEffect(() => {
        const checkIsMobile = () => setIsMobile(window.innerWidth < 1024);
        checkIsMobile();
        window.addEventListener('resize', checkIsMobile);
        return () => window.removeEventListener('resize', checkIsMobile);
    }, []);

    useEffect(() => {
        menuItems.forEach(item => { if (item.link === location.pathname) setActiveTab(item.id) })
        // The menu definition is local/static; route changes own tab selection.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [location])

    const handleTabClick = (tabId) => { setActiveTab(tabId); if (isMobile) setIsSidebarOpen(false); };

    const SidebarContent = () => (
        <div className={`flex flex-col h-full glass-panel-strong water-shimmer ${isMobile ? 'sidebar-mobile-solid' : ''}`} style={{ borderRadius: '0 28px 28px 0' }}>
            {/* Header */}
            <div className="flex items-center justify-between px-5 pt-6 pb-4">
                <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-xl flex items-center justify-center font-bold text-sm border"
                        style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))', color: 'white', borderColor: 'rgba(255,255,255,0.3)' }}>
                        {currentUser?.username?.[0]?.toUpperCase() || 'U'}
                    </div>
                    <div>
                        <p className="font-semibold text-sm leading-tight truncate max-w-[120px]" style={{ color: 'hsl(var(--foreground))' }}>{currentUser?.username || 'User'}</p>
                        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full" style={{ background: 'rgba(99, 102, 241, 0.15)', color: 'hsl(220, 70%, 55%)' }}>Member</span>
                    </div>
                </div>
                {isMobile && (
                    <button onClick={() => setIsSidebarOpen(false)} className="p-1.5 rounded-lg glass-inner transition-colors"
                        style={{ color: 'hsl(var(--muted-foreground))' }}>
                        <X size={16} />
                    </button>
                )}
            </div>

            <div className="mx-4 h-px" style={{ background: 'var(--glass-border)' }} />

            {/* Nav */}
            <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
                <p className="text-[10px] font-semibold uppercase tracking-wider px-3 mb-2" style={{ color: 'hsl(var(--muted-foreground))' }}>Menu</p>
                {menuItems.map(item => {
                    const isActive = activeTab === item.id
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
                                {isActive && <div className="ml-auto w-1.5 h-1.5 rounded-full" style={{ background: 'hsl(220, 70%, 55%)' }} />}
                            </motion.button>
                        </Link>
                    )
                })}
            </nav>

            {/* Footer */}
            <div className="px-3 pb-5 pt-3" style={{ borderTop: '1px solid var(--glass-border)' }}>
                <Link to="/">
                    <motion.button whileHover={{ x: 2 }}
                        className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all"
                        style={{ color: 'hsl(var(--muted-foreground))' }}>
                        <LayoutPanelLeft size={18} />
                        Back to Store
                    </motion.button>
                </Link>
            </div>
        </div>
    )

    return (
        <>
            {/* Mobile expanding header (replaces drawer) */}
            {isMobile && (
                <div className="fixed top-4 left-4 right-4 z-50 glass-panel-strong" style={{ borderRadius: 20 }}>
                    <div className="flex items-center justify-between px-4 py-3">
                        <div className="flex items-center gap-3">
                            <div className="w-9 h-9 rounded-xl flex items-center justify-center font-bold text-sm border"
                                style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))', color: 'white', borderColor: 'rgba(255,255,255,0.3)' }}>
                                {currentUser?.username?.[0]?.toUpperCase() || 'U'}
                            </div>
                            <p className="text-sm font-bold" style={{ color: 'hsl(var(--foreground))' }}>{currentUser?.username || 'My Account'}</p>
                        </div>
                        <motion.button whileTap={{ scale: 0.95 }} onClick={() => setIsSidebarOpen(o => !o)}
                            className="p-2 rounded-xl glass-inner" style={{ color: 'hsl(var(--foreground))' }}>
                            <motion.div key={isSidebarOpen ? 'x' : 'm'} initial={{ rotate: -90, opacity: 0 }} animate={{ rotate: 0, opacity: 1 }} transition={{ duration: 0.2 }}>
                                {isSidebarOpen ? <X size={20} /> : <Menu size={20} />}
                            </motion.div>
                        </motion.button>
                    </div>
                    <AnimatePresence initial={false}>
                        {isSidebarOpen && (
                            <motion.div
                                initial={{ height: 0, opacity: 0 }}
                                animate={{ height: 'auto', opacity: 1 }}
                                exit={{ height: 0, opacity: 0 }}
                                transition={{ duration: 0.25, ease: 'easeOut' }}
                                className="overflow-hidden"
                                style={{ borderTop: '1px solid var(--glass-border)' }}
                            >
                                <div className="px-3 py-3 space-y-1">
                                    {menuItems.map(item => {
                                        const isActive = activeTab === item.id;
                                        return (
                                            <Link key={item.id} to={item.link} onClick={() => handleTabClick(item.id)}>
                                                <button className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all hover:bg-white/10"
                                                    style={isActive ? { background: 'rgba(99,102,241,0.12)', color: 'hsl(var(--foreground))', border: '1px solid rgba(99,102,241,0.25)' } : { color: 'hsl(var(--foreground))' }}>
                                                    <span className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'var(--glass-bg)', color: isActive ? 'hsl(220,70%,55%)' : 'hsl(var(--muted-foreground))' }}>{item.icon}</span>
                                                    <span className="flex-1 text-left">{item.label}</span>
                                                </button>
                                            </Link>
                                        );
                                    })}
                                    <Link to="/" onClick={() => setIsSidebarOpen(false)}>
                                        <button className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all hover:bg-white/10" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                            <span className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'var(--glass-bg)' }}><LayoutPanelLeft size={18} /></span>
                                            <span className="flex-1 text-left">Back to Store</span>
                                        </button>
                                    </Link>
                                </div>
                            </motion.div>
                        )}
                    </AnimatePresence>
                </div>
            )}

            {!isMobile && (
                <motion.div
                    initial={false}
                    animate={{ x: 0 }}
                    transition={{ type: 'tween', ease: 'easeInOut', duration: 0.28 }}
                    className="fixed top-0 left-0 h-full w-64 z-50 shadow-2xl overflow-hidden">
                    <SidebarContent />
                </motion.div>
            )}
        </>
    );
};

export default UserDashboard;
