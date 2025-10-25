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
        <nav className={`transition-all duration-200 fixed top-0 left-0 w-full z-5 flex justify-between items-center 
            ${isScrolled ? 'h-[60px] bg-gradient-to-r from-slate-900 via-slate-800 to-slate-900' : 'h-[80px] bg-gradient-to-r from-gray-700 via-gray-800 to-gray-500'}
      text-white shadow-lg px-3 md:px-8 lg:px-12 border-b border-white/10`}>

            {/* Left: Logo */}
            <Link to="/" className="group">
                <span className="font-bold text-lg md:text-xl lg:text-2xl bg-gradient-to-r from-sky-400 to-blue-500 bg-clip-text text-transparent tracking-wide group-hover:from-sky-300 group-hover:to-blue-400 transition-all duration-300">
                    genZ Winners
                </span>
            </Link>

            {/* Center: Admin Dashboard + Dropdown (only if logged in) */}
            <div className="flex justify-center">
                {currentUser && (

                    <div className="flex gap-4 items-center">
                        {
                            currentUser.role == 'admin' && (
                                <Link to={'/admin-dashboard/store-overview'}>
                                    <motion.button

                                        initial={{ scale: 1 }}
                                        whileHover={{ scale: 1.05 }}
                                        whileTap={{ scale: 0.9 }}
                                        transition={{ duration: 0.3 }}
                                        className="rounded bg-sky-800 px-3 py-2 font-semibold cursor-pointer"
                                    >
                                        Admin Dashboard
                                    </motion.button>
                                </Link>

                            )
                        }
                        <NavDropdown />
                    </div>
                )}
            </div>

            {/* Right: Cart & Wishlist OR Login/Signup */}
            <div className="flex justify-end gap-4 items-center">
                <>
                    {/* Cart */}
                    <button
                        ref={cartBtn}
                        onClick={toggleCart} className="button flex gap-2 p-2 relative hover:bg-gray-100 rounded-full">

                        <ShoppingCart size={24} />
                        <span>
                            Cart
                        </span>
                        <span className="absolute -top-1 -right-1 bg-red-600 text-white text-xs w-5 h-5 flex items-center justify-center rounded-full">
                            {cartItems?.cart?.length || 0}
                        </span>
                    </button>

                    {/* Wishlist */}
                    <WishlistDropdown />

                </>
                {!currentUser && (
                    <Link to="/auth">
                        <button className="w-max bg-gradient-to-r from-indigo-500 to-purple-500 
              hover:from-indigo-600 hover:to-purple-600 
              text-white px-4 py-2 rounded-lg font-semibold 
              transition-all shadow-md">
                            Login / SignUp
                        </button>
                    </Link>
                )}
            </div>
        </nav>
    );
}

export default Navbar;
