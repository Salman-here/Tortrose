const Product = require('../models/Product');
const Order = require('../models/Order');
const Complaint = require('../models/Complaint');
const ChatHistory = require('../models/ChatHistory');
const Fuse = require('fuse.js');
const { publicProductFilter } = require('../services/productModerationService');
const { convertAmountSync } = require('../services/currencyService');
const { getProductCurrency, getProductEffectivePrice } = require('../services/productPricingService');
const {
    getAccountingOrderCurrency,
    requireStoredOrderMoney,
} = require('../services/orderMoneyService');

const comparablePriceUSD = (product) =>
    convertAmountSync(getProductEffectivePrice(product), getProductCurrency(product), 'USD');

// ─── Chat History CRUD ───
exports.getChatHistory = async (req, res) => {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ msg: 'Authentication required' });
    try {
        const history = await ChatHistory.findOne({ user: userId });
        res.json({ messages: history?.messages || [] });
    } catch (error) {
        console.error('Get chat history error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
};

exports.saveChatHistory = async (req, res) => {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ msg: 'Authentication required' });
    try {
        const { messages } = req.body;
        if (!Array.isArray(messages)) return res.status(400).json({ msg: 'messages must be an array' });

        // Only keep role + content, limit to 100
        const clean = messages
            .filter(m => m.role && m.content)
            .map(({ role, content }) => ({ role, content }))
            .slice(-100);

        await ChatHistory.findOneAndUpdate(
            { user: userId },
            { messages: clean, updatedAt: new Date() },
            { upsert: true, new: true }
        );
        res.json({ msg: 'Chat history saved' });
    } catch (error) {
        console.error('Save chat history error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
};

exports.clearChatHistory = async (req, res) => {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ msg: 'Authentication required' });
    try {
        await ChatHistory.findOneAndUpdate(
            { user: userId },
            { messages: [], updatedAt: new Date() }
        );
        res.json({ msg: 'Chat history cleared' });
    } catch (error) {
        console.error('Clear chat history error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
};

// Get user context for AI personalization
exports.getUserContext = async (req, res) => {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ msg: 'Authentication required' });

    try {
        const recentOrders = await Order.find({ user: userId })
            .sort({ createdAt: -1 })
            .limit(5)
            .populate('orderItems.productId', 'name category brand');

        const user = await require('../models/User').findById(userId).select('username email');

        const orderData = recentOrders.map(o => ({
            orderId: o.orderId,
            status: o.orderStatus,
            total: requireStoredOrderMoney(o.orderSummary?.totalAmount, 'order total'),
            currency: getAccountingOrderCurrency(o),
            items: o.orderItems?.map(item => item.productId?.name).filter(Boolean),
            date: o.createdAt,
        }));

        // Extract favorite categories from order history
        const categories = {};
        recentOrders.forEach(o => {
            o.orderItems?.forEach(item => {
                if (item.productId?.category) {
                    categories[item.productId.category] = (categories[item.productId.category] || 0) + 1;
                }
            });
        });
        const topCategories = Object.entries(categories)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([cat]) => cat);

        res.json({
            name: user?.username || '',
            recentOrders: orderData,
            preferences: topCategories.length > 0 ? `Frequently buys: ${topCategories.join(', ')}` : null,
        });
    } catch (error) {
        console.error('Get user context error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
};

// Chat with AI assistant
exports.chat = async (req, res) => {
    const { message, conversationHistory = [] } = req.body;
    const userId = req.user?.id;

    if (!message || !message.trim()) {
        return res.status(400).json({ msg: 'Message is required' });
    }

    try {
        // Detect intent from user message
        const lowerMsg = message.toLowerCase();

        // Intent: Product search
        if (lowerMsg.includes('find') || lowerMsg.includes('search') || lowerMsg.includes('looking for') || lowerMsg.includes('show me') || lowerMsg.includes('recommend')) {
            const products = await Product.find(publicProductFilter()).limit(100).lean();
            const fuse = new Fuse(products, {
                threshold: 0.4,
                keys: ['name', 'description', 'brand', 'tags', 'category']
            });
            const searchTerms = message.replace(/find|search|looking for|show me|recommend|under|above|\$/gi, ' ').trim();
            const results = fuse.search(searchTerms).slice(0, 5);

            // Check for price filters
            const underMatch = lowerMsg.match(/under\s*\$?(\d+)/);
            const aboveMatch = lowerMsg.match(/(above|over)\s*\$?(\d+)/);

            let filtered = results.map(r => r.item);
            if (underMatch) filtered = filtered.filter(p => comparablePriceUSD(p) <= parseInt(underMatch[1]));
            if (aboveMatch) filtered = filtered.filter(p => comparablePriceUSD(p) >= parseInt(aboveMatch[2]));

            if (filtered.length === 0) {
                // Try broader search
                const allProducts = await Product.find(publicProductFilter()).sort({ rating: -1 }).limit(5).lean();
                return res.json({
                    reply: `I couldn't find exact matches for "${searchTerms}", but here are some popular products you might like:`,
                    products: allProducts.map(p => ({
                        _id: p._id, name: p.name, price: p.price,
                        currency: getProductCurrency(p), priceCurrency: getProductCurrency(p),
                        discountedPrice: p.discountedPrice, image: p.image,
                        rating: p.rating, category: p.category, brand: p.brand
                    })),
                    intent: 'product_search'
                });
            }

            return res.json({
                reply: `I found ${filtered.length} product${filtered.length > 1 ? 's' : ''} matching your search:`,
                products: filtered.map(p => ({
                    _id: p._id, name: p.name, price: p.price,
                    currency: getProductCurrency(p), priceCurrency: getProductCurrency(p),
                    discountedPrice: p.discountedPrice, image: p.image,
                    rating: p.rating, category: p.category, brand: p.brand
                })),
                intent: 'product_search'
            });
        }

        // Intent: Cart info
        if (lowerMsg.includes('cart') || lowerMsg.includes('what\'s in my cart') || lowerMsg.includes('my cart')) {
            return res.json({
                reply: 'You can view your cart by clicking the cart icon in the top navigation bar. Would you like me to help with something else?',
                action: { type: 'open_cart' },
                intent: 'cart_info'
            });
        }

        // Intent: Track order
        if (lowerMsg.includes('track') || lowerMsg.includes('order status') || lowerMsg.includes('my order') || lowerMsg.includes('where is my')) {
            if (userId) {
                const recentOrders = await Order.find({ user: userId }).sort({ createdAt: -1 }).limit(3);
                if (recentOrders.length > 0) {
                    return res.json({
                        reply: `Here are your recent orders:`,
                        orders: recentOrders.map(o => ({
                            orderId: o.orderId, status: o.orderStatus,
                            total: requireStoredOrderMoney(o.orderSummary?.totalAmount, 'order total'),
                            currency: getAccountingOrderCurrency(o),
                            date: o.createdAt, isPaid: o.isPaid
                        })),
                        intent: 'order_tracking'
                    });
                }
                return res.json({ reply: 'You don\'t have any orders yet. Start shopping to place your first order!', intent: 'order_tracking' });
            }
            return res.json({ reply: 'Please log in to track your orders. You can log in using the button in the top navigation.', intent: 'auth_required' });
        }

        // Intent: Complaint / Report
        if (lowerMsg.includes('complaint') || lowerMsg.includes('report') || lowerMsg.includes('issue') || lowerMsg.includes('problem') || lowerMsg.includes('refund')) {
            return res.json({
                reply: 'I\'m sorry to hear you\'re having an issue. You can submit a complaint using the form below, and our team will look into it right away. You can also reach us at support@rozare.com or visit our Contact page.',
                action: { type: 'show_complaint_form' },
                intent: 'complaint',
                contactUrl: '/contact'
            });
        }

        // Intent: General AI response (fallback - actual AI handled by edge function)
        return res.json({
            reply: 'I\'m here to help! I can assist you with:\n• 🔍 Finding products (e.g., "Find red sneakers under $50")\n• 🛒 Cart information\n• 📦 Order tracking\n• 📝 Filing complaints\n• 💡 Product recommendations\n\nWhat would you like help with?',
            intent: 'general'
        });

    } catch (error) {
        console.error('Chatbot error:', error);
        res.status(500).json({ msg: 'Server error in chatbot' });
    }
};

// Submit complaint
exports.submitComplaint = async (req, res) => {
    const { category, subject, message, relatedOrder, relatedProduct } = req.body;
    const userId = req.user.id;

    if (!category || !subject || !message) {
        return res.status(400).json({ msg: 'Category, subject, and message are required' });
    }

    try {
        const complaint = new Complaint({
            user: userId,
            category,
            subject: subject.slice(0, 200),
            message: message.slice(0, 2000),
            relatedOrder: relatedOrder || undefined,
            relatedProduct: relatedProduct || undefined,
        });
        await complaint.save();

        res.status(201).json({ msg: 'Complaint submitted successfully. Our team will review it shortly.', complaint });
    } catch (error) {
        console.error('Submit complaint error:', error);
        res.status(500).json({ msg: 'Server error while submitting complaint' });
    }
};

// Get user's complaints
exports.getMyComplaints = async (req, res) => {
    const userId = req.user.id;
    try {
        const complaints = await Complaint.find({ user: userId })
            .sort({ createdAt: -1 })
            .populate('relatedOrder', 'orderId orderStatus')
              .populate([
                  { path: 'relatedProduct', select: 'name image' },
                  { path: 'report.targetUser', select: 'username avatar role status' },
                  { path: 'report.relatedStore', select: 'storeName storeSlug logo' },
                  { path: 'report.relatedReview', select: 'title comment rating user store' },
              ]);
        res.json({ complaints });
    } catch (error) {
        console.error('Get complaints error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
};

// Admin: Get all complaints
exports.getAllComplaints = async (req, res) => {
    if (req.user?.role !== 'admin') {
        return res.status(403).json({ msg: 'Access denied. Admin privileges required.' });
    }

    const { category, status, page = 1, limit = 20 } = req.query;

    try {
        const query = {};
        if (category) query.category = category;
        if (status) query.status = status;

        const skip = (parseInt(page) - 1) * parseInt(limit);
        const total = await Complaint.countDocuments(query);
        const complaints = await Complaint.find(query)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(parseInt(limit))
            .populate('user', 'username email avatar')
            .populate('relatedOrder', 'orderId orderStatus')
            .populate([
                { path: 'relatedProduct', select: 'name image' },
                { path: 'report.targetUser', select: 'username email avatar role status' },
                { path: 'report.relatedStore', select: 'storeName storeSlug logo' },
                { path: 'report.relatedReview', select: 'title comment rating user store' },
            ]);

        // Category stats
        const categoryStats = await Complaint.aggregate([
            { $group: { _id: '$category', count: { $sum: 1 } } }
        ]);
        const statusStats = await Complaint.aggregate([
            { $group: { _id: '$status', count: { $sum: 1 } } }
        ]);

        res.json({
            complaints,
            total,
            page: parseInt(page),
            totalPages: Math.ceil(total / parseInt(limit)),
            categoryStats: categoryStats.reduce((acc, s) => ({ ...acc, [s._id]: s.count }), {}),
            statusStats: statusStats.reduce((acc, s) => ({ ...acc, [s._id]: s.count }), {}),
        });
    } catch (error) {
        console.error('Get all complaints error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
};

// Admin: Update complaint
exports.updateComplaint = async (req, res) => {
    if (req.user?.role !== 'admin') {
        return res.status(403).json({ msg: 'Access denied. Admin privileges required.' });
    }

    const { id } = req.params;
    const { status, adminResponse, priority } = req.body;

    try {
        const complaint = await Complaint.findById(id);
        if (!complaint) return res.status(404).json({ msg: 'Complaint not found' });

        if (status) complaint.status = status;
        if (adminResponse) complaint.adminResponse = adminResponse;
        if (priority) complaint.priority = priority;

        await complaint.save();
        res.json({ msg: 'Complaint updated', complaint });
    } catch (error) {
        console.error('Update complaint error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
};
