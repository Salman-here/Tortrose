import React, { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronDown, Crown, LayoutDashboard, LogOut, LogOutIcon, User, Store } from "lucide-react";
import { useAuth } from "../../contexts/AuthContext";
import { useNavigate } from "react-router-dom";

const NavDropdown = () => {
    const { currentUser, logout } = useAuth();
    const [open, setOpen] = useState(false);
    const dropdownRef = useRef(null);

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
    
    const menuItems = [];
    
    if (currentUser?.role === 'admin') {
        menuItems.push({ label: "Admin Dashboard", icon: <Crown size={20} className="text-amber-400" />, onClick: () => navigate('/admin-dashboard/store-overview'), highlight: true });
    }
    if (currentUser?.role === 'seller') {
        menuItems.push({ label: "Seller Dashboard", icon: <Store size={20} className="text-emerald-400" />, onClick: () => navigate('/seller-dashboard/store-overview'), highlight: true });
    }
    menuItems.push({ label: "Your Dashboard", icon: <LayoutDashboard size={20} />, onClick: () => navigate('/user-dashboard/account-overview') });
    if (currentUser?.role === 'user') {
        menuItems.push({ label: "Become a Seller", icon: <Store size={20} />, onClick: () => navigate('/become-seller') });
    }
    menuItems.push(
        { divider: true },
        { label: (<span onClick={logout} className="flex items-center gap-2 w-full"><LogOutIcon size={20} /> Logout</span>) }
    );

    return (
        <div className="relative" ref={dropdownRef}>
            <button onClick={() => setOpen(!open)}
                className="flex items-center gap-1 sm:gap-2 px-2 py-1.5 sm:px-3 sm:py-2 rounded-xl glass-button text-xs sm:text-sm md:text-base">
                {currentUser?.role === "admin" ? <Crown color="gold" className="w-4 h-4 sm:w-5 sm:h-5" />
                    : currentUser?.role === "seller" ? <Crown color="#10b981" className="w-4 h-4 sm:w-5 sm:h-5" />
                    : <User className="w-4 h-4 sm:w-5 sm:h-5" />}
                <span className="font-semibold hidden sm:flex">{currentUser?.username}</span>
                <ChevronDown className="w-3.5 h-3.5 sm:w-[18px] sm:h-[18px]" />
            </button>

            <AnimatePresence>
                {open && (
                    <motion.div
                        initial={{ opacity: 0, y: -10, scale: 0.95 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: -10, scale: 0.95 }}
                        transition={{ duration: 0.2 }}
                        className="absolute right-0 mt-2 w-56 glass-panel-strong overflow-hidden z-50 p-1"
                    >
                        {menuItems.map((item, index) =>
                            item.divider ? (
                                <div key={index} className="border-t border-white/15 my-1" />
                            ) : (
                                <button key={index} onClick={item.onClick}
                                    className={`w-full text-left px-4 py-2.5 flex items-center gap-2 rounded-xl transition-all text-sm ${
                                        item.highlight ? 'glass-inner font-semibold' : 'hover:bg-white/10'
                                    }`}>
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
