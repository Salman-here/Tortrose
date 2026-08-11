/**
 * Admin WhatsApp Number Controller
 * ──────────────────────────────────
 * Manages phone numbers designated as "admin" for the seller WhatsApp instance.
 * Messages from these numbers on the seller instance are treated as admin role
 * for AI chat (full platform access).
 */

const AdminWhatsAppNumber = require('../models/AdminWhatsAppNumber');
const {
    conflictMessage,
    findWhatsAppIdentityConflict,
} = require('../services/whatsappIdentityService');

const cleanNumber = (number) => String(number || '').replace(/\D/g, '');

/**
 * POST /api/whatsapp/admin-numbers
 * Add a new admin-designated WhatsApp number.
 * Body: { number, label? }
 */
exports.addAdminNumber = async (req, res) => {
    try {
        const { number, label } = req.body;
        if (!number) {
            return res.status(400).json({ success: false, msg: 'Phone number is required' });
        }

        const digits = cleanNumber(number);
        if (!digits || digits.length < 10) {
            return res.status(400).json({ success: false, msg: 'Invalid phone number format. Use country code + number (e.g. 923001234567)' });
        }

        const identityConflict = await findWhatsAppIdentityConflict(digits, { channel: 'admin' });
        if (identityConflict) {
            return res.status(409).json({ success: false, msg: conflictMessage(identityConflict) });
        }

        // Check duplicate
        const existing = await AdminWhatsAppNumber.findOne({ number: digits });
        if (existing) {
            return res.status(409).json({ success: false, msg: 'This number is already registered as an admin number.' });
        }

        const doc = await AdminWhatsAppNumber.create({
            number: digits,
            label: label || '',
            addedBy: req.user?.id || req.user?._id,
            isActive: true,
        });

        return res.status(201).json({
            success: true,
            msg: 'Admin WhatsApp number added successfully.',
            data: {
                _id: doc._id,
                number: doc.number,
                label: doc.label,
                isActive: doc.isActive,
                createdAt: doc.createdAt,
            },
        });
    } catch (error) {
        console.error('[adminWhatsappNumber] addAdminNumber error:', error.message);
        return res.status(500).json({ success: false, msg: 'Failed to add admin number.' });
    }
};

/**
 * GET /api/whatsapp/admin-numbers
 * List all admin-designated WhatsApp numbers.
 */
exports.getAdminNumbers = async (req, res) => {
    try {
        const numbers = await AdminWhatsAppNumber.find()
            .sort({ createdAt: -1 })
            .populate('addedBy', 'username email')
            .lean();

        return res.status(200).json({
            success: true,
            data: numbers.map(n => ({
                _id: n._id,
                number: n.number,
                label: n.label,
                isActive: n.isActive,
                addedBy: n.addedBy?.username || 'Unknown',
                createdAt: n.createdAt,
            })),
            count: numbers.length,
        });
    } catch (error) {
        console.error('[adminWhatsappNumber] getAdminNumbers error:', error.message);
        return res.status(500).json({ success: false, msg: 'Failed to fetch admin numbers.' });
    }
};

/**
 * DELETE /api/whatsapp/admin-numbers/:id
 * Remove an admin-designated WhatsApp number.
 */
exports.removeAdminNumber = async (req, res) => {
    try {
        const doc = await AdminWhatsAppNumber.findByIdAndDelete(req.params.id);
        if (!doc) {
            return res.status(404).json({ success: false, msg: 'Admin number not found.' });
        }

        return res.status(200).json({
            success: true,
            msg: `Admin number ${doc.number} removed.`,
        });
    } catch (error) {
        console.error('[adminWhatsappNumber] removeAdminNumber error:', error.message);
        return res.status(500).json({ success: false, msg: 'Failed to remove admin number.' });
    }
};

/**
 * PATCH /api/whatsapp/admin-numbers/:id
 * Toggle active/inactive for an admin number.
 * Body: { isActive }
 */
exports.toggleAdminNumber = async (req, res) => {
    try {
        const { isActive } = req.body;
        if (typeof isActive !== 'boolean') {
            return res.status(400).json({ success: false, msg: 'isActive (boolean) is required.' });
        }

        const existing = await AdminWhatsAppNumber.findById(req.params.id);
        if (!existing) {
            return res.status(404).json({ success: false, msg: 'Admin number not found.' });
        }
        if (isActive) {
            const identityConflict = await findWhatsAppIdentityConflict(existing.number, {
                channel: 'admin',
                adminNumberId: existing._id,
            });
            if (identityConflict) {
                return res.status(409).json({ success: false, msg: conflictMessage(identityConflict) });
            }
        }

        const doc = await AdminWhatsAppNumber.findByIdAndUpdate(
            req.params.id,
            { $set: { isActive } },
            { new: true }
        );
        return res.status(200).json({
            success: true,
            msg: `Admin number ${doc.number} is now ${isActive ? 'active' : 'inactive'}.`,
            data: { _id: doc._id, number: doc.number, isActive: doc.isActive },
        });
    } catch (error) {
        console.error('[adminWhatsappNumber] toggleAdminNumber error:', error.message);
        return res.status(500).json({ success: false, msg: 'Failed to update admin number.' });
    }
};
