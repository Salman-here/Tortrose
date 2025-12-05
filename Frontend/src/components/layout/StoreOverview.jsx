import React from "react";
import { motion } from "framer-motion";
import { Package, TriangleAlert, AlertCircle, Star, DollarSign } from "lucide-react";
import { useOutletContext } from "react-router-dom";
import { useCurrency } from "../../contexts/CurrencyContext";



const StoreOverview = () => {
    const { formatPrice, currency, exchangeRates, getCurrencySymbol } = useCurrency();
    const {
        products,
        orders
        // categories,
        // searchTerm,
        // setSearchTerm,
        // selectedCategory,
        // setSelectedCategory,
        // deleteConfirm,
        // setDeleteConfirm,
        // handleEditProduct,
        // handleCreateProduct,
        // handleDeleteProduct
    } = useOutletContext()

    // Format large numbers with K, M, B suffixes
    const formatCompactPrice = (amount) => {
        const usdAmount = Number(amount) || 0;
        // Convert USD to selected currency
        const rate = exchangeRates[currency] || 1;
        const convertedAmount = usdAmount * rate;
        const symbol = getCurrencySymbol();
        
        if (convertedAmount >= 1000000000) {
            return `${symbol}${(convertedAmount / 1000000000).toFixed(1)}B`;
        }
        if (convertedAmount >= 1000000) {
            return `${symbol}${(convertedAmount / 1000000).toFixed(1)}M`;
        }
        if (convertedAmount >= 10000) {
            return `${symbol}${(convertedAmount / 1000).toFixed(1)}K`;
        }
        return formatPrice(usdAmount);
    };

    console.log('📊 StoreOverview - Products:', products.length, 'Orders:', orders.length);
    
    const totalProducts = products.length;
    const outOfStock = products.filter(p => p.stock === 0).length;
    const lowStock = products.filter(p => p.stock <= 10 && p.stock !== 0).length;
    const featuredProducts = products.filter(p => p.isFeatured).length;
    const totalRevenue = orders.reduce((sum, order) => {
        if (order.isPaid === true) {
            return sum + order.orderSummary.totalAmount
        }
        return sum + 0
    }, 0);
    
    console.log('💰 Total Revenue:', totalRevenue);


    const stats = [
        { label: 'Total Products', value: totalProducts, icon: <Package size={24} />, color: 'blue' },
        { label: 'Out of Stock', value: outOfStock, icon: <TriangleAlert size={24} />, color: 'red' },
        { label: 'Low Stock', value: `${lowStock}`, icon: <AlertCircle size={24} />, color: 'red' },
        { label: 'Featured Products', value: featuredProducts, icon: <Star size={24} />, color: 'yellow' },
        { label: 'Total Revenue', value: formatCompactPrice(totalRevenue), icon: <DollarSign size={24} />, color: 'green' }
    ];

    return (
        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.3 }}
            className='p-6'
        >
            <h2 className="text-2xl font-bold text-gray-800 mb-6 mt-6">Store Overview</h2>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
                {stats.map((stat, index) => (
                    <motion.div
                        key={stat.label}
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.3, delay: index * 0.1 }}
                        className={`bg-white p-6 rounded-xl shadow-sm border border-gray-100`}
                    >
                        <div className="flex justify-between items-start">
                            <div>
                                <p className="text-sm font-medium text-gray-600">{stat.label}</p>
                                <p className="text-2xl font-bold text-gray-800 mt-1">{stat.value}</p>
                            </div>
                            <div className={`p-3 rounded-full bg-${stat.color}-100 text-${stat.color}-600`}>
                                {stat.icon}
                            </div>
                        </div>
                    </motion.div>
                ))}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.3, delay: 0.4 }}
                    className="bg-white p-6 rounded-xl shadow-sm border border-gray-100"
                >
                    <h3 className="text-lg font-semibold text-gray-800 mb-4">Recent Products</h3>
                    <div className="space-y-4">

                        {
                            products.length === 0 ? (
                                <p className=''>
                                    No products to show yet. Try adding new product.
                                </p>
                            ) :
                                products.slice(0, 3).map(product => (
                                    <div key={product._id} className="flex items-center space-x-4">
                                        <img
                                            src={product.image}
                                            alt={product.name}
                                            className="w-12 h-12 object-cover rounded-lg"
                                        />
                                        <div className="flex-1">
                                            <p className="font-medium text-gray-800">{product.name}</p>
                                            <p className="text-sm text-gray-600">{formatPrice(product.price)}</p>
                                        </div>
                                        <div className={`px-2 py-1 rounded-full text-xs font-medium ${product.stock > 0 ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                                            }`}>
                                            {product.stock > 0 ? `${product.stock} in stock` : 'Out of stock'}
                                        </div>
                                    </div>
                                ))}
                    </div>
                </motion.div>

                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.3, delay: 0.5 }}
                    className="bg-white p-6 rounded-xl shadow-sm border border-gray-100"
                >
                    <h3 className="text-lg font-semibold text-gray-800 mb-4">Top Rated Products</h3>
                    <div className="space-y-4">
                        {
                            products.length === 0 ? (
                                <p className=''>
                                    No products to show yet. Try adding new product.
                                </p>
                            ) : products
                                .filter(p => p.rating >= 4).length === 0 ? (<p className=''>
                                    No product reaches rating of 4 or above.
                                </p>) :
                                products
                                    .filter(p => p.rating >= 4)
                                    .sort((a, b) => b.rating - a.rating)
                                    .slice(0, 3)
                                    .map(product => (
                                        <div key={product._id} className="flex items-center space-x-4">
                                            <img
                                                src={product.image}
                                                alt={product.name}
                                                className="w-12 h-12 object-cover rounded-lg"
                                            />
                                            <div className="flex-1">
                                                <p className="font-medium text-gray-800">{product.name}</p>
                                                <div className="flex items-center space-x-1">
                                                    {[1, 2, 3, 4, 5].map(star => (
                                                        <Star
                                                            key={star}
                                                            size={14}
                                                            className={star <= product.rating ? 'text-yellow-400 fill-current' : 'text-gray-300'}
                                                        />
                                                    ))}
                                                    <span className="text-sm text-gray-600">({product.numReviews})</span>
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                    </div>
                </motion.div>
            </div>
        </motion.div>
    );
};

export default StoreOverview