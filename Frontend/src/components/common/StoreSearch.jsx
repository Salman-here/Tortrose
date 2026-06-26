import { useState, useEffect, useRef, useCallback } from 'react';
import { Search, Store, Loader2, ExternalLink, Sparkles } from 'lucide-react';
import { motion as Motion, AnimatePresence } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import VerifiedBadge from './VerifiedBadge';
import { navigateToStore } from '../../utils/subdomainHelper';
import { useBuyerLocation } from '../../contexts/BuyerLocationContext';

const TypeBadge = ({ type }) => {
    const isBrand = type === 'brand';
    return (
        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md text-[9px] font-bold uppercase"
            style={{
                background: isBrand ? 'hsla(280, 70%, 55%, 0.15)' : 'hsla(220, 70%, 55%, 0.15)',
                color: isBrand ? 'hsl(280, 70%, 55%)' : 'hsl(220, 70%, 55%)',
            }}>
            {isBrand ? <Sparkles size={8} /> : <Store size={8} />}
            {isBrand ? 'Brand' : 'Store'}
        </span>
    );
};

const StoreSearch = () => {
    const [query, setQuery] = useState('');
    const [suggestions, setSuggestions] = useState([]);
    const [loading, setLoading] = useState(false);
    const [searchError, setSearchError] = useState(false);
    const [isOpen, setIsOpen] = useState(false);
    const [selectedIndex, setSelectedIndex] = useState(-1);
    const searchRef = useRef(null);
    const navigate = useNavigate();
    const { appendLocationParams, locationQueryString, detecting } = useBuyerLocation();
    const debounceTimer = useRef(null);
    const activeRequest = useRef(null);

    useEffect(() => {
        const handleClickOutside = (event) => {
            if (searchRef.current && !searchRef.current.contains(event.target)) setIsOpen(false);
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const fetchSuggestions = useCallback(async (searchQuery) => {
        activeRequest.current?.abort();
        const controller = new AbortController();
        activeRequest.current = controller;

        try {
            setLoading(true);
            setSearchError(false);
            const params = new URLSearchParams({ q: searchQuery.trim() });
            appendLocationParams(params);
            const res = await axios.get(
                `${import.meta.env.VITE_API_URL}api/stores/suggestions?${params.toString()}`,
                { signal: controller.signal }
            );
            if (activeRequest.current !== controller) return;
            setSuggestions(res.data.suggestions || []);
            setSelectedIndex(-1);
            setIsOpen(true);
        } catch (error) {
            if (error?.code === 'ERR_CANCELED' || controller.signal.aborted) return;
            if (activeRequest.current !== controller) return;
            setSuggestions([]);
            setSearchError(true);
            setIsOpen(true);
        } finally {
            if (activeRequest.current === controller) setLoading(false);
        }
    }, [appendLocationParams]);

    useEffect(() => {
        const normalizedQuery = query.trim();
        if (normalizedQuery.length === 0) {
            activeRequest.current?.abort();
            setSuggestions([]);
            setSearchError(false);
            setLoading(false);
            setIsOpen(false);
            setSelectedIndex(-1);
            return undefined;
        }

        if (detecting && !locationQueryString) {
            activeRequest.current?.abort();
            setLoading(true);
            return undefined;
        }

        if (debounceTimer.current) clearTimeout(debounceTimer.current);
        debounceTimer.current = setTimeout(() => fetchSuggestions(normalizedQuery), 300);
        return () => {
            if (debounceTimer.current) clearTimeout(debounceTimer.current);
        };
    }, [query, locationQueryString, detecting, fetchSuggestions]);

    useEffect(() => () => activeRequest.current?.abort(), []);

    const handleStoreClick = (storeSlug) => { setQuery(''); setIsOpen(false); navigateToStore(storeSlug, navigate); };

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
                    placeholder="Search stores & brands..."
                    className="glass-input glass-input-search" />
                <div className="search-input-icon" style={{ left: '0.875rem', top: '50%', transform: 'translateY(-50%)' }}>
                    {loading ? <Loader2 size={20} className="animate-spin" /> : <Search size={20} />}
                </div>
            </div>

            <AnimatePresence>
                {isOpen && (suggestions.length > 0 || (query.trim().length > 0 && !loading)) && (
                    <Motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}
                        className="absolute top-full mt-2 w-full glass-panel-strong overflow-hidden z-50">
                        {suggestions.length > 0 ? (
                            <>
                                <div className="max-h-80 overflow-y-auto">
                                    {suggestions.map((store, index) => (
                                        <Motion.div key={store._id} whileHover={{ backgroundColor: 'rgba(255,255,255,0.1)' }}
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
                                                <div className="font-medium flex items-center gap-1.5 flex-wrap">
                                                    {store.storeName}
                                                    {store.verification?.isVerified && <VerifiedBadge size="sm" />}
                                                    <TypeBadge type={store.sellerType} />
                                                </div>
                                                <div className="flex items-center gap-2 text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                                    <span>/{store.storeSlug}</span><span>•</span>
                                                    <span>{store.trustCount || 0} trusters</span>
                                                </div>
                                            </div>
                                            <ExternalLink size={16} style={{ color: 'hsl(var(--muted-foreground))' }} />
                                        </Motion.div>
                                    ))}
                                </div>
                                <div className="border-t border-white/15 p-2">
                                    <button onClick={() => { navigate('/marketplace'); setIsOpen(false); setQuery(''); }}
                                        className="w-full text-center text-sm py-2 rounded-xl hover:bg-white/10 transition-colors font-medium"
                                        style={{ color: 'hsl(var(--primary))' }}>View entire marketplace →</button>
                                </div>
                            </>
                        ) : searchError ? (
                            <div className="p-4 text-center">
                                <Store size={32} className="mx-auto mb-2" style={{ color: 'hsl(var(--muted-foreground))' }} />
                                <p className="text-sm">Store search is temporarily unavailable</p>
                                <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>Please try again in a moment</p>
                            </div>
                        ) : (
                            <div className="p-4 text-center">
                                <Store size={32} className="mx-auto mb-2" style={{ color: 'hsl(var(--muted-foreground))' }} />
                                <p className="text-sm">No stores or brands found</p>
                                <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>Try a different search term</p>
                            </div>
                        )}
                    </Motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};

export default StoreSearch;
