import { useState, useEffect } from 'react';
import { Store, ExternalLink, Heart } from 'lucide-react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import TrustButton from './TrustButton';
import VerifiedBadge from './VerifiedBadge';

const StoreInfo = ({ storeName, storeSlug, storeLogo, sellerUsername, storeId, trustCount: initialTrustCount = 0, verification }) => {
    const [trustCount, setTrustCount] = useState(initialTrustCount);
    const [isTrusted, setIsTrusted] = useState(false);

    // Update local state when prop changes
    useEffect(() => {
        setTrustCount(initialTrustCount);
    }, [initialTrustCount]);
    // If no store configured, show seller username
    if (!storeName || !storeSlug) {
        return (
            <div className="bg-white rounded-lg border border-gray-200 p-4">
                <p className="text-sm text-gray-600">
                    Sold by <span className="font-medium text-gray-900">{sellerUsername || 'Seller'}</span>
                </p>
            </div>
        );
    }

    return (
        <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-white/80 backdrop-blur-sm rounded-lg border border-white/60 p-4 shadow-sm"
        >
            <p className="text-xs text-gray-600 mb-2 uppercase tracking-wide">Sold by</p>
            
            <Link to={`/store/${storeSlug}`} className="block group">
                <div className="flex items-center gap-3 mb-3">
                    {storeLogo ? (
                        <img
                            src={storeLogo}
                            alt={storeName}
                            className="w-12 h-12 rounded-full object-cover border-2 border-white shadow-sm group-hover:scale-105 transition-transform"
                        />
                    ) : (
                        <div className="w-12 h-12 rounded-full bg-linear-to-br from-indigo-500 to-sky-400 flex items-center justify-center border-2 border-white shadow-sm group-hover:scale-105 transition-transform">
                            <Store size={24} className="text-white" />
                        </div>
                    )}
                    <div className="flex-1">
                        <div className="flex items-center justify-between gap-2 mb-1">
                            <h3 className="font-semibold text-gray-900 group-hover:text-indigo-600 transition-colors flex items-center gap-1.5">
                                {storeName}
                                {verification?.isVerified && (
                                    <VerifiedBadge size="sm" />
                                )}
                            </h3>
                            {storeId && (
                                <div onClick={(e) => e.preventDefault()}>
                                    <TrustButton
                                        storeId={storeId}
                                        storeName={storeName}
                                        initialTrustCount={trustCount}
                                        initialIsTrusted={isTrusted}
                                        compact={true}
                                        onTrustChange={(newIsTrusted, newCount) => {
                                            setIsTrusted(newIsTrusted);
                                            setTrustCount(newCount);
                                        }}
                                    />
                                </div>
                            )}
                        </div>
                        <p className="text-xs text-gray-500">/{storeSlug}</p>
                        <p className="text-xs text-gray-500 mt-1">{trustCount} {trustCount === 1 ? 'truster' : 'trusters'}</p>
                    </div>
                </div>
            </Link>

            <Link to={`/store/${storeSlug}`}>
                <motion.button
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    className="w-full px-4 py-2 bg-linear-to-r from-indigo-600 to-sky-500 text-white rounded-lg hover:from-indigo-700 hover:to-sky-600 transition-all flex items-center justify-center gap-2 shadow-md"
                >
                    <Store size={16} />
                    Visit Store
                    <ExternalLink size={14} />
                </motion.button>
            </Link>
        </motion.div>
    );
};

export default StoreInfo;
