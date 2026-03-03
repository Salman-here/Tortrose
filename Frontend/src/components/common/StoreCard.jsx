import { useState } from 'react';
import { motion } from 'framer-motion';
import { Store, Package, Eye, Heart } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import TrustButton from './TrustButton';
import VerifiedBadge from './VerifiedBadge';

const StoreCard = ({ store, idx }) => {
    const navigate = useNavigate();
    const [trustCount, setTrustCount] = useState(store.trustCount || 0);
    const [isTrusted, setIsTrusted] = useState(false);

    const cardVariants = {
        hidden: { opacity: 0, y: 20 },
        visible: {
            opacity: 1,
            y: 0,
            transition: {
                duration: 0.4,
                delay: idx * 0.1
            }
        }
    };

    return (
        <motion.div
            variants={cardVariants}
            initial="hidden"
            animate="visible"
            whileHover={{ y: -8, scale: 1.02, transition: { duration: 0.3 } }}
            whileTap={{ scale: 0.98 }}
            onClick={() => navigate(`/store/${store.storeSlug}`)}
            className="bg-white rounded-xl sm:rounded-2xl shadow-md hover:shadow-2xl border border-gray-100 overflow-hidden cursor-pointer transition-all group"
        >
            {/* Banner or Gradient */}
            {store.banner ? (
                <div className="h-24 sm:h-28 md:h-32 overflow-hidden relative">
                    <img
                        src={store.banner}
                        alt={store.storeName}
                        className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-500"
                    />
                    <div className="absolute inset-0 bg-linear-to-t from-black/20 to-transparent" />
                </div>
            ) : (
                <div className="h-24 sm:h-28 md:h-32 bg-linear-to-br from-indigo-500 to-sky-400 relative overflow-hidden">
                    <div className="absolute inset-0 bg-white/10 backdrop-blur-sm" />
                </div>
            )}

            {/* Store Info */}
            <div className="p-3 sm:p-4 md:p-5 relative">
                {/* Logo */}
                <div className="-mt-10 sm:-mt-12 md:-mt-14 mb-2 sm:mb-2.5 md:mb-3">
                    {store.logo ? (
                        <img
                            src={store.logo}
                            alt={store.storeName}
                            className="w-16 h-16 sm:w-18 sm:h-18 md:w-20 md:h-20 rounded-full object-cover border-3 sm:border-4 border-white shadow-xl ring-2 ring-white/60 group-hover:ring-indigo-200 transition-all"
                        />
                    ) : (
                        <div className="w-16 h-16 sm:w-18 sm:h-18 md:w-20 md:h-20 rounded-full bg-linear-to-br from-indigo-500 to-sky-400 flex items-center justify-center border-3 sm:border-4 border-white shadow-xl ring-2 ring-white/60 group-hover:ring-indigo-200 transition-all">
                            <Store size={24} className="sm:w-7 sm:h-7 md:w-8 md:h-8 text-white" />
                        </div>
                    )}
                </div>

                {/* Store Name & Trust Button */}
                <div className="flex items-center justify-between gap-2 mb-1 sm:mb-1.5 md:mb-2">
                    <h3 className="font-bold text-sm sm:text-base md:text-lg text-gray-900 truncate group-hover:text-indigo-600 transition-colors flex-1 flex items-center gap-1.5">
                        {store.storeName}
                        {store.verification?.isVerified && (
                            <VerifiedBadge size="sm" />
                        )}
                    </h3>
                    <div onClick={(e) => e.stopPropagation()}>
                        <TrustButton
                            storeId={store._id}
                            storeName={store.storeName}
                            initialTrustCount={trustCount}
                            initialIsTrusted={isTrusted}
                            compact={true}
                            onTrustChange={(newIsTrusted, newCount) => {
                                setIsTrusted(newIsTrusted);
                                setTrustCount(newCount);
                            }}
                        />
                    </div>
                </div>

                {/* Trusters Count */}
                <div className="text-xs text-gray-500 mb-2">
                    <span>{trustCount} {trustCount === 1 ? 'truster' : 'trusters'}</span>
                </div>

                {/* Description */}
                {store.description && (
                    <p className="text-xs sm:text-sm text-gray-600 mb-2 sm:mb-3 md:mb-4 line-clamp-2 min-h-[32px] sm:min-h-[36px] md:min-h-[40px] leading-relaxed">
                        {store.description}
                    </p>
                )}

                {/* Stats */}
                <div className="flex items-center gap-2 sm:gap-3 md:gap-4 text-xs sm:text-sm pt-2 sm:pt-2.5 md:pt-3 border-t border-gray-100">
                    <div className="flex items-center gap-1 sm:gap-1.5 text-sky-600 font-medium">
                        <Package size={12} className="sm:w-4 sm:h-4" />
                        <span className="hidden sm:inline">{store.productCount || 0} items</span>
                        <span className="sm:hidden">{store.productCount || 0}</span>
                    </div>
                    <div className="flex items-center gap-1 sm:gap-1.5 text-sky-600 font-medium">
                        <Eye size={12} className="sm:w-4 sm:h-4" />
                        <span className="hidden sm:inline">{store.views || 0} views</span>
                        <span className="sm:hidden">{store.views || 0}</span>
                    </div>
                </div>
            </div>
        </motion.div>
    );
};

export default StoreCard;
