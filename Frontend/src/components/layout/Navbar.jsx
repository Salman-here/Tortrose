import React, { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../../contexts/AuthContext";
import { motion, AnimatePresence } from "framer-motion";
import NavDropdown from "../common/Dropdown";
import { ShoppingCart, Menu, X, Store, Home, LogIn } from "lucide-react";
import { useGlobal } from "../../contexts/GlobalContext";
import WishlistDropdown from "../common/Wishlist";

function Navbar() {
    const { currentUser } = useAuth();
    const { cartItems, toggleCart, dropdownRef, cartBtn, fetchCart } = useGlobal();
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
            <nav className={`transition-all duration-300 fixed top-0 left-0 w-full z-50 flex justify-between items-center
                px-4 sm:px-6 md:px-10 lg:px-14
                ${isScrolled
                    ? 'h-[60px] bg-indigo-950/80 backdrop-blur-xl shadow-lg shadow-indigo-950/30 border-b border-white/10'
                    : 'h-[70px] sm:h-[80px] bg-indigo-950/70 backdrop-blur-md border-b border-white/5'
                } text-white`}>

                {/* Left: Logo + Nav Links */}
                <div className="flex items-center gap-6">
                    <Link to="/" className="flex items-center gap-2 shrink-0">
                        <img src="/tortrose-logo.svg" alt="Tortrose" className="h-8 sm:h-9 md:h-10" />
                    </Link>
                    <div className="hidden md:flex items-center gap-1">
                        {navLinks.map(link => (
                            <Link key={link.to} to={link.to}
                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium text-white/80 hover:text-white hover:bg-white/10 transition-all duration-200">
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
                    {/* Cart Button */}
                    <button ref={cartBtn} onClick={toggleCart}
                        className="relative flex items-center gap-1.5 px-2.5 py-2 rounded-xl bg-white/10 hover:bg-white/20 transition-all duration-200 text-white">
                        <ShoppingCart size={20} />
                        <span className="hidden sm:inline text-sm font-medium">Cart</span>
                        {(cartItems?.cart?.length || 0) > 0 && (
                            <span className="absolute -top-1.5 -right-1.5 bg-indigo-500 text-white text-[10px] font-bold w-4.5 h-4.5 min-w-[18px] min-h-[18px] flex items-center justify-center rounded-full shadow-md">
                                {cartItems?.cart?.length || 0}
                            </span>
                        )}
                    </button>

                    {/* Wishlist */}
                    <WishlistDropdown />

                    {/* Login button (desktop) */}
                    {!currentUser && (
                        <Link to="/login" className="hidden sm:block">
                            <button className="bg-linear-to-r from-indigo-500 to-sky-400 hover:from-indigo-600 hover:to-sky-500
                                text-white px-4 py-2 rounded-xl font-semibold transition-all shadow-md shadow-sky-900/30 text-sm">
                                Login / Sign Up
                            </button>
                        </Link>
                    )}

                    {/* Mobile hamburger */}
                    <button onClick={() => setMobileMenuOpen(true)}
                        className="md:hidden p-2 rounded-xl bg-white/10 hover:bg-white/20 transition-all">
                        <Menu size={22} />
                    </button>
                </div>
            </nav>

            {/* Mobile Drawer */}
            <AnimatePresence>
                {mobileMenuOpen && (
                    <>
                        {/* Backdrop */}
                        <motion.div
                            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[60]"
                            onClick={() => setMobileMenuOpen(false)} />

                        {/* Drawer */}
                        <motion.div
                            initial={{ x: '-100%' }} animate={{ x: 0 }} exit={{ x: '-100%' }}
                            transition={{ type: 'tween', ease: 'easeInOut', duration: 0.28 }}
                            className="fixed top-0 left-0 h-full w-72 bg-indigo-950/90 backdrop-blur-xl z-[70] flex flex-col shadow-2xl shadow-indigo-950/50 border-r border-white/10">

                            {/* Drawer header */}
                            <div className="flex items-center justify-between p-5 border-b border-white/10">
                                <img src="/tortrose-logo.svg" alt="Tortrose" className="h-8" />
                                <button onClick={() => setMobileMenuOpen(false)}
                                    className="p-2 rounded-lg bg-white/10 hover:bg-white/20 text-white transition-all">
                                    <X size={20} />
                                </button>
                            </div>

                            {/* Nav links */}
                            <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
                                {navLinks.map(link => (
                                    <Link key={link.to} to={link.to} onClick={() => setMobileMenuOpen(false)}
                                        className="flex items-center gap-3 px-4 py-3 rounded-xl text-white/80 hover:text-white hover:bg-white/10 transition-all font-medium">
                                        {link.icon}
                                        {link.label}
                                    </Link>
                                ))}

                                {/* Divider */}
                                <div className="h-px bg-white/10 my-3" />

                                {currentUser
                                    ? <div className="px-2"><NavDropdown /></div>
                                    : (
                                        <Link to="/login" onClick={() => setMobileMenuOpen(false)}
                                            className="flex items-center gap-3 px-4 py-3 rounded-xl bg-linear-to-r from-indigo-500 to-sky-400 text-white font-semibold">
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
