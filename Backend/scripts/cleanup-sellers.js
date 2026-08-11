'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const { deleteAccountCascade } = require('../services/accountDeletionService');

const KEEP_SELLER_EMAIL = 'salmaniqbal2008@gmail.com';

async function cleanupSellers() {
    try {
        console.log('Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB.');

        const keepSeller = await User.findOne({
            email: KEEP_SELLER_EMAIL,
            role: 'seller',
        });

        if (!keepSeller) {
            throw new Error(`Seller to keep was not found: ${KEEP_SELLER_EMAIL}`);
        }

        const sellersToDelete = await User.find({
            role: 'seller',
            _id: { $ne: keepSeller._id },
        }).select('_id username email');

        console.log(`Keeping ${keepSeller.username} (${keepSeller.email}).`);
        console.log(`Found ${sellersToDelete.length} other seller account(s).`);

        // Use the same retry-safe cascade as admin deletion, self-deletion,
        // HTTP AI actions, and WhatsApp AI actions. It hides marketplace data
        // first, removes stale WhatsApp/admin authorizations, and intentionally
        // preserves immutable order and financial evidence.
        let deletedCount = 0;
        for (const seller of sellersToDelete) {
            console.log(`Deleting ${seller.username} (${seller.email})...`);
            const result = await deleteAccountCascade(seller._id);
            if (result.deleted) deletedCount += 1;
        }

        console.log(`Cleanup complete. Deleted ${deletedCount} seller account(s).`);
        console.log('Marketplace stores/products and operational seller state were removed.');
        console.log('Historical orders and financial evidence were preserved.');
    } catch (error) {
        console.error('Seller cleanup failed:', error);
        process.exitCode = 1;
    } finally {
        if (mongoose.connection.readyState !== 0) {
            await mongoose.connection.close();
        }
    }
}

cleanupSellers();
