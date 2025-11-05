import React, { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronDown, Crown, LayoutDashboard, LogOut, LogOutIcon, User } from "lucide-react";
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
    const menuItems = [
        // { label: "Your Profile", icon: <User size={20} />, onClick: () => navigate('/profile') },
        { label: "Your Dashboard", icon: <LayoutDashboard size={20} />, onClick: () => navigate('/user-dashboard/account-overview') },
        { divider: true },
        {
            label: (
                <span onClick={logout} className="flex items-center gap-2 w-full">
                    <LogOutIcon size={20} /> Logout
                </span>
            ),
        },
    ];

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
                                    className="w-full text-left px-4 py-2 text-gray-700 hover:bg-gray-100 flex items-center gap-2 transition-colors"
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
