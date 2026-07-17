import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Store, Search, Home, ChevronRight, ChevronLeft, Sparkles, Heart, ChevronDown, Check, ShoppingBag, Layers } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import axios from 'axios';
import StoreCard from '../components/common/StoreCard';
import Loader from '../components/common/Loader';
import SEOHead from '../components/common/SEOHead';
import BuyerLocationSelector from '../components/common/BuyerLocationSelector';
import { useBuyerLocation } from '../contexts/BuyerLocationContext';

const STORES_PER_PAGE = 12;

const StoresListing = () => {
    const [searchParams, setSearchParams] = useSearchParams();
    const initialType = ['brand', 'store', 'all'].includes(searchParams.get('type')) ? searchParams.get('type') : 'all';
    const [stores, setStores] = useState([]);
    const [loading, setLoading] = useState(true);
    const [searchQuery, setSearchQuery] = useState('');
    const [debouncedSearch, setDebouncedSearch] = useState('');
    const [sortBy, setSortBy] = useState('newest');
    const [typeFilter, setTypeFilter] = useState(initialType); // all | brand | store
    const [sortOpen, setSortOpen] = useState(false);
    const [currentPage, setCurrentPage] = useState(1);
    const [totalPages, setTotalPages] = useState(1);
    const [totalStores, setTotalStores] = useState(0);
    const [storeCounts, setStoreCounts] = useState({ all: 0, brand: 0, store: 0 });
    const sortRef = useRef(null);
    const { appendLocationParams, locationQueryString } = useBuyerLocation();

    // Sync typeFilter -> URL
    useEffect(() => {
        const params = new URLSearchParams(searchParams);
        if (typeFilter === 'all') params.delete('type');
        else params.set('type', typeFilter);
        setSearchParams(params, { replace: true });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [typeFilter]);

    useEffect(() => {
        const timer = setTimeout(() => {
            setDebouncedSearch(searchQuery.trim());
            setCurrentPage(1);
        }, 300);
        return () => clearTimeout(timer);
    }, [searchQuery]);

    // SEO meta varies per type
    const seoMeta = typeFilter === 'brand'
        ? {
            title: 'Brands on Rozare - Fashion, Tech & Lifestyle Brands',
            description: 'Discover brand storefronts on Rozare. Shop from fashion, beauty, electronics, lifestyle, and seller-run brands with reviews and trust signals.',
            canonical: '/marketplace?type=brand',
            keywords: 'brands, brand storefronts, fashion brands, beauty brands, tech brands, lifestyle brands, rozare brands',
            heading: 'Brands',
            subheading: 'Shop from brands and seller-run storefronts',
        }
        : typeFilter === 'store'
        ? {
            title: 'Stores on Rozare - Independent Sellers & Local Shops',
            description: 'Browse independent stores and local sellers on Rozare. Discover products from seller-run storefronts with reviews, trust signals, and store details.',
            canonical: '/marketplace?type=store',
            keywords: 'stores, independent sellers, online stores, local shops, small business, rozare stores',
            heading: 'Stores',
            subheading: 'Discover independent seller storefronts',
        }
        : {
            title: 'Marketplace - Discover Stores & Brands',
            description: 'Discover stores and brands on Rozare Marketplace. Browse independent sellers, fashion brands, electronics shops, beauty boutiques, and more in one place.',
            canonical: '/marketplace',
            keywords: 'marketplace, online stores, brands, trusted stores, independent shops, fashion brands, electronics stores, rozare marketplace',
            heading: 'Marketplace',
            subheading: 'Discover stores and brands from Rozare sellers',
        };


    const buttonRef = useRef(null);
    const [dropdownPos, setDropdownPos] = useState({ top: 0, left: 0 });

    const sortOptions = [
        { value: 'newest', label: 'Newest First' },
        { value: 'rating', label: 'Highest Rated' },
        { value: 'views', label: 'Most Viewed' },
        { value: 'name', label: 'Name (A-Z)' },
    ];

    const toggleSort = () => {
        if (!sortOpen && buttonRef.current) {
            const rect = buttonRef.current.getBoundingClientRect();
            setDropdownPos({ top: rect.bottom + 6, left: rect.right - 170 });
        }
        setSortOpen(prev => !prev);
    };

    // Close dropdown on outside click
    useEffect(() => {
        const handleClick = (e) => {
            if (sortRef.current && !sortRef.current.contains(e.target)) setSortOpen(false);
        };
        document.addEventListener('mousedown', handleClick);
        return () => document.removeEventListener('mousedown', handleClick);
    }, []);

    useEffect(() => {
        setCurrentPage(1);
    }, [sortBy, typeFilter]);

    useEffect(() => {
        fetchStores();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sortBy, typeFilter, currentPage, debouncedSearch, locationQueryString]);

    const fetchStores = async () => {
        try {
            setLoading(true);
            const params = new URLSearchParams({
                sort: sortBy,
                page: String(currentPage),
                limit: String(STORES_PER_PAGE),
            });
            if (typeFilter !== 'all') params.set('type', typeFilter);
            if (debouncedSearch) params.set('search', debouncedSearch);
            appendLocationParams(params);
            const res = await axios.get(
                `${import.meta.env.VITE_API_URL}api/stores/all?${params.toString()}`
            );
            setStores(res.data.stores || []);
            setStoreCounts(res.data.counts || { all: 0, brand: 0, store: 0 });
            setTotalStores(res.data.pagination?.total || 0);
            setTotalPages(Math.max(1, res.data.pagination?.pages || 1));
        } catch (error) {
            console.error('Error fetching stores:', error);
            setStores([]);
            setTotalStores(0);
            setTotalPages(1);
        } finally {
            setLoading(false);
        }
    };

    const goToPage = (page) => {
        const nextPage = Math.min(totalPages, Math.max(1, page));
        setCurrentPage(nextPage);
        window.scrollTo({ top: 0, behavior: 'smooth' });
    };

    const pageNumbers = (() => {
        const pages = [];
        const maxVisible = 5;
        let start = Math.max(1, currentPage - Math.floor(maxVisible / 2));
        let end = Math.min(totalPages, start + maxVisible - 1);
        if (end - start + 1 < maxVisible) start = Math.max(1, end - maxVisible + 1);
        for (let i = start; i <= end; i++) pages.push(i);
        return pages;
    })();

    const tabs = [
        { key: 'all', label: 'All', icon: Layers },
        { key: 'brand', label: 'Brands', icon: Sparkles },
        { key: 'store', label: 'Stores', icon: Store },
    ];

    return (
        <motion.div
            className="min-h-screen py-8"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5 }}
        >
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                <SEOHead
                    title={seoMeta.title}
                    description={seoMeta.description}
                    canonical={seoMeta.canonical}
                    keywords={seoMeta.keywords}
                    jsonLd={{
                        '@context': 'https://schema.org',
                        '@type': 'CollectionPage',
                        name: seoMeta.title,
                        description: seoMeta.description,
                        url: `https://rozare.com${seoMeta.canonical}`,
                        isPartOf: { '@type': 'WebSite', name: 'Rozare', url: 'https://rozare.com' },
                    }}
                />
                {/* Breadcrumb */}
                <motion.div
                    className="flex items-center text-sm mb-6"
                    style={{ color: 'hsl(var(--muted-foreground))' }}
                    initial={{ opacity: 0, y: -10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.3 }}
                >
                    <Link to="/" className="flex items-center gap-1 transition-colors hover:text-[hsl(220,70%,55%)]">
                        <Home size={15} />
                        <span>Home</span>
                    </Link>
                    <ChevronRight size={14} className="mx-1.5 opacity-50" />
                    <span className="font-medium" style={{ color: 'hsl(var(--foreground))' }}>{seoMeta.heading}</span>
                </motion.div>

                {/* Hero Header — Glass Panel */}
                <motion.div
                    className="glass-panel-strong water-shimmer relative overflow-hidden mb-8 p-6 md:p-8"
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.5, delay: 0.1 }}
                >
                    {/* Decorative orbs */}
                    <div className="absolute -top-10 -right-10 w-40 h-40 rounded-full opacity-30 blur-3xl"
                         style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))' }} />
                    <div className="absolute -bottom-10 -left-10 w-32 h-32 rounded-full opacity-20 blur-3xl"
                         style={{ background: 'linear-gradient(135deg, hsl(200, 80%, 55%), hsl(170, 70%, 45%))' }} />

                    <div className="relative flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                        <div className="flex items-center gap-4">
                            <div className="glass-inner p-3 rounded-2xl">
                                <ShoppingBag size={28} style={{ color: 'hsl(var(--primary))' }} />
                            </div>
                            <div>
                                <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight"
                                    style={{ color: 'hsl(var(--foreground))' }}>
                                    {seoMeta.heading}
                                </h1>
                                <p className="text-sm mt-0.5" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                    {seoMeta.subheading}
                                </p>
                            </div>
                        </div>
                        <Link to="/marketplace/trusted">
                            <motion.button whileHover={{ y: -1 }} whileTap={{ scale: 0.97 }}
                                className="glass-button flex items-center gap-2 px-5 py-2.5 rounded-xl font-semibold text-sm">
                                <Heart size={16} style={{ color: 'hsl(0, 72%, 55%)' }} />
                                <span>My Trusted</span>
                            </motion.button>
                        </Link>
                    </div>
                </motion.div>

                {/* Type Tabs */}
                <motion.div
                    className="glass-panel p-2 mb-4 inline-flex gap-1 max-w-full overflow-x-auto"
                    style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.4, delay: 0.15 }}
                >
                    <style>{`
                        .glass-panel::-webkit-scrollbar { display: none; }
                    `}</style>
                    {tabs.map(tab => {
                        const Icon = tab.icon;
                        const active = typeFilter === tab.key;
                        const count = storeCounts[tab.key] || 0;
                        return (
                            <button
                                key={tab.key}
                                onClick={() => setTypeFilter(tab.key)}
                                className="flex items-center gap-2 px-3 sm:px-4 py-2 rounded-xl text-sm font-semibold transition-all whitespace-nowrap"
                                style={{
                                    background: active ? 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))' : 'transparent',
                                    color: active ? 'white' : 'hsl(var(--foreground))',
                                }}
                            >
                                <Icon size={15} />
                                <span>{tab.label}</span>
                                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full"
                                    style={{ background: active ? 'rgba(255,255,255,0.25)' : 'hsla(220,70%,55%,0.12)', color: active ? 'white' : 'hsl(220,70%,55%)' }}>
                                    {count}
                                </span>
                            </button>
                        );
                    })}
                </motion.div>

                {/* Search and Sort Card */}
                <motion.div
                    className="glass-panel p-3 sm:p-5 mb-8"
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.5, delay: 0.2 }}
                >
                    <BuyerLocationSelector compact />
                    <div className="flex flex-col sm:grid gap-3 sm:gap-3 mt-3" style={{ gridTemplateColumns: '1fr auto' }}>
                        <div className="search-input-wrapper">
                            <div className="search-input-icon" style={{ left: '0.875rem', top: '50%', transform: 'translateY(-50%)' }}>
                                <Search size={17} />
                            </div>
                            <input
                                type="text"
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                placeholder="Search stores or brands..."
                                className="glass-input glass-input-search"
                            />
                        </div>
                        <div ref={sortRef} className="w-full sm:w-auto">
                            <motion.button
                                ref={buttonRef}
                                whileTap={{ scale: 0.97 }}
                                onClick={toggleSort}
                                className="glass-inner flex items-center justify-between gap-2 px-4 py-2.5 rounded-xl cursor-pointer font-medium text-sm w-full sm:min-w-[170px]"
                                style={{ color: 'hsl(var(--foreground))' }}
                            >
                                <span>{sortOptions.find(o => o.value === sortBy)?.label}</span>
                                <ChevronDown size={16} style={{ color: 'hsl(var(--muted-foreground))', transform: sortOpen ? 'rotate(180deg)' : 'rotate(0)', transition: 'transform 0.2s ease' }} />
                            </motion.button>
                            {createPortal(
                                <AnimatePresence>
                                    {sortOpen && (
                                        <motion.div
                                            initial={{ opacity: 0, y: -6, scale: 0.97 }}
                                            animate={{ opacity: 1, y: 0, scale: 1 }}
                                            exit={{ opacity: 0, y: -6, scale: 0.97 }}
                                            transition={{ duration: 0.18 }}
                                            className="glass-panel-strong p-1.5 rounded-xl"
                                            style={{
                                                position: 'fixed',
                                                top: dropdownPos.top,
                                                left: dropdownPos.left,
                                                zIndex: 99999,
                                                minWidth: 170,
                                                boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
                                            }}
                                        >
                                            {sortOptions.map(opt => (
                                                <button
                                                    key={opt.value}
                                                    onClick={() => { setSortBy(opt.value); setSortOpen(false); }}
                                                    className="flex items-center justify-between w-full px-3.5 py-2.5 rounded-lg text-sm font-medium transition-all duration-150"
                                                    style={{
                                                        color: sortBy === opt.value ? 'hsl(220, 70%, 55%)' : 'hsl(var(--foreground))',
                                                        background: sortBy === opt.value ? 'hsla(220, 70%, 55%, 0.08)' : 'transparent',
                                                    }}
                                                    onMouseEnter={e => { if (sortBy !== opt.value) e.currentTarget.style.background = 'hsla(220, 70%, 55%, 0.08)'; }}
                                                    onMouseLeave={e => { e.currentTarget.style.background = sortBy === opt.value ? 'hsla(220, 70%, 55%, 0.08)' : 'transparent'; }}
                                                >
                                                    <span>{opt.label}</span>
                                                    {sortBy === opt.value && <Check size={15} style={{ color: 'hsl(220, 70%, 55%)' }} />}
                                                </button>
                                            ))}
                                        </motion.div>
                                    )}
                                </AnimatePresence>,
                                document.body
                            )}
                        </div>
                    </div>
                </motion.div>

                {/* Stores Grid */}
                {loading ? (
                    <div className="flex justify-center items-center h-64">
                        <Loader text="Loading stores..." />
                    </div>
                ) : stores.length === 0 ? (
                    <motion.div
                        className="flex flex-col items-center justify-center h-64 glass-panel"
                        initial={{ opacity: 0, scale: 0.95 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ duration: 0.4 }}
                    >
                        <div className="glass-inner p-5 rounded-2xl mb-4">
                            <Store size={40} style={{ color: 'hsl(var(--muted-foreground))' }} />
                        </div>
                        <p className="text-base font-semibold" style={{ color: 'hsl(var(--foreground))' }}>
                            {debouncedSearch ? 'No stores found' : 'No stores available yet'}
                        </p>
                        <p className="text-sm mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                            {debouncedSearch ? 'Try a different search term' : 'Check back later for new stores'}
                        </p>
                    </motion.div>
                ) : (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ duration: 0.5, delay: 0.3 }}
                    >
                        <div className="flex items-center justify-between mb-5">
                            <p className="text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                Showing <span className="font-bold" style={{ color: 'hsl(var(--foreground))' }}>{stores.length}</span> of <span className="font-bold" style={{ color: 'hsl(var(--foreground))' }}>{totalStores}</span> {totalStores === 1 ? 'store' : 'stores'}
                            </p>
                            <div className="flex items-center gap-1.5 text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                <Sparkles size={15} style={{ color: 'hsl(var(--primary))' }} />
                                <span>Find your favorite seller</span>
                            </div>
                        </div>
                        <div className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4 md:gap-5">
                            {stores.map((store, idx) => (
                                <StoreCard key={store._id} store={store} idx={idx} />
                            ))}
                        </div>
                        {totalPages > 1 && (
                            <div className="flex items-center justify-center gap-2 mt-10 mb-6 flex-wrap">
                                <button
                                    onClick={() => goToPage(currentPage - 1)}
                                    disabled={currentPage === 1}
                                    className="p-2 rounded-xl glass-button disabled:opacity-30 disabled:cursor-not-allowed transition-transform active:scale-90 hover:scale-105"
                                >
                                    <ChevronLeft size={18} />
                                </button>

                                {pageNumbers[0] > 1 && (
                                    <>
                                        <button onClick={() => goToPage(1)} className="w-10 h-10 rounded-xl glass-button text-sm font-semibold transition-transform active:scale-90 hover:scale-105">1</button>
                                        {pageNumbers[0] > 2 && <span className="px-1" style={{ color: 'hsl(var(--muted-foreground))' }}>...</span>}
                                    </>
                                )}

                                {pageNumbers.map(page => (
                                    <button
                                        key={page}
                                        onClick={() => goToPage(page)}
                                        className={`w-10 h-10 rounded-xl text-sm font-semibold transition-transform active:scale-90 hover:scale-105 ${
                                            page === currentPage ? 'glow-soft text-white' : 'glass-button'
                                        }`}
                                        style={page === currentPage ? {
                                            background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))',
                                        } : {}}
                                    >
                                        {page}
                                    </button>
                                ))}

                                {pageNumbers[pageNumbers.length - 1] < totalPages && (
                                    <>
                                        {pageNumbers[pageNumbers.length - 1] < totalPages - 1 && <span className="px-1" style={{ color: 'hsl(var(--muted-foreground))' }}>...</span>}
                                        <button onClick={() => goToPage(totalPages)} className="w-10 h-10 rounded-xl glass-button text-sm font-semibold transition-transform active:scale-90 hover:scale-105">{totalPages}</button>
                                    </>
                                )}

                                <button
                                    onClick={() => goToPage(currentPage + 1)}
                                    disabled={currentPage === totalPages}
                                    className="p-2 rounded-xl glass-button disabled:opacity-30 disabled:cursor-not-allowed transition-transform active:scale-90 hover:scale-105"
                                >
                                    <ChevronRight size={18} />
                                </button>

                                <span className="ml-3 text-xs font-medium" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                    Page {currentPage} of {totalPages}
                                </span>
                            </div>
                        )}
                    </motion.div>
                )}
            </div>
        </motion.div>
    );
};

export default StoresListing;
