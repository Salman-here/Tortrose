import React from "react";
import { motion } from "framer-motion";
import { Bot, Edit, Trash2, Star, Package, TrendingDown, ShieldAlert } from "lucide-react";
import { useCurrency } from "../../contexts/CurrencyContext";
import { inspectSellerProductPresentation } from '../../utils/productCardSafety';

const displayText = (value, fallback) => (
    typeof value === 'string' && value.trim() ? value.trim() : fallback
);

const ProductCard = ({ product, index, onEditProduct, setDeleteConfirm, displayNativeCurrency = false }) => {
    const { formatPrice } = useCurrency();
    const safeProduct = product && typeof product === 'object' && !Array.isArray(product) ? product : {};
    const presentation = inspectSellerProductPresentation(safeProduct);
    const { price, discountedPrice, stock, rating } = presentation;
    const hasDiscount = presentation.hasDiscount;
    const productCurrency = presentation.currency;
    const priceFormatOptions = {
        sourceCurrency: productCurrency,
        ...(displayNativeCurrency ? { targetCurrency: productCurrency } : {}),
    };
    const discountPercent = presentation.discountPercent;
    const canEdit = presentation.managementSafe && presentation.valid && typeof onEditProduct === 'function';
    const canDelete = presentation.managementSafe && typeof setDeleteConfirm === 'function';
    const animationIndex = Number.isSafeInteger(index) && index >= 0 ? index : 0;
    const isBlocked = safeProduct.isBlocked === true || safeProduct.moderationStatus === "blocked";
    const addedByAi = safeProduct.createdVia === "ai";
    const blockedReason = displayText(safeProduct.blockedReason, displayText(safeProduct.moderationReason, "This looks like test or placeholder product details."));
    const image = displayText(safeProduct.image, displayText(safeProduct.images?.[0]?.url, ''));
    const name = displayText(safeProduct.name, 'Untitled product');

    return (
        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: animationIndex * 0.05 }}
            className={`glass-card water-shimmer overflow-hidden flex flex-col group ${isBlocked ? "opacity-90" : ""}`}
        >
            {/* Image */}
            <div className="relative h-[220px] overflow-hidden" style={{ background: 'rgba(255,255,255,0.04)' }}>
                <motion.img
                    src={image}
                    alt={name}
                    className="h-full w-full object-contain object-center p-3 transition-transform duration-500 group-hover:scale-110"
                />
                {hasDiscount && (
                    <span className="absolute top-3 right-3 px-2.5 py-1 rounded-full text-[10px] font-bold text-white"
                        style={{ background: 'linear-gradient(135deg, hsl(0, 72%, 55%), hsl(340, 65%, 55%))' }}>
                        -{discountPercent}%
                    </span>
                )}
                {presentation.stockValid && stock === 0 && (
                    <div className="absolute inset-0 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.5)' }}>
                        <span className="px-3 py-1.5 rounded-full text-xs font-bold text-white"
                            style={{ background: 'hsl(0, 72%, 55%)' }}>
                            Out of Stock
                        </span>
                    </div>
                )}
                {isBlocked && (
                    <div className="absolute inset-0 flex items-center justify-center" style={{ background: 'rgba(15,23,42,0.62)' }}>
                        <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold text-white"
                            style={{ background: 'hsl(0, 72%, 55%)' }}>
                            <ShieldAlert size={14} />
                            Blocked
                        </span>
                    </div>
                )}

                {/* Hover Actions */}
                <div className="absolute top-3 left-3 flex flex-col gap-2 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity duration-300">
                    <motion.button whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.9 }}
                        type="button"
                        onClick={() => canEdit && onEditProduct(safeProduct)}
                        disabled={!canEdit}
                        aria-label="Edit product"
                        className="p-2 rounded-xl shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
                        style={{ background: 'var(--glass-bg-strong)', border: '1px solid var(--glass-border)', color: 'hsl(var(--primary))' }}>
                        <Edit size={16} />
                    </motion.button>
                    <motion.button whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.9 }}
                        type="button"
                        onClick={() => canDelete && setDeleteConfirm(safeProduct._id)}
                        disabled={!canDelete}
                        aria-label="Delete product"
                        className="p-2 rounded-xl shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
                        style={{ background: 'var(--glass-bg-strong)', border: '1px solid var(--glass-border)', color: 'hsl(0, 72%, 55%)' }}>
                        <Trash2 size={16} />
                    </motion.button>
                </div>
            </div>

            {/* Divider */}
            <div className="h-px" style={{ background: 'var(--glass-border)' }} />

            {/* Content */}
            <div className="p-4 flex flex-col flex-grow gap-2">
                <div>
                    <div className="flex items-start gap-2">
                        <h3 className="text-base font-semibold truncate flex-1" style={{ color: 'hsl(var(--foreground))' }}>
                            {name}
                        </h3>
                        {addedByAi && (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold shrink-0"
                                title="This product was added through Rozare AI"
                                style={{ background: 'rgba(59, 130, 246, 0.12)', color: 'hsl(220, 70%, 50%)' }}>
                                <Bot size={10} />
                                AI
                            </span>
                        )}
                        {isBlocked && (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold shrink-0"
                                style={{ background: 'rgba(239, 68, 68, 0.12)', color: 'hsl(0, 72%, 55%)' }}>
                                <ShieldAlert size={10} />
                                Blocked
                            </span>
                        )}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-xs font-medium" style={{ color: 'hsl(var(--muted-foreground))' }}>{displayText(safeProduct.brand, 'No brand')}</span>
                        <span className="w-1 h-1 rounded-full" style={{ background: 'hsl(var(--muted-foreground))' }} />
                        <span className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>{displayText(safeProduct.category, 'Uncategorized')}</span>
                    </div>
                </div>
                {isBlocked && (
                    <div className="rounded-lg px-3 py-2 text-xs leading-snug"
                        style={{ background: 'rgba(239, 68, 68, 0.08)', color: 'hsl(0, 72%, 45%)', border: '1px solid rgba(239, 68, 68, 0.22)' }}>
                        {blockedReason}
                    </div>
                )}

                {/* Price */}
                <div className="flex items-baseline gap-2">
                    {!presentation.moneyValid ? (
                        <span className="text-sm font-bold inline-flex items-center gap-1.5" role="status" style={{ color: 'hsl(0, 72%, 55%)' }}>
                            <ShieldAlert size={14} /> Price unavailable
                        </span>
                    ) : hasDiscount ? (
                        <>
                            <span className="text-lg font-extrabold" style={{ color: 'hsl(var(--foreground))', letterSpacing: '-0.03em' }}>
                                {formatPrice(discountedPrice, priceFormatOptions)}
                            </span>
                            <span className="text-sm line-through" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                {formatPrice(price, priceFormatOptions)}
                            </span>
                        </>
                    ) : (
                        <span className="text-lg font-extrabold" style={{ color: 'hsl(var(--foreground))', letterSpacing: '-0.03em' }}>
                            {formatPrice(price, priceFormatOptions)}
                        </span>
                    )}
                </div>

                {/* Stock & Rating Row */}
                <div className="flex items-center justify-between mt-auto pt-2" style={{ borderTop: '1px solid var(--glass-border-subtle)' }}>
                    <div className="flex items-center gap-1.5">
                        {!presentation.stockValid ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold"
                                style={{ background: 'rgba(239, 68, 68, 0.12)', color: 'hsl(0, 72%, 55%)' }}>
                                <ShieldAlert size={10} /> Stock unavailable
                            </span>
                        ) : stock > 0 ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold"
                                style={stock <= 10
                                    ? { background: 'rgba(245, 158, 11, 0.12)', color: 'hsl(45, 80%, 40%)' }
                                    : { background: 'rgba(16, 185, 129, 0.12)', color: 'hsl(150, 60%, 40%)' }
                                }>
                                <Package size={10} />
                                {stock <= 10 ? `Low: ${stock}` : `${stock} in stock`}
                            </span>
                        ) : (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold"
                                style={{ background: 'rgba(239, 68, 68, 0.12)', color: 'hsl(0, 72%, 55%)' }}>
                                <TrendingDown size={10} /> Out
                            </span>
                        )}
                    </div>

                    <div className="flex items-center gap-1">
                        {presentation.ratingValid ? [1, 2, 3, 4, 5].map(star => (
                                <Star key={star} size={12}
                                    style={{
                                        color: star <= rating ? 'hsl(45, 93%, 47%)' : 'hsl(var(--muted-foreground))',
                                        fill: star <= rating ? 'hsl(45, 93%, 47%)' : 'none'
                                    }} />
                            )) : (
                                <span className="text-[10px]" style={{ color: 'hsl(0, 72%, 55%)' }}>Rating unavailable</span>
                            )}
                        <span className="text-[10px] ml-0.5" style={{ color: presentation.reviewCountValid ? 'hsl(var(--muted-foreground))' : 'hsl(0, 72%, 55%)' }}>
                            {presentation.reviewCountValid ? `(${presentation.reviewCount})` : '(Reviews unavailable)'}
                        </span>
                    </div>
                </div>
            </div>
        </motion.div>
    );
};

export default ProductCard;
