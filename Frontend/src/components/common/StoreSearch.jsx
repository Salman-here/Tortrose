import { useState, useEffect, useRef } from 'react';
import { Search, Store, Loader2, ExternalLink } from 'lucide-react';
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
            if (searchRef.current && !searchRef.current.contains(event.target)) setIsOpen(false);
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    useEffect(() => {
        if (query.trim().length === 0) { setSuggestions([]); setIsOpen(false); return; }
        if (debounceTimer.current) clearTimeout(debounceTimer.current);
        debounceTimer.current = setTimeout(() => fetchSuggestions(query), 300);
        return () => { if (debounceTimer.current) clearTimeout(debounceTimer.current); };
    }, [query]);

    const fetchSuggestions = async (searchQuery) => {
        try {
            setLoading(true);
            const res = await axios.get(`${import.meta.env.VITE_API_URL}api/stores/suggestions?q=${searchQuery}`);
            setSuggestions(res.data.suggestions || []);
            setIsOpen(true);
        } catch (error) { setSuggestions([]); }
        finally { setLoading(false); }
    };

    const handleStoreClick = (storeSlug) => { navigate(`/store/${storeSlug}`); setQuery(''); setIsOpen(false); };

    const handleKeyDown = (e) => {
        if (!isOpen || suggestions.length === 0) return;
        switch (e.key) {
            case 'ArrowDown': e.preventDefault(); setSelectedIndex(prev => prev < suggestions.length - 1 ? prev + 1 : prev); break;
            case 'ArrowUp': e.preventDefault(); setSelectedIndex(prev => prev > 0 ? prev - 1 : -1); break;
            case 'Enter': e.preventDefault(); if (selectedIndex >= 0) handleStoreClick(suggestions[selectedIndex].storeSlug); break;
            case 'Escape': setIsOpen(false); setSelectedIndex(-1); break;
        }
    };

    return (
        <div ref={searchRef} className="relative w-full max-w-md">
            <div className="search-input-wrapper">
                <input type="text" value={query} onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={handleKeyDown} onFocus={() => query.trim().length > 0 && setIsOpen(true)}
                    placeholder="Search for stores..."
                    className="glass-input glass-input-search" />
                <div className="search-input-icon" style={{ left: '0.875rem', top: '50%', transform: 'translateY(-50%)' }}>
                    {loading ? <Loader2 size={20} className="animate-spin" /> : <Search size={20} />}
                </div>
            </div>

            <AnimatePresence>
                {isOpen && (suggestions.length > 0 || (query.trim().length > 0 && !loading)) && (
                    <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}
                        className="absolute top-full mt-2 w-full glass-panel-strong overflow-hidden z-50">
                        {suggestions.length > 0 ? (
                            <>
                                <div className="max-h-80 overflow-y-auto">
                                    {suggestions.map((store, index) => (
                                        <motion.div key={store._id} whileHover={{ backgroundColor: 'rgba(255,255,255,0.1)' }}
                                            onClick={() => handleStoreClick(store.storeSlug)}
                                            className={`flex items-center gap-3 p-3 cursor-pointer rounded-xl m-1 transition-colors ${index === selectedIndex ? 'bg-white/10' : ''}`}>
                                            {store.logo ? (
                                                <img src={store.logo} alt={store.storeName} className="w-10 h-10 rounded-full object-cover glass-inner" />
                                            ) : (
                                                <div className="w-10 h-10 rounded-full flex items-center justify-center"
                                                    style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))' }}>
                                                    <Store size={20} className="text-white" />
                                                </div>
                                            )}
                                            <div className="flex-1">
                                                <div className="font-medium flex items-center gap-1.5">
                                                    {store.storeName}
                                                    {store.verification?.isVerified && <VerifiedBadge size="sm" />}
                                                </div>
                                                <div className="flex items-center gap-2 text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                                    <span>/{store.storeSlug}</span><span>•</span>
                                                    <span>{store.trustCount || 0} trusters</span>
                                                </div>
                                            </div>
                                            <ExternalLink size={16} style={{ color: 'hsl(var(--muted-foreground))' }} />
                                        </motion.div>
                                    ))}
                                </div>
                                <div className="border-t border-white/15 p-2">
                                    <button onClick={() => { navigate('/stores'); setIsOpen(false); setQuery(''); }}
                                        className="w-full text-center text-sm py-2 rounded-xl hover:bg-white/10 transition-colors font-medium"
                                        style={{ color: 'hsl(var(--primary))' }}>View all stores →</button>
                                </div>
                            </>
                        ) : (
                            <div className="p-4 text-center">
                                <Store size={32} className="mx-auto mb-2" style={{ color: 'hsl(var(--muted-foreground))' }} />
                                <p className="text-sm">No stores found</p>
                                <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>Try a different search term</p>
                            </div>
                        )}
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};

export default StoreSearch;
