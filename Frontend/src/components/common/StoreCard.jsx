import { useState } from 'react';
import { motion } from 'framer-motion';
import { Store, Package, Eye } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import TrustButton from './TrustButton';
import VerifiedBadge from './VerifiedBadge';

const StoreCard = ({ store, idx }) => {
    const navigate = useNavigate();
    const [trustCount, setTrustCount] = useState(store.trustCount || 0);
    const [isTrusted, setIsTrusted] = useState(false);

    return (
        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: idx * 0.05 }}
            whileHover={{ y: -3, scale: 1.015 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => navigate(`/store/${store.storeSlug}`)}
            className="glass-card water-shimmer overflow-hidden cursor-pointer group"
        >
            {/* Banner or Gradient */}
            {store.banner ? (
                <div className="h-24 sm:h-28 md:h-32 overflow-hidden relative">
                    <img
                        src={store.banner}
                        alt={store.storeName}
                        className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-500"
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/30 to-transparent" />
                </div>
            ) : (
                <div className="h-24 sm:h-28 md:h-32 relative overflow-hidden"
                     style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))' }}>
                    <div className="absolute inset-0 bg-white/10 backdrop-blur-sm" />
                    <div className="absolute inset-0 flex items-center justify-center">
                        <Store size={32} className="text-white/30" />
                    </div>
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
                            className="w-14 h-14 sm:w-16 sm:h-16 md:w-18 md:h-18 rounded-2xl object-cover border-2 border-white/40 shadow-lg backdrop-blur-sm"
                        />
                    ) : (
                        <div className="w-14 h-14 sm:w-16 sm:h-16 md:w-18 md:h-18 rounded-2xl flex items-center justify-center border-2 border-white/40 shadow-lg"
                             style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))' }}>
                            <Store size={22} className="sm:w-6 sm:h-6 md:w-7 md:h-7 text-white" />
                        </div>
                    )}
                </div>

                {/* Store Name & Trust Button */}
                <div className="flex items-center justify-between gap-2 mb-1 sm:mb-1.5">
                    <h3 className="font-bold text-sm sm:text-base text-[hsl(220,25%,10%)] truncate flex-1 flex items-center gap-1.5">
                        {store.storeName}
                        {store.verification?.isVerified && <VerifiedBadge size="sm" />}
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
                <p className="text-[10px] sm:text-xs mb-2" style={{ color: 'hsl(var(--muted-foreground))' }}>
                    {trustCount} {trustCount === 1 ? 'truster' : 'trusters'}
                </p>

                {/* Description */}
                {store.description && (
                    <p className="text-xs sm:text-sm mb-2 sm:mb-3 line-clamp-2 min-h-[32px] sm:min-h-[36px] leading-relaxed"
                       style={{ color: 'hsl(var(--muted-foreground))' }}>
                        {store.description}
                    </p>
                )}

                {/* Stats */}
                <div className="flex items-center gap-2 sm:gap-3 text-xs sm:text-sm pt-2 sm:pt-3 border-t border-white/15">
                    <div className="flex items-center gap-1 sm:gap-1.5 font-medium" style={{ color: 'hsl(var(--primary))' }}>
                        <Package size={12} className="sm:w-3.5 sm:h-3.5" />
                        <span>{store.productCount || 0} items</span>
                    </div>
                    <div className="flex items-center gap-1 sm:gap-1.5 font-medium" style={{ color: 'hsl(200, 80%, 55%)' }}>
                        <Eye size={12} className="sm:w-3.5 sm:h-3.5" />
                        <span>{store.views || 0} views</span>
                    </div>
                </div>
            </div>
        </motion.div>
    );
};

export default StoreCard;
