import React from "react";
import { motion } from "framer-motion";
import { Edit, Trash2 } from "lucide-react";
import { useCurrency } from "../../contexts/CurrencyContext";

const ProductCard = ({ product, index, onEditProduct, setDeleteConfirm }) => {
    const { formatPrice } = useCurrency();
    return (
        <motion.div
            key={product._id}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: index * 0.05 }}
            whileHover={{ scale: 1.03 }}
            className="bg-white rounded-2xl shadow-sm hover:shadow-xl overflow-hidden flex flex-col border border-gray-100"
        >
            {/* Image */}
            <div className="relative group h-[250px] overflow-hidden">
                <motion.img
                    src={product.image}
                    alt={product.name}
                    className="h-full w-full object-contain object-center rounded p-2 transition-transform duration-500 group-hover:scale-110"
                />
                {product.discountedPrice > 0 && (
                    <span className="absolute top-2 right-2 bg-red-500 text-white text-[10px] px-2 py-1 rounded-full shadow-sm">
                        SALE
                    </span>
                )}
            </div>

            {/* Content */}
            <div className="p-4 flex flex-col flex-grow">
                {/* Title */}
                <h3 className="text-xl font-semibold text-gray-800 truncate">
                    {product.name}
                </h3>
                <p className="text-sm text-gray-500">{product.brand}</p>
                <p className="text-sm text-gray-400 mb-2">{product.category}</p>

                {/* Price */}
                <div className="mb-2">
                    {product.discountedPrice > 0 ? (
                        <div className="flex items-center gap-2">
                            <span className="text-gray-400 line-through text-md">
                                {formatPrice(product.price)}
                            </span>
                            <span className="text-red-600 font-semibold text-md">
                                {formatPrice(product.discountedPrice)}
                            </span>
                        </div>
                    ) : (
                        <span className="text-gray-900 font-semibold text-md">
                            {formatPrice(product.price)}
                        </span>
                    )}
                </div>

                {/* Stock Badge */}
                <div>

                    <span
                        className={`text-sm px-2 py-0.5 rounded-full self-start ${product.stock > 0
                            ? "bg-green-100 text-green-700"
                            : "bg-red-500 text-white"
                            }`}
                    >
                        {product.stock > 0 ? `${product.stock} in stock` : "Out of stock"}
                    </span>
                    {
                        product.stock <= 10 && product.stock !== 0 && <span className='text-sm ml-2 bg-red-400  p-1 rounded-full text-white' >Low Stock</span>
                    }
                </div>

                {/* Rating */}
                <div className="flex items-center mt-2">
                    {[1, 2, 3, 4, 5].map((star) => (
                        <motion.svg
                            key={star}
                            xmlns="http://www.w3.org/2000/svg"
                            fill={star <= product.rating ? "currentColor" : "none"}
                            viewBox="0 0 24 24"
                            strokeWidth={1.2}
                            stroke="currentColor"
                            className={`w-4 h-4 ${star <= product.rating ? "text-yellow-400" : "text-gray-300"
                                }`}
                            whileHover={{ scale: 1.2, rotate: 5 }}
                            transition={{ type: "spring", stiffness: 300 }}
                        >
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M11.48 3.5a.562.562 0 011.04 0l2.12 4.3a.56.56 0 00.42.31l4.75.69c.5.07.7.69.34 1.04l-3.43 3.34a.56.56 0 00-.16.49l.81 4.72c.08.5-.44.88-.88.65L12 17.35l-4.24 2.23c-.45.23-.97-.15-.88-.65l.81-4.72a.56.56 0 00-.16-.49L4.1 9.84a.56.56 0 01.34-1.04l4.75-.69a.56.56 0 00.42-.31L11.48 3.5z"
                            />
                        </motion.svg>
                    ))}
                    <span className="ml-1 text-xs text-gray-500">
                        ({product.numReviews})
                    </span>
                </div>

                {/* Actions */}
                <div className="flex justify-end gap-2 mt-auto pt-3">
                    <motion.button
                        whileHover={{ scale: 1.1, rotate: -5 }}
                        whileTap={{ scale: 0.9 }}
                        onClick={() => onEditProduct(product)}
                        className="p-2 rounded-full hover:bg-indigo-50 text-indigo-600 transition"
                    >
                        <Edit size={20} />
                    </motion.button>
                    <motion.button
                        whileHover={{ scale: 1.1, rotate: 5 }}
                        whileTap={{ scale: 0.9 }}
                        onClick={() => setDeleteConfirm(product._id)}
                        className="p-2 rounded-full hover:bg-red-50 text-red-600 transition"
                    >
                        <Trash2 size={20} />
                    </motion.button>
                </div>
            </div>
        </motion.div>
    );
};

export default ProductCard;