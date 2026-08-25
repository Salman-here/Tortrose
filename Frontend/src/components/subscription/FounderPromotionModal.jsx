import React, { useEffect, useState } from 'react';
import { AnimatePresence, motion as Motion } from 'framer-motion';
import { ArrowRight, Tag, X } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

const formatUsdMinor = (amountMinor) => {
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) return null;
    const value = BigInt(amountMinor);
    return `$${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
};

const isExactPromotionPercent = value => (
    typeof value === 'number'
    && Number.isFinite(value)
    && value > 0
    && value < 100
    && /^\d{1,2}(?:\.\d{1,2})?$/.test(String(value))
);

const FounderPromotionModal = ({ subscription, sellerKey }) => {
    const navigate = useNavigate();
    const location = useLocation();
    const [open, setOpen] = useState(false);
    const promotion = subscription?.founderPromotion;
    const starterFounderPrice = formatUsdMinor(subscription?.pricing?.starter?.founderAmountCents);
    const eliteFounderPrice = formatUsdMinor(subscription?.pricing?.elite?.founderAmountCents);
    const discountPercent = promotion?.discountPercent;
    const hasAuthoritativeOffer = Boolean(
        promotion?.available
        && promotion?.sellerEligible
        && !promotion?.entitlementActive
        && typeof promotion?.code === 'string'
        && promotion.code.trim()
        && isExactPromotionPercent(discountPercent)
        && Number.isSafeInteger(promotion?.remaining)
        && promotion.remaining >= 0
        && Number.isSafeInteger(promotion?.maxRedemptions)
        && promotion.maxRedemptions > 0
        && (promotion.sellerHasReservation || promotion.remaining > 0)
        && starterFounderPrice
        && eliteFounderPrice
    );

    useEffect(() => {
        if (!hasAuthoritativeOffer) {
            setOpen(false);
            return;
        }
        if (location.pathname.includes('/seller-dashboard/subscription')) return;

        const storageKey = `rozare-founder-promotion-last-shown:${sellerKey || 'seller'}`;
        let shouldOpen = true;
        try {
            const lastShown = Number(window.localStorage.getItem(storageKey) || 0);
            shouldOpen = !lastShown || Date.now() - lastShown >= FOUR_HOURS_MS;
            if (shouldOpen) window.localStorage.setItem(storageKey, String(Date.now()));
        } catch {
            // The promotion can still be shown when browser storage is unavailable.
        }
        if (shouldOpen) setOpen(true);
    }, [hasAuthoritativeOffer, location.pathname, sellerKey]);

    useEffect(() => {
        if (!open) return undefined;
        const onKeyDown = (event) => {
            if (event.key === 'Escape') setOpen(false);
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, [open]);

    const claimOffer = () => {
        setOpen(false);
        navigate(`/seller-dashboard/subscription?coupon=${encodeURIComponent(promotion.code)}`);
    };

    return (
        <AnimatePresence>
            {open && hasAuthoritativeOffer && (
                <Motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="fixed inset-0 z-[100] flex items-center justify-center bg-black/45 backdrop-blur-sm p-4"
                    onClick={() => setOpen(false)}
                    role="presentation"
                >
                    <Motion.div
                        initial={{ opacity: 0, scale: 0.96, y: 12 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.96, y: 12 }}
                        onClick={(event) => event.stopPropagation()}
                        className="glass-panel-strong w-full max-w-md p-6 relative"
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="founder-promotion-title"
                    >
                        <button
                            type="button"
                            onClick={() => setOpen(false)}
                            title="Close founder offer"
                            aria-label="Close founder offer"
                            className="absolute top-4 right-4 w-9 h-9 rounded-xl glass-inner flex items-center justify-center"
                            style={{ color: 'hsl(var(--muted-foreground))' }}
                        >
                            <X size={17} />
                        </button>

                        <div
                            className="w-12 h-12 rounded-xl flex items-center justify-center mb-4"
                            style={{ background: 'rgba(59, 130, 246, 0.12)', color: 'hsl(220, 70%, 55%)' }}
                        >
                            <Tag size={22} />
                        </div>
                        <p className="text-xs font-bold uppercase" style={{ color: 'hsl(220, 70%, 55%)' }}>
                            First 100 Sellers
                        </p>
                        <h2 id="founder-promotion-title" className="text-xl font-bold mt-1 pr-8" style={{ color: 'hsl(var(--foreground))' }}>
                            Lock in an extra {discountPercent}% off
                        </h2>
                        <p className="text-sm mt-2" style={{ color: 'hsl(var(--muted-foreground))' }}>
                            Use <strong style={{ color: 'hsl(var(--foreground))' }}>{promotion.code}</strong> to get Starter for {starterFounderPrice}/month or Elite for {eliteFounderPrice}/month.
                        </p>

                        <div className="grid grid-cols-2 gap-3 mt-5">
                            <div className="glass-inner p-3 text-center">
                                <p className="text-[10px] uppercase font-semibold" style={{ color: 'hsl(var(--muted-foreground))' }}>Starter</p>
                                <p className="text-lg font-bold" style={{ color: 'hsl(var(--foreground))' }}>{starterFounderPrice}</p>
                                <p className="text-[10px]" style={{ color: 'hsl(var(--muted-foreground))' }}>/month</p>
                            </div>
                            <div className="glass-inner p-3 text-center">
                                <p className="text-[10px] uppercase font-semibold" style={{ color: 'hsl(var(--muted-foreground))' }}>Elite</p>
                                <p className="text-lg font-bold" style={{ color: 'hsl(var(--foreground))' }}>{eliteFounderPrice}</p>
                                <p className="text-[10px]" style={{ color: 'hsl(var(--muted-foreground))' }}>/month</p>
                            </div>
                        </div>

                        <p className="text-xs font-semibold mt-4" style={{ color: 'hsl(150, 60%, 42%)' }}>
                            {promotion.sellerHasReservation
                                ? 'A founder spot is currently reserved for your account'
                                : `${promotion.remaining} of ${promotion.maxRedemptions} founder spots remaining`}
                        </p>
                        <p className="text-[11px] mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                            Your founder rate stays through plan changes and renewals while the subscription remains uninterrupted. It ends permanently if you unsubscribe.
                        </p>

                        <button
                            type="button"
                            onClick={claimOffer}
                            className="w-full mt-5 py-3 rounded-xl font-bold text-sm text-white flex items-center justify-center gap-2"
                            style={{ background: 'hsl(220, 70%, 55%)' }}
                        >
                            View Plans <ArrowRight size={16} />
                        </button>
                    </Motion.div>
                </Motion.div>
            )}
        </AnimatePresence>
    );
};

export default FounderPromotionModal;
