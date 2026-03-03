import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Store, Search, Home, ChevronRight, Sparkles, Heart } from 'lucide-react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import StoreCard from '../components/common/StoreCard';
import Loader from '../components/common/Loader';

const StoresListing = () => {
    const [stores, setStores] = useState([]);
    const [loading, setLoading] = useState(true);
    const [searchQuery, setSearchQuery] = useState('');
    const [sortBy, setSortBy] = useState('newest');

    useEffect(() => {
        fetchStores();
    }, [sortBy]);

    const fetchStores = async () => {
        try {
            setLoading(true);
            const res = await axios.get(
                `${import.meta.env.VITE_API_URL}api/stores/all?sort=${sortBy}`
            );
            setStores(res.data.stores);
        } catch (error) {
            console.error('Error fetching stores:', error);
        } finally {
            setLoading(false);
        }
    };

    const filteredStores = stores.filter(store =>
        store.storeName.toLowerCase().includes(searchQuery.toLowerCase())
    );

    return (
        <motion.div
            className="min-h-screen py-8"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5 }}
        >
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
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
                    <span className="font-medium" style={{ color: 'hsl(var(--foreground))' }}>All Stores</span>
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
                                <Store size={28} style={{ color: 'hsl(var(--primary))' }} />
                            </div>
                            <div>
                                <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight"
                                    style={{ color: 'hsl(var(--foreground))' }}>
                                    Discover Stores
                                </h1>
                                <p className="text-sm mt-0.5" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                    Explore amazing sellers and their unique products
                                </p>
                            </div>
                        </div>
                        <Link to="/stores/trusted">
                            <motion.button whileHover={{ y: -1 }} whileTap={{ scale: 0.97 }}
                                className="glass-button flex items-center gap-2 px-5 py-2.5 rounded-xl font-semibold text-sm">
                                <Heart size={16} style={{ color: 'hsl(0, 72%, 55%)' }} />
                                <span>My Trusted Stores</span>
                            </motion.button>
                        </Link>
                    </div>
                </motion.div>

                {/* Search and Sort Card */}
                <motion.div
                    className="glass-panel p-5 mb-8"
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.5, delay: 0.2 }}
                >
                    <div className="grid gap-3" style={{ gridTemplateColumns: '1fr 180px' }}>
                        <div className="search-input-wrapper">
                            <div className="search-input-icon" style={{ left: '0.875rem', top: '50%', transform: 'translateY(-50%)' }}>
                                <Search size={17} />
                            </div>
                            <input
                                type="text"
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                placeholder="Search for stores..."
                                className="glass-input glass-input-search"
                            />
                        </div>
                        <select
                            value={sortBy}
                            onChange={(e) => setSortBy(e.target.value)}
                            className="glass-input cursor-pointer font-medium"
                        >
                            <option value="newest">Newest First</option>
                            <option value="views">Most Viewed</option>
                            <option value="name">Name (A-Z)</option>
                        </select>
                    </div>
                </motion.div>

                {/* Stores Grid */}
                {loading ? (
                    <div className="flex justify-center items-center h-64">
                        <Loader text="Loading stores..." />
                    </div>
                ) : filteredStores.length === 0 ? (
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
                            {searchQuery ? 'No stores found' : 'No stores available yet'}
                        </p>
                        <p className="text-sm mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                            {searchQuery ? 'Try a different search term' : 'Check back later for new stores'}
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
                                Showing <span className="font-bold" style={{ color: 'hsl(var(--foreground))' }}>{filteredStores.length}</span> {filteredStores.length === 1 ? 'store' : 'stores'}
                            </p>
                            <div className="flex items-center gap-1.5 text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                <Sparkles size={15} style={{ color: 'hsl(var(--primary))' }} />
                                <span>Find your favorite seller</span>
                            </div>
                        </div>
                        <div className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4 md:gap-5">
                            {filteredStores.map((store, idx) => (
                                <StoreCard key={store._id} store={store} idx={idx} />
                            ))}
                        </div>
                    </motion.div>
                )}
            </div>
        </motion.div>
    );
};

export default StoresListing;
