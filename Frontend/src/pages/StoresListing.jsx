import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Store, Search, Loader2, Home, ChevronRight, Sparkles } from 'lucide-react';
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
                    className="flex items-center text-sm text-slate-500 mb-6"
                    initial={{ opacity: 0, y: -10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.3 }}
                >
                    <Link to="/" className="hover:text-indigo-600 flex items-center gap-1 transition-colors">
                        <Home size={15} />
                        <span>Home</span>
                    </Link>
                    <ChevronRight size={14} className="mx-1.5 text-slate-400" />
                    <span className="text-slate-800 font-medium">All Stores</span>
                </motion.div>

                {/* Hero Header */}
                <motion.div
                    className="relative rounded-2xl overflow-hidden mb-8 bg-linear-to-r from-indigo-600 via-indigo-500 to-sky-500 p-6 md:p-8 shadow-xl shadow-indigo-300/40"
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.5, delay: 0.1 }}
                >
                    <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,rgba(255,255,255,0.12),transparent_60%)]" />
                    <div className="relative flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                        <div className="flex items-center gap-4">
                            <div className="p-3 bg-white/15 rounded-2xl border border-white/20">
                                <Store size={30} className="text-white" />
                            </div>
                            <div>
                                <h1 className="text-2xl md:text-3xl font-bold text-white">Discover Stores</h1>
                                <p className="text-indigo-200 text-sm mt-0.5">Explore amazing sellers and their unique products</p>
                            </div>
                        </div>
                        <Link to="/stores/trusted">
                            <motion.button whileHover={{ y: -1 }} whileTap={{ scale: 0.97 }}
                                className="flex items-center gap-2 px-5 py-2.5 bg-white/15 hover:bg-white/25 border border-white/25 text-white rounded-xl font-semibold text-sm transition-all shadow-sm">
                                <span>❤️</span>
                                <span>My Trusted Stores</span>
                            </motion.button>
                        </Link>
                    </div>
                </motion.div>

                {/* Search and Sort Card */}
                <motion.div
                    className="bg-white/70 backdrop-blur-sm rounded-2xl shadow-sm border border-white/60 p-5 mb-8"
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.5, delay: 0.2 }}
                >
                    <div className="flex flex-col md:flex-row gap-3">
                        <div className="flex-1 relative">
                            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" size={17} />
                            <input
                                type="text"
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                placeholder="Search for stores..."
                                className="w-full pl-10 pr-4 py-2.5 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:border-indigo-400 transition-all text-sm bg-slate-50 placeholder-slate-400"
                            />
                        </div>
                        <select
                            value={sortBy}
                            onChange={(e) => setSortBy(e.target.value)}
                            className="px-4 py-2.5 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:border-indigo-400 font-medium bg-slate-50 transition-all cursor-pointer text-sm text-slate-700"
                        >
                            <option value="newest">✨ Newest First</option>
                            <option value="views">👁️ Most Viewed</option>
                            <option value="name">🔤 Name (A-Z)</option>
                        </select>
                    </div>
                </motion.div>

                {/* Stores Grid */}
                {loading ? (
                    <div className="flex justify-center items-center h-64">
                        <Loader />
                    </div>
                ) : filteredStores.length === 0 ? (
                    <motion.div
                        className="flex flex-col items-center justify-center h-64 bg-white/70 backdrop-blur-sm rounded-2xl shadow-sm border border-white/60"
                        initial={{ opacity: 0, scale: 0.95 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ duration: 0.4 }}
                    >
                        <Store size={48} className="text-slate-300 mb-3" />
                        <p className="text-base font-semibold text-slate-600">
                            {searchQuery ? 'No stores found' : 'No stores available yet'}
                        </p>
                        <p className="text-sm text-slate-400 mt-1">
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
                            <p className="text-slate-500 text-sm">
                                Showing <span className="text-slate-800 font-bold">{filteredStores.length}</span> {filteredStores.length === 1 ? 'store' : 'stores'}
                            </p>
                            <div className="flex items-center gap-1.5 text-sm text-slate-400">
                                <Sparkles size={15} className="text-indigo-400" />
                                <span>Find your favorite seller</span>
                            </div>
                        </div>
                        <div className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4 md:gap-6">
                            {filteredStores.map((store, idx) => (
                                <motion.div
                                    key={store._id}
                                    initial={{ opacity: 0, y: 20 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    transition={{ duration: 0.4, delay: idx * 0.05 }}
                                >
                                    <StoreCard store={store} idx={idx} />
                                </motion.div>
                            ))}
                        </div>
                    </motion.div>
                )}
            </div>
        </motion.div>
    );
};

export default StoresListing;
