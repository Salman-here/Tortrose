import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Store, Heart, ChevronRight, Home, Loader2 } from 'lucide-react';
import axios from 'axios';
import { toast } from 'react-toastify';
import Loader from '../components/common/Loader';
import { useAuth } from '../contexts/AuthContext';
import VerifiedBadge from '../components/common/VerifiedBadge';

const TrustedStoresPage = () => {
    const [trustedStores, setTrustedStores] = useState([]);
    const [loading, setLoading] = useState(true);
    const navigate = useNavigate();
    const { currentUser } = useAuth();

    useEffect(() => {
        if (!currentUser) {
            toast.error('Please login to view your trusted stores');
            navigate('/');
            return;
        }
        fetchTrustedStores();
    }, [currentUser, navigate]);

    const fetchTrustedStores = async () => {
        try {
            setLoading(true);
            const token = localStorage.getItem('jwtToken');
            const config = {
                headers: {
                    Authorization: `Bearer ${token}`
                }
            };

            const res = await axios.get(
                `${import.meta.env.VITE_API_URL}api/stores/trusted`,
                config
            );
            setTrustedStores(res.data.data.trustedStores);
        } catch (error) {
            console.error('Error fetching trusted stores:', error);
            toast.error('Failed to load trusted stores');
        } finally {
            setLoading(false);
        }
    };

    const handleStoreClick = (storeSlug) => {
        navigate(`/store/${storeSlug}`);
    };

    if (loading) {
        return (
            <div className="flex justify-center items-center min-h-screen">
                <Loader />
            </div>
        );
    }

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
                        <Home size={16} />
                        <span>Home</span>
                    </Link>
                    <ChevronRight size={16} className="mx-2" />
                    <Link to="/stores" className="hover:text-indigo-600 transition-colors">
                        Stores
                    </Link>
                    <ChevronRight size={16} className="mx-2" />
                    <span className="text-slate-800 font-medium">My Trusted Stores</span>
                </motion.div>

                {/* Header */}
                <motion.div
                    className="relative rounded-2xl overflow-hidden mb-8 bg-linear-to-r from-indigo-600 via-indigo-500 to-sky-500 p-6 md:p-8 shadow-xl shadow-indigo-300/40"
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.5, delay: 0.1 }}
                >
                    <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,rgba(255,255,255,0.12),transparent_60%)]" />
                    <div className="relative">
                        <h1 className="text-3xl md:text-4xl font-bold text-white mb-2 flex items-center gap-3">
                            <Heart className="text-red-300" size={36} fill="currentColor" />
                            My Trusted Stores
                        </h1>
                        <p className="text-white/80">
                            {trustedStores.length} {trustedStores.length === 1 ? 'store' : 'stores'} you trust
                        </p>
                    </div>
                </motion.div>

                {/* Trusted Stores List */}
                {trustedStores.length === 0 ? (
                    <motion.div
                        className="flex flex-col items-center justify-center bg-white/80 backdrop-blur-sm rounded-2xl shadow-md border border-white/60 p-12"
                        initial={{ opacity: 0, scale: 0.9 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ duration: 0.4 }}
                    >
                        <Store size={80} className="text-gray-300 mb-4" />
                        <h2 className="text-2xl font-bold text-gray-800 mb-2">No Trusted Stores Yet</h2>
                        <p className="text-gray-600 mb-6 text-center max-w-md">
                            Start exploring stores and trust the ones you love to keep track of them here!
                        </p>
                        <button
                            onClick={() => navigate('/stores')}
                            className="px-6 py-3 bg-linear-to-r from-indigo-600 to-sky-500 hover:from-indigo-700 hover:to-sky-600 text-white rounded-xl shadow-md shadow-indigo-300/30 transition-all font-semibold"
                        >
                            Browse Stores
                        </button>
                    </motion.div>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                        {trustedStores.map((store, idx) => (
                            <motion.div
                                key={store._id}
                                className="bg-white/80 backdrop-blur-sm rounded-xl shadow-md hover:shadow-xl border border-white/60 transition-all cursor-pointer overflow-hidden"
                                onClick={() => handleStoreClick(store.storeSlug)}
                                initial={{ opacity: 0, y: 20 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ duration: 0.4, delay: idx * 0.05 }}
                                whileHover={{ y: -5 }}
                            >
                                {/* Store Logo */}
                                <div className="p-6 flex items-center gap-4">
                                    {store.logo ? (
                                        <img
                                            src={store.logo}
                                            alt={store.storeName}
                                            className="w-16 h-16 rounded-full object-cover border-2 border-gray-100"
                                        />
                                    ) : (
                                        <div className="w-16 h-16 rounded-full bg-linear-to-br from-indigo-500 to-sky-400 flex items-center justify-center">
                                            <Store size={28} className="text-white" />
                                        </div>
                                    )}
                                    
                                    <div className="flex-1 min-w-0">
                                        <h3 className="text-lg font-bold text-gray-900 truncate flex items-center gap-2">
                                            {store.storeName}
                                            {store.verification?.isVerified && (
                                                <VerifiedBadge size="md" />
                                            )}
                                        </h3>
                                        <p className="text-sm text-gray-500">
                                            {store.trustCount} {store.trustCount === 1 ? 'truster' : 'trusters'}
                                        </p>
                                    </div>
                                </div>

                                {/* Store Description */}
                                {store.description && (
                                    <div className="px-6 pb-4">
                                        <p className="text-sm text-gray-600 line-clamp-2">
                                            {store.description}
                                        </p>
                                    </div>
                                )}

                                {/* Trusted Date */}
                                <div className="px-6 py-3 bg-white/40 border-t border-white/40">
                                    <p className="text-xs text-gray-500">
                                        Trusted on {new Date(store.trustedAt).toLocaleDateString('en-US', {
                                            year: 'numeric',
                                            month: 'long',
                                            day: 'numeric'
                                        })}
                                    </p>
                                </div>
                            </motion.div>
                        ))}
                    </div>
                )}
            </div>
        </motion.div>
    );
};

export default TrustedStoresPage;
