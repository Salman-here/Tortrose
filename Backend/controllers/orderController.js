// const { default: mongoose } = require('mongoose');
const Cart = require('../models/Cart');
const Order = require('../models/Order');
const Product = require('../models/Product')
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY)
const TaxConfig = require('../models/TaxConfig');
const { calculateTax } = require('./taxController');


exports.placeOrder = async (req, res) => {
    const { order } = req.body;
    // console.log(order);

    const { id: userId } = req.user;

    try {
        if (
            !order ||
            !order.orderItems ||
            !Array.isArray(order.orderItems) ||
            order.orderItems.length === 0
        ) {
            return res.status(400).json({ msg: "Order must have at least one item" });
        }

        if (
            !order.shippingInfo ||
            !order.paymentMethod ||
            !order.orderSummary ||
            !order.shippingMethod
        ) {
            return res.status(400).json({ msg: "Missing required order details" });
        }

        // console.log(order.orderItems);

        const productIds = order.orderItems.map(item => item.id)
        const productQtys = order.orderItems.map(item => item.quantity)
        // console.log(productIds);
        // return
        const orderItems = await Product.find({ _id: { $in: productIds } })
        console.log('db product items:::', orderItems);

        // Use prices from frontend (includes spin discounts)
        const subtotal = order.orderItems.reduce((acc, item) => {
            return acc + item.price * item.quantity
        }, 0)

        console.log(subtotal);

        console.log(order.shippingMethod);

        // Get shipping cost from order (already selected by user)
        const shippingCost = order.shippingMethod.price || 0;

        // Fetch tax configuration and calculate tax
        let tax = 0;
        const taxConfig = await TaxConfig.findOne({ isActive: true });
        if (taxConfig) {
            tax = calculateTax(subtotal, taxConfig);
        }

        // Final total
        const totalAmount = subtotal + shippingCost + tax;
        // console.log("cartItems::::", cartItems);


        const newOrder = new Order({
            user: userId,
            orderId: `ORD-${Date.now()}`,

            // Use order items from frontend with spin discount prices
            orderItems: order.orderItems.map((item) => ({
                productId: item.id,
                name: item.name,
                image: item.image,
                price: item.price, // Already discounted price from frontend
                originalPrice: item.originalPrice, // Original price before spin discount
                hasSpinDiscount: item.hasSpinDiscount || false, // Spin discount flag
                quantity: item.quantity,
            })),

            shippingInfo: {
                fullName: order.shippingInfo.fullName,
                email: order.shippingInfo.email,
                phone: order.shippingInfo.phone,
                address: order.shippingInfo.address,
                city: order.shippingInfo.city,
                state: order.shippingInfo.state,
                postalCode: order.shippingInfo.postalCode,
                country: order.shippingInfo.country,
            },

            shippingMethod: {
                name: order.shippingMethod.name,
                price: order.shippingMethod.price,
                estimatedDays: order.shippingMethod.estimatedDays,
                seller: order.shippingMethod.seller || null
            },

            orderSummary: {
                subtotal: subtotal,
                shippingCost: shippingCost,
                tax: tax,
                totalAmount: totalAmount,
            },

            // ✅ Schema expects just string ("stripe" | "cash_on_delivery")
            paymentMethod: order.paymentMethod,
        });
        
        // Add spin discount info if provided
        if (order.spinDiscount && order.spinDiscount.applied) {
            newOrder.spinDiscount = {
                applied: true,
                type: order.spinDiscount.type,
                value: order.spinDiscount.value,
                label: order.spinDiscount.label
            };
        }
        
        // Add seller shipping info if provided (for multi-seller orders)
        if (order.sellerShipping && Array.isArray(order.sellerShipping)) {
            newOrder.sellerShipping = order.sellerShipping;
        }
        
        if (order.instructions && order.instructions !== '') newOrder.instructions = order.instructions

        await newOrder.save();
        // console.log('new order:::', newOrder);


        // const domainURL = process.env.FRONTEND_URL || 'http://localhost:5173'

        if (newOrder.paymentMethod === 'cash_on_delivery') {
            // Reduce stock for cash on delivery orders
            for (const item of newOrder.orderItems) {
                await Product.findByIdAndUpdate(
                    item.productId,
                    { $inc: { stock: -item.quantity } }
                );
            }
            
            return res.status(200).json({
                msg: 'Order placed successfully',
            });
        }

        const line_items = [
            ...newOrder.orderItems.map(item => ({ 
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: item.name,
                        images: item.image ? [item.image] : undefined
                    },
                    unit_amount: Math.round(item.price * 100)
                },
                quantity: item.quantity
            })),


            // SHIPPING
            {
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: `${newOrder.shippingMethod.name} Shipping`,
                    },
                    unit_amount: Math.round(newOrder.shippingMethod.price * 100)
                },
                quantity: 1
            },

            // TAX (only if tax > 0)
            ...(newOrder.orderSummary.tax > 0 ? [{
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: taxConfig && taxConfig.type === 'percentage' 
                            ? `Tax (${taxConfig.value}%)` 
                            : 'Tax',
                    },
                    unit_amount: Math.round(newOrder.orderSummary.tax * 100)
                },
                quantity: 1
            }] : [])
        ]

        // console.log(line_items);

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            mode: 'payment',
            line_items,
            success_url: `${process.env.FRONTEND_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.FRONTEND_URL}/checkout`,
            metadata: { orderId: newOrder.orderId }
        })

        // console.log('session:::::', session);


        return res.status(201).json({
            id: session.id,
            url: session.url,
        });
    } catch (error) {
        console.error("Stripe session error:::", error);
        return res.status(500).json({ msg: "Server error while creating checkout session. Try again!" });
    }
}



exports.getOrders = async (req, res) => {
    const { role, id: userId } = req.user
    const { search, paymentStatus, status, startDate, endDate } = { ...req.query }
    
    console.log('=== GET ORDERS DEBUG ===');
    console.log('User role:', role);
    console.log('User ID:', userId);

    let query = {}
    if (search) {
        query.$or = [
            { "shippingInfo.fullName": { $regex: search, $options: 'i' } },
            { orderId: { $regex: search, $options: 'i' } }
        ]
    }

    if (status) {
        query.orderStatus = status
    }

    if (paymentStatus) {
        query.isPaid = paymentStatus === 'paid' ? true : false
    }

    try {
        let orders

        // If seller, only show orders containing their products
        if (role === 'seller') {
            console.log('Filtering orders for seller...');
            // First, get all seller's product IDs
            const sellerProducts = await Product.find({ seller: userId }).select('_id')
            const sellerProductIds = sellerProducts.map(p => p._id.toString())
            console.log('Seller product IDs:', sellerProductIds);

            // If seller has no products, return empty array
            if (sellerProductIds.length === 0) {
                console.log('Seller has no products - returning empty orders');
                orders = []
            } else {
                // Find orders that contain at least one of seller's products
                const allOrders = await Order.find(query)
                console.log('Total orders found:', allOrders.length);
                
                // Filter and modify orders to show only seller's portion
                orders = allOrders
                    .filter(order => {
                        const hasSellerProduct = order.orderItems.some(item => 
                            sellerProductIds.includes(item.productId.toString())
                        )
                        return hasSellerProduct
                    })
                    .map(order => {
                        // Filter order items to only seller's products
                        const sellerOrderItems = order.orderItems.filter(item => 
                            sellerProductIds.includes(item.productId.toString())
                        )
                        
                        // Calculate seller's portion
                        const sellerSubtotal = sellerOrderItems.reduce((sum, item) => 
                            sum + (item.price * item.quantity), 0
                        )
                        
                        const totalOrderValue = order.orderSummary.subtotal
                        const sellerProportion = totalOrderValue > 0 ? sellerSubtotal / totalOrderValue : 0
                        const sellerShipping = order.orderSummary.shippingCost * sellerProportion
                        const sellerTax = order.orderSummary.tax * sellerProportion
                        const sellerTotal = sellerSubtotal + sellerShipping + sellerTax
                        
                        // Return modified order with seller's portion
                        return {
                            ...order.toObject(),
                            orderItems: sellerOrderItems,
                            orderSummary: {
                                subtotal: Math.round(sellerSubtotal * 100) / 100,
                                shippingCost: Math.round(sellerShipping * 100) / 100,
                                tax: Math.round(sellerTax * 100) / 100,
                                totalAmount: Math.round(sellerTotal * 100) / 100
                            }
                        }
                    })
                console.log('Orders with seller products:', orders.length);
            }
        } else {
            console.log('Admin - showing all orders');
            // Admin sees all orders
            orders = await Order.find(query)
        }

        res.status(200).json({ msg: 'Orders fetched successfully', orders: orders })

    } catch (error) {
        console.error("Error fetching Order:", error);
        return res.status(500).json({ msg: "Server error while fetching orders" });
    }
}

exports.getUserOrders = async (req, res) => {
    const { id } = req.user
    const { search, status, paymentStatus } = req.query
    try {
        let query = {}
        if (search) {
            query.orderId = { $regex: search, $options: 'i' }
        }

        if (status) {
            query.orderStatus = status
        }

        if (paymentStatus) {
            query.isPaid = paymentStatus === 'paid' ? true : false
        }
        query.user = id

        // console.log(query);
        let orders = await Order.find(query)
        // console.log('get user ordersss:::::::::::::', orders);
        // orders = orders.find(item => item.user)


        res.status(200).json({ msg: 'User Orders fetched successfully', orders: orders })

    } catch (error) {
        console.error("Error fetching Order:", error);
        return res.status(500).json({ msg: "Server error while fetching orders" });

    }
}


exports.updateStatus = async (req, res) => {
    const { id: _id } = req.params
    const { newStatus } = req.body
    const { role, id: userId } = req.user

    try {
        const existingOrder = await Order.findById(_id)
        
        if (!existingOrder) {
            return res.status(404).json({ msg: 'Order not found' })
        }

        // If seller, check if order contains their products
        if (role === 'seller') {
            const sellerProducts = await Product.find({ seller: userId }).select('_id')
            const sellerProductIds = sellerProducts.map(p => p._id.toString())
            
            const hasSellerProduct = existingOrder.orderItems.some(item => 
                sellerProductIds.includes(item.productId.toString())
            )
            
            if (!hasSellerProduct) {
                return res.status(403).json({ msg: 'You can only update orders containing your products' })
            }
            
            // Sellers cannot cancel orders - only admin and customers can
            if (newStatus === 'cancelled') {
                return res.status(403).json({ msg: 'Only customers and admins can cancel orders. You can update the status to other values.' })
            }
        }

        let order
        if (newStatus !== 'delivered') {
            order = await Order.findByIdAndUpdate(_id, { $set: { orderStatus: newStatus } })
        }
        else {
            order = await Order.findByIdAndUpdate(_id,
                {
                    $set: {
                        orderStatus: newStatus,
                        isPaid: true,
                    }
                },
            )
        }

        await order.save()

        res.status(200).json({ msg: 'Updated status successfully' })
    } catch (error) {
        console.error(error.message);
        res.status(500).json({ msg: 'Server error while updating status' })
    }
}



exports.getOrderDetail = async (req, res) => {
    const { id } = req.params
    const { role, id: userId } = req.user
    
    console.log('=== GET ORDER DETAIL DEBUG ===');
    console.log('Order ID:', id);
    console.log('User role:', role);
    console.log('User ID:', userId);
    
    try {
        const order = await Order.findOne({ _id: id })
        
        if (!order) {
            console.log('Order not found');
            return res.status(404).json({ msg: 'Order not found' })
        }

        console.log('Order found:', order.orderId);
        console.log('Order items:', order.orderItems.map(i => ({ productId: i.productId, name: i.name })));

        // If seller, filter order items to show only their products
        if (role === 'seller') {
            const sellerProducts = await Product.find({ seller: userId }).select('_id')
            const sellerProductIds = sellerProducts.map(p => p._id.toString())
            
            console.log('Seller product IDs:', sellerProductIds);
            console.log('Order product IDs:', order.orderItems.map(i => i.productId.toString()));
            
            // Filter order items to only include seller's products
            const sellerOrderItems = order.orderItems.filter(item => 
                sellerProductIds.includes(item.productId.toString())
            )
            
            console.log('Seller order items:', sellerOrderItems.length);
            
            if (sellerOrderItems.length === 0) {
                console.log('Access denied - order does not contain seller products');
                return res.status(403).json({ msg: 'You can only view orders containing your products' })
            }
            
            // Create a modified order object with only seller's items
            const sellerSubtotal = sellerOrderItems.reduce((sum, item) => sum + (item.price * item.quantity), 0)
            
            // Calculate proportional shipping and tax based on seller's portion
            const totalOrderValue = order.orderSummary.subtotal
            const sellerProportion = totalOrderValue > 0 ? sellerSubtotal / totalOrderValue : 0
            const sellerShipping = order.orderSummary.shippingCost * sellerProportion
            const sellerTax = order.orderSummary.tax * sellerProportion
            const sellerTotal = sellerSubtotal + sellerShipping + sellerTax
            
            const filteredOrder = {
                ...order.toObject(),
                orderItems: sellerOrderItems,
                // Show only seller's portion of the order
                orderSummary: {
                    subtotal: Math.round(sellerSubtotal * 100) / 100,
                    shippingCost: Math.round(sellerShipping * 100) / 100,
                    tax: Math.round(sellerTax * 100) / 100,
                    totalAmount: Math.round(sellerTotal * 100) / 100,
                    // Keep original for reference (optional)
                    _originalTotal: order.orderSummary.totalAmount
                }
            }
            
            return res.status(200).json({ msg: 'Order fetched successfully.', order: filteredOrder })
        }

        res.status(200).json({ msg: 'Order fetched successfully.', order: order })
    } catch (error) {
        console.error(error);
        res.status(500).json({ msg: 'Server error while fetching order detail' })
    }
}


exports.cancelOrder = async (req, res) => {
    const { id: _id } = req.params
    const { role } = req.user
    
    try {
        // Only admin and customers can cancel orders, not sellers
        if (role === 'seller') {
            return res.status(403).json({ msg: 'Sellers cannot cancel orders. Only customers and admins can cancel orders.' })
        }
        
        const order = await Order.findByIdAndUpdate(_id, { $set: { orderStatus: 'cancelled' } })
        if (!order) return res.status(404).json({ msg: 'Order not found' })
        console.log(order);
        res.status(200).json({ msg: 'Order cancelled successfully.', order: order })
    } catch (error) {
        console.error(error);
        res.status(500).json({ msg: 'Server error while cancelling order' })
    }
}

