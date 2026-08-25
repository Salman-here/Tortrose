import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Heart, Trash2 } from 'lucide-react';
import { useGlobal } from '../../contexts/GlobalContext';
import { resolveProductPresentationMoney, useCurrency } from '../../contexts/CurrencyContext';

export default function WishlistDropdown() {
    const { wishlistItems, handleDeleteFromWishlist } = useGlobal();
    const { formatProductPrice } = useCurrency();
    const [isOpen, setIsOpen] = useState(false);
    const triggerRef = useRef(null);
    const menuRef = useRef(null);
    const [pos, setPos] = useState({ top: 0, right: 0 });

    const updatePosition = useCallback(() => {
        if (triggerRef.current) {
            const rect = triggerRef.current.getBoundingClientRect();
            setPos({
                top: rect.bottom + 8,
                right: window.innerWidth - rect.right,
            });
        }
    }, []);

    useEffect(() => {
        const handleClickOutside = (event) => {
            const clickedTrigger = triggerRef.current?.contains(event.target);
            const clickedMenu = menuRef.current?.contains(event.target);
            if (!clickedTrigger && !clickedMenu) setIsOpen(false);
        };

        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    useEffect(() => {
        if (isOpen) {
            updatePosition();
            window.addEventListener('scroll', updatePosition, true);
            window.addEventListener('resize', updatePosition);
            return () => {
                window.removeEventListener('scroll', updatePosition, true);
                window.removeEventListener('resize', updatePosition);
            };
        }
    }, [isOpen, updatePosition]);

    const dropdownMenu = (
        <AnimatePresence>
            {isOpen && (
                <motion.div
                    ref={menuRef}
                    initial={{ opacity: 0, y: -10, scale: 0.95 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -10, scale: 0.95 }}
                    transition={{ duration: 0.3 }}
                    className="fixed z-[100] mt-2 w-64 sm:w-72 max-w-[90vw] glass-panel-strong overflow-hidden"
                    style={{ top: pos.top, right: pos.right }}
                >
                    <div className="p-3 sm:p-4 border-b border-white/15 font-semibold text-sm sm:text-base">
                        My Wishlist
                    </div>
                    <div className="max-h-56 sm:max-h-64 overflow-y-auto">
                        {wishlistItems.length === 0 ? (
                            <p className='ml-4 p-2 text-sm' style={{ color: 'hsl(var(--muted-foreground))' }}>No items added yet</p>
                        ) : wishlistItems.map((item) => (
                            <div key={item.id} className="relative flex items-center gap-3 p-2 sm:p-3 hover:bg-white/10 transition rounded-xl m-1">
                                <img src={item.image} alt={item.name} className="w-10 h-10 sm:w-12 sm:h-12 rounded-xl object-cover glass-inner" />
                                <div className="flex-1">
                                    <p className="text-xs sm:text-sm font-medium mr-3">{item.name}</p>
                                    <p className="font-semibold text-base" style={{ color: 'hsl(var(--primary))' }}>
                                        {formatProductPrice(item, {
                                            field: resolveProductPresentationMoney(item, 'discountedPrice') > 0
                                                && resolveProductPresentationMoney(item, 'discountedPrice') < resolveProductPresentationMoney(item, 'price')
                                                ? 'discountedPrice'
                                                : 'price',
                                        })}
                                    </p>
                                    <motion.button whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.9 }}
                                        className='absolute cursor-pointer top-2 right-2 p-1 rounded-lg glass-button'
                                        onClick={() => handleDeleteFromWishlist(item._id)}>
                                        <Trash2 size={16} />
                                    </motion.button>
                                </div>
                            </div>
                        ))}
                    </div>
                </motion.div>
            )}
        </AnimatePresence>
    );

    return (
        <>
            <div className="relative inline-block text-left">
                <button
                    ref={triggerRef}
                    onClick={() => setIsOpen(!isOpen)}
                    className="flex items-center gap-1.5 px-2 sm:px-2.5 py-1.5 sm:py-2 rounded-xl glass-button text-sm font-medium relative"
                >
                    <Heart className="w-4 h-4 sm:w-5 sm:h-5" style={{ color: 'hsl(340, 65%, 65%)' }} />
                    <span className='hidden sm:flex'>Wishlist</span>
                    <span
                        className="absolute -top-1 -right-1 text-[10px] sm:text-xs font-bold px-1.5 py-[1px] rounded-full shadow-sm"
                        style={{ background: 'hsl(340, 65%, 65%)', color: 'white' }}
                    >
                        {wishlistItems.length}
                    </span>
                </button>
            </div>
            {createPortal(dropdownMenu, document.body)}
        </>
    );
}

