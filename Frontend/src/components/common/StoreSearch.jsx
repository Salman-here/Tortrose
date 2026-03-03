import { useState, useEffect, useRef } from 'react';
import { Search, Store, Loader2, ExternalLink, Heart } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import VerifiedBadge from './VerifiedBadge';

const StoreSearch = () => {
    const [query, setQuery] = useState('');
    const [suggestions, setSuggestions] = useState([]);
    const [loading, setLoading] = useState(false);
    const [isOpen, setIsOpen] = useState(false);
    const [selectedIndex, setSelectedIndex] = useState(-1);
    const searchRef = useRef(null);
    const navigate = useNavigate();
    const debounceTimer = useRef(null);

    useEffect(() => {
        const handleClickOutside = (event) => {
            if (searchRef.current && !searchRef.current.contains(event.target)) {
                setIsOpen(false);
            }
        };

        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    useEffect(() => {
        if (query.trim().length === 0) {
            setSuggestions([]);
            setIsOpen(false);
            return;
        }

        // Debounce search
        if (debounceTimer.current) {
            clearTimeout(debounceTimer.current);
        }

        debounceTimer.current = setTimeout(() => {
            fetchSuggestions(query);
        }, 300);

        return () => {
            if (debounceTimer.current) {
                clearTimeout(debounceTimer.current);
            }
        };
    }, [query]);

    const fetchSuggestions = async (searchQuery) => {
        try {
            setLoading(true);
            const res = await axios.get(
                `${import.meta.env.VITE_API_URL}api/stores/suggestions?q=${searchQuery}`
            );
            setSuggestions(res.data.suggestions || []);
            setIsOpen(true);
        } catch (error) {
            console.error('Error fetching store suggestions:', error);
            setSuggestions([]);
        } finally {
            setLoading(false);
        }
    };

    const handleStoreClick = (storeSlug) => {
        navigate(`/store/${storeSlug}`);
        setQuery('');
        setIsOpen(false);
        setSuggestions([]);
    };

    const handleKeyDown = (e) => {
        if (!isOpen || suggestions.length === 0) return;

        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                setSelectedIndex(prev => 
                    prev < suggestions.length - 1 ? prev + 1 : prev
                );
                break;
            case 'ArrowUp':
                e.preventDefault();
                setSelectedIndex(prev => prev > 0 ? prev - 1 : -1);
                break;
            case 'Enter':
                e.preventDefault();
                if (selectedIndex >= 0 && selectedIndex < suggestions.length) {
                    handleStoreClick(suggestions[selectedIndex].storeSlug);
                }
                break;
            case 'Escape':
                setIsOpen(false);
                setSelectedIndex(-1);
                break;
            default:
                break;
        }
    };

    return (
        <div ref={searchRef} className="relative w-full max-w-md">
            <div className="relative">
                <input
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={handleKeyDown}
                    onFocus={() => query.trim().length > 0 && setIsOpen(true)}
                    placeholder="Search for stores..."
                    className="w-full pl-10 pr-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white shadow-sm"
                />
                <div className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400">
                    {loading ? (
                        <Loader2 size={20} className="animate-spin" />
                    ) : (
                        <Search size={20} />
                    )}
                </div>
            </div>

            {/* Suggestions Dropdown */}
            <AnimatePresence>
                {isOpen && (suggestions.length > 0 || (query.trim().length > 0 && !loading)) && (
                    <motion.div
                        initial={{ opacity: 0, y: -10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -10 }}
                        transition={{ duration: 0.2 }}
                        className="absolute top-full mt-2 w-full bg-white rounded-lg shadow-lg border border-gray-200 overflow-hidden z-50"
                    >
                        {suggestions.length > 0 ? (
                            <>
                                <div className="max-h-80 overflow-y-auto">
                                    {suggestions.map((store, index) => (
                                        <motion.div
                                            key={store._id}
                                            whileHover={{ backgroundColor: '#f3f4f6' }}
                                            onClick={() => handleStoreClick(store.storeSlug)}
                                            className={`flex items-center gap-3 p-3 cursor-pointer transition-colors ${
                                                index === selectedIndex ? 'bg-gray-100' : ''
                                            }`}
                                        >
                                            {store.logo ? (
                                                <img
                                                    src={store.logo}
                                                    alt={store.storeName}
                                                    className="w-10 h-10 rounded-full object-cover border border-gray-200"
                                                />
                                            ) : (
                                                <div className="w-10 h-10 rounded-full bg-linear-to-br from-indigo-500 to-sky-400 flex items-center justify-center">
                                                    <Store size={20} className="text-white" />
                                                </div>
                                            )}
                                            <div className="flex-1">
                                                <div className="font-medium text-gray-800 flex items-center gap-1.5">
                                                    {store.storeName}
                                                    {store.verification?.isVerified && (
                                                        <VerifiedBadge size="sm" />
                                                    )}
                                                </div>
                                                <div className="flex items-center gap-2 text-xs text-gray-500">
                                                    <span>/{store.storeSlug}</span>
                                                    <span>•</span>
                                                    <span>{store.trustCount || 0} {store.trustCount === 1 ? 'truster' : 'trusters'}</span>
                                                </div>
                                            </div>
                                            <ExternalLink size={16} className="text-gray-400" />
                                        </motion.div>
                                    ))}
                                </div>
                                <div className="border-t border-gray-200 p-2">
                                    <button
                                        onClick={() => {
                                            navigate('/stores');
                                            setIsOpen(false);
                                            setQuery('');
                                        }}
                                        className="w-full text-center text-sm text-blue-600 hover:text-blue-700 py-2 hover:bg-blue-50 rounded transition-colors"
                                    >
                                        View all stores →
                                    </button>
                                </div>
                            </>
                        ) : (
                            <div className="p-4 text-center text-gray-500">
                                <Store size={32} className="mx-auto mb-2 text-gray-300" />
                                <p className="text-sm">No stores found</p>
                                <p className="text-xs mt-1">Try a different search term</p>
                            </div>
                        )}
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};

export default StoreSearch;
