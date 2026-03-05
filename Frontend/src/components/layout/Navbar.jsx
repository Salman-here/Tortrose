import React, { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../../contexts/AuthContext";
import { motion, AnimatePresence } from "framer-motion";
import NavDropdown from "../common/Dropdown";
import { ShoppingCart, Menu, X, Store, Home, LogIn, Sun, Moon } from "lucide-react";
import { useGlobal } from "../../contexts/GlobalContext";
import WishlistDropdown from "../common/Wishlist";
import { useTheme } from "../../contexts/ThemeContext";

function Navbar() {
    const { currentUser } = useAuth();
    const { cartItems, toggleCart, dropdownRef, cartBtn, fetchCart } = useGlobal();
    const { isDark, toggleTheme } = useTheme();
    const [isScrolled, setIsScrolled] = useState(false);
    const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
    const navigate = useNavigate();

    useEffect(() => {
        const onScroll = () => setIsScrolled(window.scrollY >= 20);
        window.addEventListener('scroll', onScroll);
        fetchCart();
        return () => window.removeEventListener('scroll', onScroll);
    }, []);

    const navLinks = [
        { label: 'Home', to: '/', icon: <Home size={18} /> },
        { label: 'Stores', to: '/stores', icon: <Store size={18} /> },
    ];

    return (
        <>
            <nav className={`transition-all duration-300 fixed z-50 flex justify-between items-center
                px-4 sm:px-6 md:px-10 lg:px-14
                ${isScrolled
                    ? 'top-0 left-0 right-0 h-[60px] glass-panel-strong'
                    : 'top-4 left-4 right-4 h-[60px] sm:h-[64px] glass-panel'
                }`}
                style={{
                    borderRadius: isScrolled ? '0' : '24px',
                }}
            >

                {/* Left: Logo + Nav Links */}
                <div className="flex items-center gap-6">
                    <Link to="/" className="flex items-center shrink-0">
                        <div className="glass-inner p-1.5 rounded-xl">
                            <img src="/tortrose-logo.svg" alt="Tortrose" className="h-7 sm:h-8" />
                        </div>
                    </Link>
                    <div className="hidden md:flex items-center gap-1">
                        {navLinks.map(link => (
                            <Link key={link.to} to={link.to}
                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm font-medium hover:bg-white/10 transition-all duration-300"
                                style={{ color: 'hsl(var(--foreground))' }}>
                                {link.label}
                            </Link>
                        ))}
                    </div>
                </div>

                {/* Center: User Dropdown */}
                <div className="hidden md:flex justify-center">
                    {currentUser && <NavDropdown />}
                </div>

                {/* Right: Cart, Wishlist, Login */}
                <div className="flex items-center gap-2 sm:gap-3">
                    {/* Theme Toggle */}
                    <button onClick={toggleTheme}
                        className="p-2 rounded-xl glass-button transition-all duration-300"
                        style={{ color: 'hsl(var(--foreground))' }}
                        aria-label="Toggle dark mode">
                        <motion.div key={isDark ? 'moon' : 'sun'} initial={{ rotate: -90, opacity: 0 }} animate={{ rotate: 0, opacity: 1 }} transition={{ duration: 0.3 }}>
                            {isDark ? <Sun size={18} /> : <Moon size={18} />}
                        </motion.div>
                    </button>

                    {/* Cart Button */}
                    <button ref={cartBtn} onClick={toggleCart}
                        className="relative flex items-center gap-1.5 px-2.5 py-2 rounded-xl glass-button text-sm font-medium"
                        style={{ color: 'hsl(var(--foreground))' }}>
                        <ShoppingCart size={18} />
                        <span className="hidden sm:inline">Cart</span>
                        {(cartItems?.cart?.length || 0) > 0 && (
                            <span className="absolute -top-1.5 -right-1.5 text-[10px] font-bold min-w-[18px] min-h-[18px] flex items-center justify-center rounded-full shadow-md"
                                style={{ background: 'hsl(var(--primary))', color: 'hsl(var(--primary-foreground))' }}>
                                {cartItems?.cart?.length || 0}
                            </span>
                        )}
                    </button>

                    {/* Wishlist */}
                    <WishlistDropdown />

                    {/* Login button (desktop) */}
                    {!currentUser && (
                        <Link to="/login" className="hidden sm:block">
                            <button className="px-4 py-2 rounded-xl font-semibold text-sm transition-all glow-soft"
                                style={{
                                    background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))',
                                    color: 'hsl(var(--primary-foreground))',
                                }}>
                                Login / Sign Up
                            </button>
                        </Link>
                    )}

                    {/* Mobile hamburger */}
                    <button onClick={() => setMobileMenuOpen(true)}
                        className="md:hidden p-2 rounded-xl glass-button">
                        <Menu size={22} />
                    </button>
                </div>
            </nav>

            {/* Mobile Drawer */}
            <AnimatePresence>
                {mobileMenuOpen && (
                    <>
                        <motion.div
                            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                            className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[60]"
                            onClick={() => setMobileMenuOpen(false)} />

                        <motion.div
                            initial={{ x: '-100%' }} animate={{ x: 0 }} exit={{ x: '-100%' }}
                            transition={{ type: 'tween', ease: 'easeInOut', duration: 0.28 }}
                            className="fixed top-0 left-0 h-full w-72 z-[70] flex flex-col glass-panel-strong"
                            style={{ borderRadius: '0 28px 28px 0' }}>

                            {/* Drawer header */}
                            <div className="flex items-center justify-between p-5 border-b border-white/15">
                                <img src="/tortrose-logo.svg" alt="Tortrose" className="h-8" />
                                <button onClick={() => setMobileMenuOpen(false)}
                                    className="p-2 rounded-xl glass-button">
                                    <X size={20} />
                                </button>
                            </div>

                            {/* Nav links */}
                            <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
                                {navLinks.map(link => (
                                    <Link key={link.to} to={link.to} onClick={() => setMobileMenuOpen(false)}
                                        className="flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-white/10 transition-all font-medium">
                                        {link.icon}
                                        {link.label}
                                    </Link>
                                ))}

                                <div className="h-px bg-white/15 my-3" />

                                {currentUser
                                    ? <div className="px-2"><NavDropdown /></div>
                                    : (
                                        <Link to="/login" onClick={() => setMobileMenuOpen(false)}
                                            className="flex items-center gap-3 px-4 py-3 rounded-xl font-semibold"
                                            style={{
                                                background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))',
                                                color: 'white',
                                            }}>
                                            <LogIn size={18} /> Login / Sign Up
                                        </Link>
                                    )
                                }
                            </nav>
                        </motion.div>
                    </>
                )}
            </AnimatePresence>
        </>
    );
}

export default Navbar;
