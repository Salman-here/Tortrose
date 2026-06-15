import React, { useEffect, useState } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "../../contexts/AuthContext";
import { motion, AnimatePresence } from "framer-motion";
import NavDropdown from "../common/Dropdown";
import {
    ShoppingCart, Menu, X, Home, LogIn, LogOut, Sun, Moon,
    Package, ShoppingBag, LayoutDashboard, Crown, Store
} from "lucide-react";
import { useGlobal } from "../../contexts/GlobalContext";
import WishlistDropdown from "../common/Wishlist";
import { useTheme } from "../../contexts/ThemeContext";
import { navigateToMainDomainPath, isSubdomain } from "../../utils/subdomainHelper";

function Navbar() {
    const { currentUser, logout } = useAuth();
    const { cartItems, toggleCart, cartBtn, fetchCart } = useGlobal();
    const { isDark, toggleTheme } = useTheme();
    const [isScrolled, setIsScrolled] = useState(false);
    const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
    const navigate = useNavigate();
    const location = useLocation();

    useEffect(() => {
        const onScroll = () => setIsScrolled(window.scrollY >= 20);
        window.addEventListener('scroll', onScroll);
        fetchCart();
        return () => window.removeEventListener('scroll', onScroll);
    }, []);

    // Close mobile menu on route change
    useEffect(() => { setMobileMenuOpen(false); }, [location.pathname]);

    // Mobile menu now expands inline within the nav — no body scroll lock needed.

    const navLinks = [
        { label: 'Home', to: '/', icon: Home },
        { label: 'Marketplace', to: '/marketplace', icon: ShoppingBag },
        { label: 'Track Order', to: '/track-order', icon: Package },
    ];

    // Build mobile menu items
    const mobileMenuItems = [
        ...navLinks,
        ...(currentUser?.role === 'admin'
            ? [{ label: 'Admin Dashboard', to: '/admin-dashboard/store-overview', icon: Crown, accent: 'gold' }]
            : []),
        ...(currentUser?.role === 'seller'
            ? [{ label: 'Seller Dashboard', to: '/seller-dashboard/store-overview', icon: Store, accent: 'emerald' }]
            : []),
        ...(currentUser
            ? [{ label: 'Your Dashboard', to: '/user-dashboard/account-overview', icon: LayoutDashboard }]
            : []),
        ...(currentUser?.role === 'user'
            ? [{ label: 'Become a Seller', to: '/become-seller', icon: Store }]
            : []),
    ];

    // Handle navigation - redirect to main domain if on subdomain
    const handleNavClick = (e, path) => {
        if (isSubdomain()) {
            e.preventDefault();
            navigateToMainDomainPath(path);
        }
        // Otherwise let Link handle it normally
    };

    return (
        <nav className={`transition-all duration-300 fixed z-50
                px-3 sm:px-4 md:px-10 lg:px-14
                ${isScrolled
                ? 'top-0 left-0 right-0 glass-panel-strong backdrop-blur-md'
                : 'top-4 left-3 right-3 sm:left-4 sm:right-4 glass-panel backdrop-blur-sm'
            }`}
            style={{
                borderRadius: isScrolled ? '0' : '24px',
                background: 'var(--store-theme-nav-bg, var(--glass-bg))',
                borderColor: 'var(--store-theme-nav-border, var(--glass-border))',
                color: 'var(--store-theme-nav-fg, hsl(var(--foreground)))',
            }}
        >
            {/* Top row — fixed height */}
            <div className={`flex justify-between items-center ${isScrolled ? 'h-[60px]' : 'h-[60px] sm:h-[64px]'}`}>

                {/* Left: Logo + Nav Links */}
                <div className="flex items-center gap-3 sm:gap-6">
                    <Link to="/" onClick={(e) => handleNavClick(e, '/')} className="flex items-center shrink-0">
                        <div className="glass-inner p-1.5 rounded-xl flex items-center justify-center">
                            <img src="/rozare-logo.svg?v=2" alt="Rozare" className="h-6 sm:h-7 md:h-8 block" />
                        </div>
                    </Link>
                    <div className="hidden md:flex items-center gap-1">
                        {navLinks.map(link => (
                            <Link key={link.to} to={link.to}
                                onClick={(e) => handleNavClick(e, link.to)}
                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm font-medium hover:bg-white/10 transition-all duration-300"
                                style={{ color: 'var(--store-theme-nav-fg, hsl(var(--foreground)))' }}>
                                {link.label}
                            </Link>
                        ))}
                    </div>
                </div>

                {/* Center: User Dropdown (desktop) */}
                <div className="hidden md:flex justify-center">
                    {currentUser && <NavDropdown />}
                </div>

                {/* Right: Cart, Wishlist, Login */}
                <div className="flex items-center gap-1.5 sm:gap-2 md:gap-3">
                    <button onClick={toggleTheme}
                        className="p-1.5 sm:p-2 rounded-xl glass-button transition-all duration-300"
                        style={{ color: 'var(--store-theme-nav-fg, hsl(var(--foreground)))' }}
                        aria-label="Toggle dark mode">
                        <motion.div key={isDark ? 'moon' : 'sun'} initial={{ rotate: -90, opacity: 0 }} animate={{ rotate: 0, opacity: 1 }} transition={{ duration: 0.3 }}>
                            {isDark ? <Sun size={16} className="sm:w-[18px] sm:h-[18px]" /> : <Moon size={16} className="sm:w-[18px] sm:h-[18px]" />}
                        </motion.div>
                    </button>

                    <button ref={cartBtn} onClick={toggleCart}
                        className="relative flex items-center gap-1.5 px-2 sm:px-2.5 py-1.5 sm:py-2 rounded-xl glass-button text-sm font-medium"
                        style={{ color: 'var(--store-theme-nav-fg, hsl(var(--foreground)))' }}>
                        <ShoppingCart size={16} className="sm:w-[18px] sm:h-[18px]" />
                        <span className="hidden sm:inline">Cart</span>
                        {(cartItems?.cart?.length || 0) > 0 && (
                            <span className="absolute -top-1.5 -right-1.5 text-[10px] font-bold min-w-[18px] min-h-[18px] flex items-center justify-center rounded-full shadow-md"
                                style={{ background: 'var(--logo-gradient)', color: 'white' }}>
                                {cartItems?.cart?.length || 0}
                            </span>
                        )}
                    </button>

                    <WishlistDropdown />

                    {!currentUser && (
                        <Link to="/login" onClick={(e) => handleNavClick(e, '/login')} className="hidden sm:block">
                            <button className="px-4 py-2 rounded-xl font-semibold text-sm transition-all glow-soft"
                                style={{
                                    background: 'var(--logo-gradient)',
                                    color: 'white',
                                    boxShadow: 'var(--logo-glow)',
                                }}>
                                Login / Sign Up
                            </button>
                        </Link>
                    )}

                    {/* Mobile hamburger */}
                    <button onClick={() => setMobileMenuOpen(o => !o)}
                        className="md:hidden p-1.5 sm:p-2 rounded-xl glass-button transition-transform"
                        aria-label={mobileMenuOpen ? 'Close menu' : 'Open menu'}
                        aria-expanded={mobileMenuOpen}>
                        <motion.div key={mobileMenuOpen ? 'x' : 'm'} initial={{ rotate: -90, opacity: 0 }} animate={{ rotate: 0, opacity: 1 }} transition={{ duration: 0.2 }}>
                            {mobileMenuOpen ? <X size={20} className="sm:w-[22px] sm:h-[22px]" /> : <Menu size={20} className="sm:w-[22px] sm:h-[22px]" />}
                        </motion.div>
                    </button>
                </div>
            </div>

            {/* Mobile expanding section — extends nav height down */}
            <AnimatePresence initial={false}>
                {mobileMenuOpen && (
                    <motion.div
                        key="mobile-menu"
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.25, ease: 'easeOut' }}
                        className="md:hidden overflow-hidden"
                    >
                        <div className="py-3 space-y-1 border-t" style={{ borderColor: 'hsl(var(--border))' }}>
                            {mobileMenuItems.map(item => {
                                const Icon = item.icon;
                                const active = location.pathname === item.to ||
                                    (item.to !== '/' && location.pathname.startsWith(item.to));
                                const accentColor =
                                    item.accent === 'gold' ? '#f59e0b' :
                                    item.accent === 'emerald' ? '#10b981' :
                                    'var(--store-theme-nav-fg, hsl(var(--foreground)))';
                                return (
                                    <Link key={item.to} to={item.to}
                                        onClick={(e) => { setMobileMenuOpen(false); handleNavClick(e, item.to); }}
                                        className="flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all hover:bg-white/10 active:scale-[0.98] font-medium text-[15px]"
                                        style={{
                                            background: active ? 'var(--glass-bg-strong)' : 'transparent',
                                            border: active ? '1px solid var(--glass-border)' : '1px solid transparent',
                                            color: 'var(--store-theme-nav-fg, hsl(var(--foreground)))',
                                        }}>
                                        <span className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
                                            style={{ background: 'var(--glass-bg)', color: accentColor }}>
                                            <Icon size={18} />
                                        </span>
                                        <span className="flex-1">{item.label}</span>
                                    </Link>
                                );
                            })}

                            <div className="h-px my-2" style={{ background: 'hsl(var(--border))' }} />

                            {currentUser ? (
                                <button
                                    onClick={() => { setMobileMenuOpen(false); logout(); }}
                                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all hover:bg-red-500/10 active:scale-[0.98] font-semibold text-[15px]"
                                    style={{ color: 'hsl(0, 72%, 55%)' }}>
                                    <span className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
                                        style={{ background: 'rgba(244,63,94,0.12)' }}>
                                        <LogOut size={18} />
                                    </span>
                                    Logout
                                </button>
                            ) : (
                                <Link to="/login" onClick={(e) => { setMobileMenuOpen(false); handleNavClick(e, '/login'); }}
                                    className="flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl font-semibold text-[15px]"
                                    style={{
                                        background: 'var(--logo-gradient)',
                                        color: 'white',
                                        boxShadow: 'var(--logo-glow)',
                                    }}>
                                    <LogIn size={18} /> Login / Sign Up
                                </Link>
                            )}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </nav>
    );
}

export default Navbar;
