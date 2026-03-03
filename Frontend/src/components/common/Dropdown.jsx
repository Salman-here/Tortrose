import React, { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronDown, Crown, LayoutDashboard, LogOut, LogOutIcon, User, Store } from "lucide-react";
import { useAuth } from "../../contexts/AuthContext";
import { useNavigate } from "react-router-dom";

const NavDropdown = () => {
    const { currentUser, logout } = useAuth();
    const [open, setOpen] = useState(false);
    const dropdownRef = useRef(null);

    // Close dropdown when clicking outside
    useEffect(() => {
        const handleClickOutside = (e) => {
            if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
                setOpen(false);
            }
        };
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, []);

    const navigate = useNavigate()
    
    // Build menu items based on user role
    const menuItems = [];
    
    // Add Admin Dashboard for admins
    if (currentUser?.role === 'admin') {
        menuItems.push({ 
            label: "Admin Dashboard", 
            icon: <Crown size={20} className="text-blue-500" />, 
            onClick: () => navigate('/admin-dashboard/store-overview'),
            highlight: true
        });
    }
    
    // Add Seller Dashboard for sellers
    if (currentUser?.role === 'seller') {
        menuItems.push({ 
            label: "Seller Dashboard", 
            icon: <Store size={20} className="text-green-500" />, 
            onClick: () => navigate('/seller-dashboard/store-overview'),
            highlight: true
        });
    }
    
    // Add User Dashboard for everyone
    menuItems.push({ 
        label: "Your Dashboard", 
        icon: <LayoutDashboard size={20} />, 
        onClick: () => navigate('/user-dashboard/account-overview') 
    });
    
    // Add "Become a Seller" option only for regular users (not sellers or admins)
    if (currentUser?.role === 'user') {
        menuItems.push({ 
            label: "Become a Seller", 
            icon: <Store size={20} />, 
            onClick: () => navigate('/become-seller') 
        });
    }
    
    menuItems.push(
        { divider: true },
        {
            label: (
                <span onClick={logout} className="flex items-center gap-2 w-full">
                    <LogOutIcon size={20} /> Logout
                </span>
            ),
        }
    );

    return (
        <div className="relative" ref={dropdownRef}>
            {/* Trigger */}
            <button
                onClick={() => setOpen(!open)}
                className="flex items-center gap-1 sm:gap-2 px-2 py-1.5 sm:px-3 sm:py-2 rounded-lg bg-white/10 hover:bg-white/20 transition-all text-xs sm:text-sm md:text-base"
            >
                {currentUser?.role === "admin" ? (
                    <Crown color="gold" className="w-4 h-4 sm:w-5 sm:h-5" />
                ) : currentUser?.role === "seller" ? (
                    <Crown color="#10b981" className="w-4 h-4 sm:w-5 sm:h-5" />
                ) : (
                    <User className="text-white w-4 h-4 sm:w-5 sm:h-5" />
                )}
                <span className="text-white font-semibold hidden sm:flex">{currentUser?.username}</span>
                <ChevronDown className="text-white w-3.5 h-3.5 sm:w-[18px] sm:h-[18px]" />
            </button>

            {/* Dropdown Menu */}
            <AnimatePresence>
                {open && (
                    <motion.div
                        initial={{ opacity: 0, y: -10, scale: 0.95 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: -10, scale: 0.95 }}
                        transition={{ duration: 0.2 }}
                        className="absolute right-0 mt-2 w-56 bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden z-50"
                    >
                        {menuItems.map((item, index) =>
                            item.divider ? (
                                <div
                                    key={index}
                                    className="border-t border-gray-200 my-1"
                                ></div>
                            ) : (
                                <button
                                    key={index}
                                    onClick={item.onClick}
                                    className={`w-full text-left px-4 py-2 flex items-center gap-2 transition-colors ${
                                        item.highlight 
                                            ? 'bg-linear-to-r from-indigo-50 to-sky-50 text-gray-800 hover:from-indigo-100 hover:to-sky-100 font-semibold'
                                            : 'text-gray-700 hover:bg-gray-100'
                                    }`}
                                >
                                    {item.icon} {item.label}
                                </button>
                            )
                        )}
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};

export default NavDropdown;
