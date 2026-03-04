import React from "react";
import { motion } from "framer-motion";
import { Edit, Trash2, Star, Package, TrendingDown } from "lucide-react";
import { useCurrency } from "../../contexts/CurrencyContext";

const ProductCard = ({ product, index, onEditProduct, setDeleteConfirm }) => {
    const { formatPrice } = useCurrency();
    const hasDiscount = product.discountedPrice > 0;
    const discountPercent = hasDiscount ? Math.round(((product.price - product.discountedPrice) / product.price) * 100) : 0;

    return (
        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: index * 0.05 }}
            className="glass-card water-shimmer overflow-hidden flex flex-col group"
        >
            {/* Image */}
            <div className="relative h-[220px] overflow-hidden" style={{ background: 'rgba(255,255,255,0.04)' }}>
                <motion.img
                    src={product.image}
                    alt={product.name}
                    className="h-full w-full object-contain object-center p-3 transition-transform duration-500 group-hover:scale-110"
                />
                {hasDiscount && (
                    <span className="absolute top-3 right-3 px-2.5 py-1 rounded-full text-[10px] font-bold text-white"
                        style={{ background: 'linear-gradient(135deg, hsl(0, 72%, 55%), hsl(340, 65%, 55%))' }}>
                        -{discountPercent}%
                    </span>
                )}
                {product.stock === 0 && (
                    <div className="absolute inset-0 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(2px)' }}>
                        <span className="px-3 py-1.5 rounded-full text-xs font-bold text-white"
                            style={{ background: 'hsl(0, 72%, 55%)' }}>
                            Out of Stock
                        </span>
                    </div>
                )}

                {/* Hover Actions */}
                <div className="absolute top-3 left-3 flex flex-col gap-2 opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                    <motion.button whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.9 }}
                        onClick={() => onEditProduct(product)}
                        className="p-2 rounded-xl shadow-lg"
                        style={{ background: 'var(--glass-bg-strong)', backdropFilter: 'blur(16px)', border: '1px solid var(--glass-border)', color: 'hsl(var(--primary))' }}>
                        <Edit size={16} />
                    </motion.button>
                    <motion.button whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.9 }}
                        onClick={() => setDeleteConfirm(product._id)}
                        className="p-2 rounded-xl shadow-lg"
                        style={{ background: 'var(--glass-bg-strong)', backdropFilter: 'blur(16px)', border: '1px solid var(--glass-border)', color: 'hsl(0, 72%, 55%)' }}>
                        <Trash2 size={16} />
                    </motion.button>
                </div>
            </div>

            {/* Divider */}
            <div className="h-px" style={{ background: 'var(--glass-border)' }} />

            {/* Content */}
            <div className="p-4 flex flex-col flex-grow gap-2">
                <div>
                    <h3 className="text-base font-semibold truncate" style={{ color: 'hsl(var(--foreground))' }}>
                        {product.name}
                    </h3>
                    <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-xs font-medium" style={{ color: 'hsl(var(--muted-foreground))' }}>{product.brand}</span>
                        <span className="w-1 h-1 rounded-full" style={{ background: 'hsl(var(--muted-foreground))' }} />
                        <span className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>{product.category}</span>
                    </div>
                </div>

                {/* Price */}
                <div className="flex items-baseline gap-2">
                    {hasDiscount ? (
                        <>
                            <span className="text-lg font-extrabold" style={{ color: 'hsl(var(--foreground))', letterSpacing: '-0.03em' }}>
                                {formatPrice(product.discountedPrice)}
                            </span>
                            <span className="text-sm line-through" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                {formatPrice(product.price)}
                            </span>
                        </>
                    ) : (
                        <span className="text-lg font-extrabold" style={{ color: 'hsl(var(--foreground))', letterSpacing: '-0.03em' }}>
                            {formatPrice(product.price)}
                        </span>
                    )}
                </div>

                {/* Stock & Rating Row */}
                <div className="flex items-center justify-between mt-auto pt-2" style={{ borderTop: '1px solid var(--glass-border-subtle)' }}>
                    <div className="flex items-center gap-1.5">
                        {product.stock > 0 ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold"
                                style={product.stock <= 10
                                    ? { background: 'rgba(245, 158, 11, 0.12)', color: 'hsl(45, 80%, 40%)' }
                                    : { background: 'rgba(16, 185, 129, 0.12)', color: 'hsl(150, 60%, 40%)' }
                                }>
                                <Package size={10} />
                                {product.stock <= 10 ? `Low: ${product.stock}` : `${product.stock} in stock`}
                            </span>
                        ) : (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold"
                                style={{ background: 'rgba(239, 68, 68, 0.12)', color: 'hsl(0, 72%, 55%)' }}>
                                <TrendingDown size={10} /> Out
                            </span>
                        )}
                    </div>

                    <div className="flex items-center gap-1">
                        {[1, 2, 3, 4, 5].map(star => (
                            <Star key={star} size={12}
                                style={{
                                    color: star <= product.rating ? 'hsl(45, 93%, 47%)' : 'hsl(var(--muted-foreground))',
                                    fill: star <= product.rating ? 'hsl(45, 93%, 47%)' : 'none'
                                }} />
                        ))}
                        <span className="text-[10px] ml-0.5" style={{ color: 'hsl(var(--muted-foreground))' }}>
                            ({product.numReviews})
                        </span>
                    </div>
                </div>
            </div>
        </motion.div>
    );
};

export default ProductCard;
