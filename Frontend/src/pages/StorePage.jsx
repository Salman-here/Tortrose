import { useState, useEffect } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Store, Package, Eye, Share2, ChevronRight, Home, Loader2 } from 'lucide-react';
import axios from 'axios';
import { toast } from 'react-toastify';
import ProductCard from '../components/common/ProductCard';
import Loader from '../components/common/Loader';

const StorePage = () => {
    const { slug } = useParams();
    const navigate = useNavigate();
    const [store, setStore] = useState(null);
    const [products, setProducts] = useState([]);
    const [loading, setLoading] = useState(true);
    const [productsLoading, setProductsLoading] = useState(true);
    const [notFound, setNotFound] = useState(false);

    useEffect(() => {
        fetchStore();
        fetchProducts();
        incrementViewCount();
    }, [slug]);

    const fetchStore = async () => {
        try {
            setLoading(true);
            const res = await axios.get(`${import.meta.env.VITE_API_URL}api/stores/${slug}`);
            setStore(res.data.store);
            setNotFound(false);
        } catch (error) {
            console.error('Error fetching store:', error);
            if (error.response?.status === 404) {
                setNotFound(true);
            } else {
                toast.error('Failed to load store');
            }
        } finally {
            setLoading(false);
        }
    };

    const fetchProducts = async () => {
        try {
            setProductsLoading(true);
            const res = await axios.get(`${import.meta.env.VITE_API_URL}api/stores/${slug}/products`);
            setProducts(res.data.products);
        } catch (error) {
            console.error('Error fetching products:', error);
        } finally {
            setProductsLoading(false);
        }
    };

    const incrementViewCount = async () => {
        try {
            await axios.post(`${import.meta.env.VITE_API_URL}api/stores/${slug}/view`);
        } catch (error) {
            console.error('Error incrementing view count:', error);
        }
    };

    const handleShare = () => {
        const url = window.location.href;
        if (navigator.share) {
            navigator.share({
                title: store?.storeName,
                text: `Check out ${store?.storeName} on genZ Winners`,
                url: url
            });
        } else {
            navigator.clipboard.writeText(url);
            toast.success('Store link copied to clipboard!');
        }
    };

    if (loading) {
        return (
            <div className="flex justify-center items-center min-h-screen">
                <Loader />
            </div>
        );
    }

    if (notFound) {
        return (
            <div className="flex flex-col items-center justify-center min-h-screen p-4">
                <Store size={80} className="text-gray-300 mb-4" />
                <h1 className="text-3xl font-bold text-gray-800 mb-2">Store Not Found</h1>
                <p className="text-gray-600 mb-6">The store you're looking for doesn't exist or has been removed.</p>
                <div className="flex gap-4">
                    <button
                        onClick={() => navigate('/stores')}
                        className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                    >
                        Browse All Stores
                    </button>
                    <button
                        onClick={() => navigate('/')}
                        className="px-6 py-3 border border-gray-300 rounded-lg hover:bg-gray-50"
                    >
                        Go Home
                    </button>
                </div>
            </div>
        );
    }

    return (
        <motion.div 
            className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100 py-8"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5 }}
        >
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                {/* Breadcrumb */}
                <motion.div
                    className="flex items-center text-sm text-gray-500 mb-6"
                    initial={{ opacity: 0, y: -10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.3 }}
                >
                    <Link to="/" className="hover:text-blue-600 flex items-center gap-1 transition-colors">
                        <Home size={16} />
                        <span>Home</span>
                    </Link>
                    <ChevronRight size={16} className="mx-2" />
                    <Link to="/stores" className="hover:text-blue-600 transition-colors">
                        Stores
                    </Link>
                    <ChevronRight size={16} className="mx-2" />
                    <span className="text-gray-800 font-medium truncate">{store?.storeName}</span>
                </motion.div>

                {/* Store Header Card */}
                <motion.div 
                    className="bg-white rounded-2xl shadow-lg overflow-hidden mb-8"
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.5, delay: 0.1 }}
                >
                    {/* Banner */}
                    {store?.banner && (
                        <div className="w-full h-48 md:h-64 overflow-hidden relative">
                            <motion.img
                                src={store.banner}
                                alt={`${store.storeName} banner`}
                                className="w-full h-full object-cover"
                                initial={{ scale: 1.1 }}
                                animate={{ scale: 1 }}
                                transition={{ duration: 0.6 }}
                            />
                            <div className="absolute inset-0 bg-gradient-to-t from-black/30 to-transparent" />
                        </div>
                    )}

                    {/* Store Info */}
                    <div className={`p-6 md:p-8 ${store?.banner ? 'pt-8 md:pt-10' : ''}`}>
                        <div className="flex flex-col md:flex-row gap-6 items-start">
                            {/* Logo */}
                            <motion.div 
                                className={`${store?.banner ? 'absolute -mt-20 md:-mt-24' : ''} flex-shrink-0`}
                                initial={{ scale: 0.8, opacity: 0 }}
                                animate={{ scale: 1, opacity: 1 }}
                                transition={{ duration: 0.4, delay: 0.2 }}
                            >
                                {store?.logo ? (
                                    <img
                                        src={store.logo}
                                        alt={store.storeName}
                                        className="w-24 h-24 md:w-32 md:h-32 rounded-full object-cover border-4 border-white shadow-xl ring-2 ring-gray-100"
                                    />
                                ) : (
                                    <div className="w-24 h-24 md:w-32 md:h-32 rounded-full bg-gradient-to-br from-blue-500 to-purple-500 flex items-center justify-center border-4 border-white shadow-xl ring-2 ring-gray-100">
                                        <Store size={48} className="text-white" />
                                    </div>
                                )}
                            </motion.div>

                            {/* Store Details */}
                            <div className={`flex-1 ${store?.banner ? 'mt-8 md:mt-0 md:ml-40' : ''}`}>
                                <motion.h1 
                                    className="text-2xl md:text-3xl lg:text-4xl font-bold text-gray-900 mb-3"
                                    initial={{ opacity: 0, x: -20 }}
                                    animate={{ opacity: 1, x: 0 }}
                                    transition={{ duration: 0.4, delay: 0.3 }}
                                >
                                    {store?.storeName}
                                </motion.h1>
                                {store?.description && (
                                    <motion.p 
                                        className="text-gray-600 mb-4 max-w-3xl leading-relaxed"
                                        initial={{ opacity: 0 }}
                                        animate={{ opacity: 1 }}
                                        transition={{ duration: 0.4, delay: 0.4 }}
                                    >
                                        {store.description}
                                    </motion.p>
                                )}
                                <motion.div 
                                    className="flex flex-wrap gap-4 text-sm"
                                    initial={{ opacity: 0 }}
                                    animate={{ opacity: 1 }}
                                    transition={{ duration: 0.4, delay: 0.5 }}
                                >
                                    <div className="flex items-center gap-2 px-3 py-1.5 bg-blue-50 text-blue-700 rounded-full">
                                        <Package size={16} />
                                        <span className="font-medium">{products.length} Products</span>
                                    </div>
                                    <div className="flex items-center gap-2 px-3 py-1.5 bg-purple-50 text-purple-700 rounded-full">
                                        <Eye size={16} />
                                        <span className="font-medium">{store?.views || 0} Views</span>
                                    </div>
                                </motion.div>
                            </div>

                            {/* Share Button */}
                            <motion.button
                                onClick={handleShare}
                                className="px-5 py-2.5 border-2 border-gray-200 rounded-xl hover:bg-gray-50 hover:border-gray-300 flex items-center gap-2 transition-all font-medium text-gray-700"
                                whileHover={{ scale: 1.05 }}
                                whileTap={{ scale: 0.95 }}
                                initial={{ opacity: 0, scale: 0.9 }}
                                animate={{ opacity: 1, scale: 1 }}
                                transition={{ duration: 0.3, delay: 0.6 }}
                            >
                                <Share2 size={18} />
                                Share Store
                            </motion.button>
                        </div>
                    </div>
                </motion.div>

                {/* Products Section */}
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.5, delay: 0.3 }}
                >
                    <div className="flex items-center justify-between mb-6">
                        <h2 className="text-2xl md:text-3xl font-bold text-gray-900">
                            Products
                        </h2>
                        <span className="text-sm text-gray-500">
                            {products.length} {products.length === 1 ? 'item' : 'items'}
                        </span>
                    </div>

                    {productsLoading ? (
                        <div className="flex justify-center items-center h-64">
                            <Loader />
                        </div>
                    ) : products.length === 0 ? (
                        <motion.div 
                            className="flex flex-col items-center justify-center h-64 bg-white rounded-2xl shadow-sm"
                            initial={{ opacity: 0, scale: 0.9 }}
                            animate={{ opacity: 1, scale: 1 }}
                            transition={{ duration: 0.4 }}
                        >
                            <Package size={64} className="text-gray-300 mb-4" />
                            <p className="text-lg font-semibold text-gray-700">No products yet</p>
                            <p className="text-sm text-gray-500 mt-2">This store hasn't added any products</p>
                        </motion.div>
                    ) : (
                        <div className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4 md:gap-6">
                            {products.map((product, idx) => (
                                <motion.div
                                    key={product._id}
                                    initial={{ opacity: 0, y: 20 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    transition={{ duration: 0.4, delay: idx * 0.05 }}
                                >
                                    <ProductCard idx={idx} {...product} />
                                </motion.div>
                            ))}
                        </div>
                    )}
                </motion.div>
            </div>
        </motion.div>
    );
};

export default StorePage;
