import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../../contexts/AuthContext";
import { motion } from "framer-motion";
import NavDropdown from "../common/Dropdown";
import { ShoppingCart, Heart } from "lucide-react";
import { useGlobal } from "../../contexts/GlobalContext";
import WishlistDropdown from "../common/Wishlist";
import CartDropdown from "../common/CartDropdown";

function Navbar() {
    const { currentUser } = useAuth();
    const cartCount = 3; // Replace with state
    const wishlistCount = 2; // Replace with state

    const {
        isWishlistOpen,
        setIsWishlistOpen,
        cartItems,
        isOpen,
        setIsOpen,
        toggleCart,
        dropdownRef,
        cartBtn,
        fetchCart
    } = useGlobal()



    const [isScrolled, setIsScrolled] = useState(false)



    useEffect(() => {
        const scroll = () => {
            setIsScrolled(window.scrollY >= 20)
        }
        window.addEventListener('scroll', scroll)
        fetchCart()
        
        return () => {
            window.removeEventListener('scroll', scroll)
        }
    }, [])


    return (
        <nav className={`transition-all duration-200 fixed top-0 left-0 w-full z-50 flex justify-between items-center 
            ${isScrolled ? 'h-[60px] bg-gradient-to-r from-slate-900 via-slate-800 to-slate-900' : 'h-[70px] sm:h-[80px] bg-gradient-to-r from-gray-700 via-gray-800 to-gray-500'}
      text-white shadow-lg px-2 sm:px-4 md:px-8 lg:px-12 border-b border-white/10`}>

            {/* Left: Logo & Stores Link */}
            <div className="flex items-center gap-2 sm:gap-4 md:gap-6">
                <Link to="/" className="group">
                    <span className="font-bold text-base sm:text-lg md:text-xl lg:text-2xl bg-gradient-to-r from-sky-400 to-blue-500 bg-clip-text text-transparent tracking-wide group-hover:from-sky-300 group-hover:to-blue-400 transition-all duration-300">
                        genZ Winners
                    </span>
                </Link>
                <Link to="/stores" className="hidden md:block text-white/90 hover:text-white font-medium transition-colors text-sm lg:text-base">
                    Stores
                </Link>
            </div>

            {/* Center: User Dropdown (only if logged in) */}
            <div className="flex justify-center">
                {currentUser && (
                    <NavDropdown />
                )}
            </div>

            {/* Right: Cart & Wishlist OR Login/Signup */}
            <div className="flex justify-end gap-2 sm:gap-3 md:gap-4 items-center">
                <>
                    {/* Cart */}
                    <button
                        ref={cartBtn}
                        onClick={toggleCart} className="button flex gap-1 sm:gap-2 p-1.5 sm:p-2 relative hover:bg-gray-100 rounded-full text-sm sm:text-base">

                        <ShoppingCart size={20} className="sm:w-6 sm:h-6" />
                        <span className="hidden sm:inline">
                            Cart
                        </span>
                        <span className="absolute -top-1 -right-1 bg-red-600 text-white text-xs w-4 h-4 sm:w-5 sm:h-5 flex items-center justify-center rounded-full">
                            {cartItems?.cart?.length || 0}
                        </span>
                    </button>

                    {/* Wishlist */}
                    <WishlistDropdown />

                </>
                {!currentUser && (
                    <Link to="/login">
                        <button className="w-max bg-gradient-to-r from-indigo-500 to-purple-500 
              hover:from-indigo-600 hover:to-purple-600 
              text-white px-2 py-1.5 sm:px-4 sm:py-2 rounded-lg font-semibold 
              transition-all shadow-md text-xs sm:text-sm md:text-base">
                            <span className="hidden sm:inline">Login / SignUp</span>
                            <span className="sm:hidden">Login</span>
                        </button>
                    </Link>
                )}
            </div>
        </nav>
    );
}

export default Navbar;
