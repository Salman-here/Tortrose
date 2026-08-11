const User = require('../models/User')
const { Readable } = require('stream')
const { cloudinary } = require('../utils/cloudinary')

const uploadBufferToCloudinary = (file, folder = 'E-Commerce') => {
    if (file?.path) return Promise.resolve(file.path);
    if (!file?.buffer) return Promise.reject(new Error('No upload buffer found'));

    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
            {
                folder,
                resource_type: 'image',
                allowed_formats: ['jpg', 'jpeg', 'png', 'gif', 'webp'],
                timeout: 30000,
            },
            (error, result) => {
                if (error) return reject(error);
                resolve(result.secure_url || result.url);
            }
        );
        Readable.from(file.buffer).pipe(stream);
    });
};

exports.profileImage = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ msg: 'No file uploaded' });
        }

        const imageUrl = await uploadBufferToCloudinary(req.file);
        await User.findByIdAndUpdate(req.user.id,
            {
                avatar: imageUrl
            },
            { new: true }
        )
        console.log('file request::::::::', req.file);

        res.json({
            message: 'Image uploaded successfully',
            imageUrl,
        });
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ msg: 'Server error during upload' });
    }
}

exports.productImage = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ msg: 'No file uploaded' });
        }

        const imageUrl = await uploadBufferToCloudinary(req.file);
        console.log('Product image uploaded:', { originalname: req.file.originalname, mimetype: req.file.mimetype, size: req.file.size, imageUrl });

        res.json({
            message: 'Product image uploaded successfully',
            imageUrl,
        });
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ msg: 'Server error during upload' });
    }
}

exports.storeImage = async (req, res) => {
    try {
        if (req.user?.role !== 'seller') {
            return res.status(403).json({ msg: 'Seller access required' });
        }
        if (!req.file) {
            return res.status(400).json({ msg: 'No file uploaded' });
        }

        const imageUrl = await uploadBufferToCloudinary(req.file, 'Rozare/Stores');
        res.json({
            message: 'Store image uploaded successfully',
            imageUrl,
        });
    } catch (error) {
        console.error('Store image upload error:', error);
        res.status(500).json({ msg: 'Server error during store image upload' });
    }
}
