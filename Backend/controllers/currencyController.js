const axios = require('axios');
const {
    CURRENCIES,
    getExchangeRateSnapshot,
    isSupportedCurrency,
    normalizeCurrency,
} = require('../services/currencyService');

const COUNTRY_CURRENCY_MAP = {
    PK: 'PKR',
    US: 'USD',
    GB: 'GBP',
    DE: 'EUR',
    FR: 'EUR',
    IT: 'EUR',
    ES: 'EUR',
};

exports.detectCurrency = async (req, res) => {
    try {
        const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
            || req.headers['x-real-ip']
            || req.connection?.remoteAddress
            || req.socket?.remoteAddress
            || '';

        if (ip === '::1' || ip === '127.0.0.1' || ip.includes('localhost')) {
            return res.status(200).json({
                success: true,
                currency: 'USD',
                country: 'US',
                detected: false,
                message: 'Localhost detected, using default USD',
            });
        }

        const geoResponse = await axios.get(
            `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,countryCode`,
            { timeout: 8000 },
        );
        if (geoResponse.data?.status === 'success') {
            const countryCode = String(geoResponse.data.countryCode || '').toUpperCase();
            return res.status(200).json({
                success: true,
                currency: COUNTRY_CURRENCY_MAP[countryCode] || 'USD',
                country: countryCode,
                countryName: geoResponse.data.country,
                detected: true,
            });
        }
    } catch (error) {
        console.error('Currency detection error:', error.message);
    }

    return res.status(200).json({
        success: true,
        currency: 'USD',
        country: 'US',
        detected: false,
        message: 'Could not detect location, using default USD',
    });
};

exports.getExchangeRates = async (_req, res) => {
    try {
        // Display clients and checkout calculations share this exact cached
        // table, avoiding different rates on either side of the API boundary.
        const snapshot = await getExchangeRateSnapshot();
        return res.status(200).json({
            success: true,
            rates: snapshot.rates,
            base: snapshot.base,
            source: snapshot.source,
            fallback: snapshot.fallback,
            lastUpdate: snapshot.capturedAt,
        });
    } catch (error) {
        console.error('Exchange rate fetch error:', error.message);
        return res.status(503).json({
            success: false,
            msg: 'Exchange rates are temporarily unavailable.',
        });
    }
};

exports.getCurrencies = (_req, res) => res.status(200).json({
    success: true,
    currencies: CURRENCIES,
});

exports.updateUserCurrency = async (req, res) => {
    const userId = req.user?.id || req.user?._id;
    const requestedCurrency = req.body?.currency;

    try {
        if (!isSupportedCurrency(requestedCurrency)) {
            return res.status(400).json({
                success: false,
                msg: 'Invalid currency code',
            });
        }

        const User = require('../models/User');
        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({
                success: false,
                msg: 'User not found',
            });
        }

        user.currency = normalizeCurrency(requestedCurrency);
        await user.save();

        return res.status(200).json({
            success: true,
            msg: 'Currency preference updated',
            currency: user.currency,
        });
    } catch (error) {
        console.error('Update currency error:', error);
        return res.status(500).json({
            success: false,
            msg: 'Server error while updating currency',
        });
    }
};
