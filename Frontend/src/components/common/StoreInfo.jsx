import { useState, useEffect } from 'react';
import { Store, ExternalLink, Users, Star } from 'lucide-react';
import { motion } from 'framer-motion';
import TrustButton from './TrustButton';
import VerifiedBadge from './VerifiedBadge';
import { getStoreSubdomainUrl } from '../../utils/subdomainHelper';

const StoreInfo = ({ storeName, storeSlug, storeLogo, sellerUsername, storeId, trustCount: initialTrustCount = 0, verification, ratingAverage = 0, ratingCount = 0 }) => {
    const [trustCount, setTrustCount] = useState(initialTrustCount);
    const [isTrusted, setIsTrusted] = useState(false);

    useEffect(() => {
        setTrustCount(initialTrustCount);
    }, [initialTrustCount]);

    if (!storeName || !storeSlug) {
        return (
            <div className="glass-inner rounded-xl p-4">
                <p className="text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>
                    Sold by <span className="font-medium" style={{ color: 'hsl(var(--foreground))' }}>{sellerUsername || 'Seller'}</span>
                </p>
            </div>
        );
    }

    return (
        <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="glass-inner rounded-2xl p-4"
        >
            <p className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: 'hsl(var(--muted-foreground))' }}>Sold by</p>

            <a href={getStoreSubdomainUrl(storeSlug)} className="block group">
                <div className="flex items-center gap-3 mb-3">
                    {storeLogo ? (
                        <img
                            src={storeLogo}
                            alt={storeName}
                            className="w-11 h-11 rounded-full object-cover group-hover:scale-105 transition-transform"
                            style={{ border: '2px solid var(--glass-border-strong)' }}
                        />
                    ) : (
                        <div className="w-11 h-11 rounded-full flex items-center justify-center group-hover:scale-105 transition-transform"
                            style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))', border: '2px solid var(--glass-border-strong)' }}>
                            <Store size={20} className="text-white" />
                        </div>
                    )}
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2 mb-0.5">
                            <h3 className="font-semibold text-sm transition-colors flex items-center gap-1.5 truncate"
                                style={{ color: 'hsl(var(--foreground))' }}>
                                {storeName}
                                {verification?.isVerified && <VerifiedBadge size="sm" />}
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
                        <div className="flex items-center gap-2 text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>
                            <span>/{storeSlug}</span>
                            <span className="opacity-40">·</span>
                            <span className="flex items-center gap-1"><Users size={11} /> {trustCount} {trustCount === 1 ? 'truster' : 'trusters'}</span>
                        </div>
                        <div className="flex items-center gap-1 text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                            <Star size={11} style={{ color: 'hsl(45,93%,47%)', fill: ratingCount > 0 ? 'hsl(45,93%,47%)' : 'none' }} />
                            {ratingCount > 0 ? `${Number(ratingAverage).toFixed(1)} store rating (${ratingCount})` : 'No store ratings yet'}
                        </div>
                    </div>
                </div>
            </a>

            <a href={getStoreSubdomainUrl(storeSlug)}>
                <motion.button
                    whileHover={{ scale: 1.02, y: -1 }}
                    whileTap={{ scale: 0.98 }}
                    className="w-full px-4 py-2.5 rounded-xl flex items-center justify-center gap-2 font-semibold text-sm transition-all"
                    style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))', color: 'white', boxShadow: '0 0 20px -4px hsl(220, 70%, 55%, 0.3)' }}
                >
                    <Store size={15} />
                    Visit Store
                    <ExternalLink size={13} />
                </motion.button>
            </a>
        </motion.div>
    );
};

export default StoreInfo;
