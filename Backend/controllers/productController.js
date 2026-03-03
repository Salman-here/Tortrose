// const { default: Fuse } = require("fuse.js")
const Product = require("../models/Product")
const Fuse = require('fuse.js')


exports.getProducts = async (req, res) => {
    const { categories, brands, priceRange, search, page = 1, limit = 12 } = { ...req.query }
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(50, Math.max(1, parseInt(limit, 10) || 12));
    const skip = (pageNum - 1) * limitNum;

    try {
        let query = {}
        if (categories) query.category = Array.isArray(categories) ? { $in: categories } : categories
        if (brands) query.brand = Array.isArray(brands) ? { $in: brands } : brands
        if (priceRange) {
            const [min, max] = priceRange.split(',')
            query.price = { $gte: Number(min), $lte: Number(max) }
        }

        let products = await Product.find(query)

        // Apply fuzzy search with Fuse.js if search term is present
        if (search) {
            const fuse = new Fuse(products, {
                threshold: 0.4,
                keys: ['name', 'description', 'brand', 'tags', 'category']
            })
            const results = fuse.search(search)
            products = results.map(r => r.item)
        }

        const totalProducts = products.length;
        const totalPages = Math.ceil(totalProducts / limitNum);
        const paginatedProducts = products.slice(skip, skip + limitNum);

        res.status(200).json({
            msg: 'fetched products successfully.',
            products: paginatedProducts,
            pagination: {
                page: pageNum,
                limit: limitNum,
                totalProducts,
                totalPages,
                hasMore: pageNum < totalPages,
            }
        })
    } catch (error) {
        console.error('Server error while fetching products:::', error.message);
        res.status(500).json({ msg: 'Server error while fetching products.' })
    }
}

exports.getSingleProduct = async (req, res) => {
    const { id } = req.params
    // console.log('id:', id)
    try {
        const singleProduct = await Product.findById(id)
        await singleProduct.populate({
            path: 'reviews.user',
            select: 'avatar username email'
        })
        // console.log('singleProduct:', singleProduct);
        res.status(200).json({ msg: 'fetched single product', product: singleProduct })
    } catch (err) {
        console.error(err)
    }
}


exports.getFilters = async (req, res) => {
    try {
        const categories = await Product.distinct('category')
        const brands = await Product.distinct('brand')
        // console.log('categories:', categories, 'brands:', brands);
        res.status(200).json({ categories, brands })
    } catch (err) {
        console.error(err)
        res.status(500).json({ error: err })
    }
}

// Add Review to Product (Authenticated Users) 
exports.addReview = async (req, res) => {
    const { rating, comment } = req.body
    const { id: prodId } = req.params 
    

    const userId = req.user.id

    try {
        const product = await Product.findById(prodId)

        product.reviews.push({
            user: userId,
            rating: rating,
            comment: comment
        })

        await product.populate({
            path: 'reviews.user',
            select: 'username email'
        })


        product.calculateRating()
        await product.save()
        res.status(200).json({ msg: 'Review added', product: product })
    } catch (error) {
        console.error('Error while adding review:::', error.message);
        res.status(500).json({ msg: 'Server error while adding review.' })
    }
};


exports.deleteProduct = async (req, res) => {
    console.log(req.user);
    const { role, id: userId } = req.user
    const { id } = req.params
    console.log('delete product id:::', req.params.id);
    
    if (role !== 'admin' && role !== 'seller') {
        return res.status(403).json({ msg: 'Unauthorized to delete product' })
    }

    try {
        const product = await Product.findById(id)
        
        if (!product) {
            return res.status(404).json({ msg: 'Product not found' })
        }
        
        // Sellers can only delete their own products
        if (role === 'seller' && product.seller?.toString() !== userId) {
            return res.status(403).json({ msg: 'You can only delete your own products' })
        }
        
        await Product.findByIdAndDelete({ _id: id })
        console.log('product:::', product);
        res.status(200).json({ msg: 'Product deleted successfully' })
    } catch (error) {
        console.error(error.message);
        res.status(500).json({ msg: 'Server error while deleting product' })
    }

}

exports.editProduct = async (req, res) => {
    try {
        const { id } = req.params
        const { product } = req.body
        const { role, id: userId } = req.user
        console.log(role);

        if (role !== 'admin' && role !== 'seller') {
            return res.status(403).json({ msg: 'Unauthorized to edit product' })
        }
        
        const existingProduct = await Product.findById(id)
        
        if (!existingProduct) {
            return res.status(404).json({ msg: 'Product not found' })
        }
        
        // Sellers can only edit their own products
        if (role === 'seller' && existingProduct.seller?.toString() !== userId) {
            return res.status(403).json({ msg: 'You can only edit your own products' })
        }
        
        console.log(req.body);
        const updatedProduct = await Product.findByIdAndUpdate(id,
            { $set: product },
            { new: true, runValidators: true }
        )

        res.status(200).json({ msg: 'Product updated successfully.' })

    } catch (error) {
        console.error(error.message);
        res.status(500).json({ msg: 'Server error while editing product.' })
    }
}

exports.addProduct = async (req, res) => {
    const { product } = req.body
    const { role, id: userId } = req.user
    console.log('=== ADD PRODUCT DEBUG ===');
    console.log('User role:', role);
    console.log('User ID:', userId);
    console.log('Product data:', product);

    try {
        if (role !== 'admin' && role !== 'seller') {
            console.log('Authorization failed - role is:', role);
            return res.status(403).json({ msg: 'Unauthorized to add product' })
        }
        
        const newProduct = new Product({
            ...product,
            seller: role === 'seller' ? userId : null // Only set seller for seller role
        })
        console.log('New product object:', newProduct);
        await newProduct.save()
        console.log('Product saved successfully');
        res.status(200).json({ msg: 'Product added successfully.' })

    } catch (error) {
        console.error(error.message);
        res.status(500).json({ msg: 'Server error while adding new product.' })
    }
}

exports.bulkDiscount = async (req, res) => {
    const { role, id: userId } = req.user
    const { productIds, discountType, discountValue } = req.body

    try {
        if (role !== 'admin' && role !== 'seller') {
            return res.status(403).json({ msg: 'Unauthorized to apply bulk discount' })
        }

        // Validate input
        if (!productIds || !Array.isArray(productIds) || productIds.length === 0) {
            return res.status(400).json({ msg: 'Product IDs array is required' })
        }

        if (!discountType || !['percentage', 'fixed'].includes(discountType)) {
            return res.status(400).json({ msg: 'Discount type must be "percentage" or "fixed"' })
        }

        if (discountValue === undefined || discountValue < 0) {
            return res.status(400).json({ msg: 'Valid discount value is required' })
        }

        // Build query - sellers can only update their own products
        const query = { _id: { $in: productIds } }
        if (role === 'seller') {
            query.seller = userId
        }

        // Fetch all products to update
        const products = await Product.find(query)

        if (products.length === 0) {
            return res.status(404).json({ msg: 'No products found or you do not have permission to update these products' })
        }

        // Apply discount to each product
        const updatePromises = products.map(async (product) => {
            let newDiscountedPrice

            if (discountType === 'percentage') {
                // Apply percentage discount
                const discountAmount = (product.price * discountValue) / 100
                newDiscountedPrice = Math.max(0, product.price - discountAmount)
            } else {
                // Apply fixed amount discount
                newDiscountedPrice = Math.max(0, product.price - discountValue)
            }

            product.discountedPrice = Math.round(newDiscountedPrice * 100) / 100
            return product.save()
        })

        await Promise.all(updatePromises)

        res.status(200).json({ 
            msg: `Bulk discount applied successfully to ${products.length} product(s)`,
            updatedCount: products.length
        })

    } catch (error) {
        console.error('Error while applying bulk discount:::', error.message);
        res.status(500).json({ msg: 'Server error while applying bulk discount.' })
    }
}

exports.bulkPriceUpdate = async (req, res) => {
    const { role, id: userId } = req.user
    const { productIds, updateType, value } = req.body

    try {
        if (role !== 'admin' && role !== 'seller') {
            return res.status(403).json({ msg: 'Unauthorized to update bulk prices' })
        }

        // Validate input
        if (!productIds || !Array.isArray(productIds) || productIds.length === 0) {
            return res.status(400).json({ msg: 'Product IDs array is required' })
        }

        if (!updateType || !['percentage', 'fixed', 'set'].includes(updateType)) {
            return res.status(400).json({ msg: 'Update type must be "percentage", "fixed", or "set"' })
        }

        if (value === undefined) {
            return res.status(400).json({ msg: 'Value is required' })
        }

        // Build query - sellers can only update their own products
        const query = { _id: { $in: productIds } }
        if (role === 'seller') {
            query.seller = userId
        }

        // Fetch all products to update
        const products = await Product.find(query)

        if (products.length === 0) {
            return res.status(404).json({ msg: 'No products found or you do not have permission to update these products' })
        }

        // Update price for each product
        const updatePromises = products.map(async (product) => {
            let newPrice

            if (updateType === 'percentage') {
                // Increase/decrease by percentage
                const changeAmount = (product.price * value) / 100
                newPrice = Math.max(0, product.price + changeAmount)
            } else if (updateType === 'fixed') {
                // Increase/decrease by fixed amount
                newPrice = Math.max(0, product.price + value)
            } else {
                // Set to specific price
                newPrice = Math.max(0, value)
            }

            product.price = Math.round(newPrice * 100) / 100
            
            // Reset discounted price if it's higher than new price
            if (product.discountedPrice > 0 && product.discountedPrice >= product.price) {
                product.discountedPrice = 0
            }

            return product.save()
        })

        await Promise.all(updatePromises)

        res.status(200).json({ 
            msg: `Bulk price update applied successfully to ${products.length} product(s)`,
            updatedCount: products.length
        })

    } catch (error) {
        console.error('Error while updating bulk prices:::', error.message);
        res.status(500).json({ msg: 'Server error while updating bulk prices.' })
    }
}

exports.removeDiscount = async (req, res) => {
    const { role, id: userId } = req.user
    const { productIds } = req.body

    try {
        if (role !== 'admin' && role !== 'seller') {
            return res.status(403).json({ msg: 'Unauthorized to remove discounts' })
        }

        // Validate input
        if (!productIds || !Array.isArray(productIds) || productIds.length === 0) {
            return res.status(400).json({ msg: 'Product IDs array is required' })
        }

        // Build query - sellers can only update their own products
        const query = { _id: { $in: productIds } }
        if (role === 'seller') {
            query.seller = userId
        }

        // Update all products to remove discount
        const result = await Product.updateMany(
            query,
            { $set: { discountedPrice: 0 } }
        )

        res.status(200).json({ 
            msg: `Discounts removed successfully from ${result.modifiedCount} product(s)`,
            updatedCount: result.modifiedCount
        })

    } catch (error) {
        console.error('Error while removing discounts:::', error.message);
        res.status(500).json({ msg: 'Server error while removing discounts.' })
    }
}

// Get seller's products
exports.getSellerProducts = async (req, res) => {
    const { role, id: userId } = req.user
    const { categories, brands, priceRange, search } = { ...req.query }

    try {
        if (role !== 'seller') {
            return res.status(403).json({ msg: 'Only sellers can access this endpoint' })
        }

        let query = { seller: userId }
        
        if (categories) query.category = Array.isArray(categories) ? { $in: categories } : categories
        if (brands) query.brand = Array.isArray(brands) ? { $in: brands } : brands
        if (priceRange) {
            const [min, max] = priceRange.split(',')
            query.price = { $gte: Number(min), $lte: Number(max) }
        }

        let products = await Product.find(query)

        if (search) {
            const fuse = new Fuse(products, {
                threshold: 0.4,
                keys: ['name', 'description', 'brand', 'tags', 'category']
            })

            const results = fuse.search(search)
            products = results.map(r => r.item)
        }

        res.status(200).json({ msg: 'Fetched seller products successfully.', products: products })
    } catch (error) {
        console.error('Server error while fetching seller products:::', error.message);
        res.status(500).json({ msg: 'Server error while fetching seller products.' })
    }
}