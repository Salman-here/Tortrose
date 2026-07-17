import { useState } from 'react';
import { motion } from 'framer-motion';
import { Store, Package, Eye, Sparkles, Star } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import TrustButton from './TrustButton';
import VerifiedBadge from './VerifiedBadge';
import { getStoreSubdomainUrl } from '../../utils/subdomainHelper';

const SellerTypePill = ({ type }) => {
    const isBrand = type === 'brand';
    const bg = isBrand ? 'hsla(280, 70%, 55%, 0.15)' : 'hsla(220, 70%, 55%, 0.15)';
    const border = isBrand ? 'hsla(280, 70%, 55%, 0.35)' : 'hsla(220, 70%, 55%, 0.35)';
    const color = isBrand ? 'hsl(280, 70%, 55%)' : 'hsl(220, 70%, 55%)';
    return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide"
            style={{ background: bg, border: `1px solid ${border}`, color, backdropFilter: 'blur(8px)' }}>
            {isBrand ? <Sparkles size={9} /> : <Store size={9} />}
            {isBrand ? 'Brand' : 'Store'}
        </span>
    );
};

const StoreCard = ({ store, idx }) => {
    const navigate = useNavigate();
    const [trustCount, setTrustCount] = useState(store.trustCount || 0);
    const [isTrusted, setIsTrusted] = useState(false);
    const ratingAverage = Number(store.ratingAverage) || 0;
    const ratingCount = Number(store.ratingCount) || 0;

    return (
        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: idx * 0.05 }}
            whileHover={{ y: -3, scale: 1.015 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => {
                const url = getStoreSubdomainUrl(store.storeSlug);
                if (url.startsWith('/')) navigate(url);
                else window.location.href = url;
            }}
            className="glass-card water-shimmer overflow-hidden cursor-pointer group"
        >
            {/* Banner or Gradient */}
            {store.banner ? (
                <div className="h-20 sm:h-24 md:h-28 lg:h-32 overflow-hidden relative">
                    <img
                        src={store.banner}
                        alt={store.storeName}
                        className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-500"
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/30 to-transparent" />
                    <div className="absolute top-1.5 right-1.5 sm:top-2 sm:right-2 z-10">
                        <SellerTypePill type={store.sellerType} />
                    </div>
                </div>
            ) : (
                <div className="h-20 sm:h-24 md:h-28 lg:h-32 relative overflow-hidden"
                     style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))' }}>
                    <div className="absolute inset-0 bg-white/10 backdrop-blur-sm" />
                    <div className="absolute inset-0 flex items-center justify-center">
                        <Store size={24} className="sm:w-8 sm:h-8 text-white/30" />
                    </div>
                    <div className="absolute top-1.5 right-1.5 sm:top-2 sm:right-2 z-10">
                        <SellerTypePill type={store.sellerType} />
                    </div>
                </div>
            )}

            {/* Store Info */}
            <div className="p-2.5 sm:p-3 md:p-4 lg:p-5 relative">
                {/* Logo */}
                <div className="-mt-8 sm:-mt-10 md:-mt-12 lg:-mt-14 mb-1.5 sm:mb-2 md:mb-2.5 lg:mb-3">
                    {store.logo ? (
                        <img
                            src={store.logo}
                            alt={store.storeName}
                            className="w-12 h-12 sm:w-14 sm:h-14 md:w-16 md:h-16 lg:w-18 lg:h-18 rounded-xl sm:rounded-2xl object-cover border-2 border-white/40 shadow-lg backdrop-blur-sm"
                        />
                    ) : (
                        <div className="w-12 h-12 sm:w-14 sm:h-14 md:w-16 md:h-16 lg:w-18 lg:h-18 rounded-xl sm:rounded-2xl flex items-center justify-center border-2 border-white/40 shadow-lg"
                             style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))' }}>
                            <Store size={18} className="sm:w-5 sm:h-5 md:w-6 md:h-6 lg:w-7 lg:h-7 text-white" />
                        </div>
                    )}
                </div>

                {/* Store Name & Trust Button */}
                <div className="flex items-start justify-between gap-1.5 sm:gap-2 mb-0.5 sm:mb-1">
                    <h3 className="font-bold text-xs sm:text-sm md:text-base text-[hsl(220,25%,10%)] truncate flex-1 flex items-center gap-1 sm:gap-1.5">
                        <span className="truncate">{store.storeName}</span>
                        {store.verification?.isVerified && <VerifiedBadge size="sm" />}
                    </h3>
                    <div onClick={(e) => e.stopPropagation()} className="shrink-0">
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
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[9px] sm:text-[10px] md:text-xs mb-1.5 sm:mb-2" style={{ color: 'hsl(var(--muted-foreground))' }}>
                    <span>{trustCount} {trustCount === 1 ? 'truster' : 'trusters'}</span>
                    <span className="inline-flex items-center gap-1"><Star size={11} style={{ color: 'hsl(45,93%,47%)', fill: ratingCount > 0 ? 'hsl(45,93%,47%)' : 'none' }} />{ratingCount > 0 ? `${ratingAverage.toFixed(1)} (${ratingCount})` : 'New'}</span>
                </div>

                {/* Description */}
                {store.description && (
                    <p className="text-[10px] sm:text-xs md:text-sm mb-1.5 sm:mb-2 md:mb-3 line-clamp-2 min-h-[28px] sm:min-h-[32px] md:min-h-[36px] leading-relaxed"
                       style={{ color: 'hsl(var(--muted-foreground))' }}>
                        {store.description}
                    </p>
                )}

                {/* Stats */}
                <div className="flex items-center gap-1.5 sm:gap-2 md:gap-3 text-[10px] sm:text-xs md:text-sm pt-1.5 sm:pt-2 md:pt-3 border-t border-white/15">
                    <div className="flex items-center gap-0.5 sm:gap-1 md:gap-1.5 font-medium" style={{ color: 'hsl(var(--primary))' }}>
                        <Package size={11} className="sm:w-3 sm:h-3 md:w-3.5 md:h-3.5" />
                        <span>{store.productCount || 0} items</span>
                    </div>
                    <div className="flex items-center gap-0.5 sm:gap-1 md:gap-1.5 font-medium" style={{ color: 'hsl(200, 80%, 55%)' }}>
                        <Eye size={11} className="sm:w-3 sm:h-3 md:w-3.5 md:h-3.5" />
                        <span>{store.views || 0} views</span>
                    </div>
                </div>
            </div>
        </motion.div>
    );
};

export default StoreCard;
