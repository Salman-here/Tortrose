const axios = require('axios');

// Currency symbols and names
const CURRENCIES = {
    USD: { symbol: '$', name: 'US Dollar', code: 'USD' },
    PKR: { symbol: 'Rs', name: 'Pakistani Rupee', code: 'PKR' },
    EUR: { symbol: '€', name: 'Euro', code: 'EUR' },
    GBP: { symbol: '£', name: 'British Pound', code: 'GBP' }
};

// Country to currency mapping
const COUNTRY_CURRENCY_MAP = {
    'PK': 'PKR', // Pakistan
    'US': 'USD', // United States
    'GB': 'GBP', // United Kingdom
    'DE': 'EUR', 'FR': 'EUR', 'IT': 'EUR', 'ES': 'EUR', // Europe
    // Add more countries as needed
};

// Detect currency from IP address
exports.detectCurrency = async (req, res) => {
    try {
        // Get IP from request (handle proxy/forwarded IPs)
        const ip = req.headers['x-forwarded-for']?.split(',')[0] || 
                   req.headers['x-real-ip'] || 
                   req.connection.remoteAddress || 
                   req.socket.remoteAddress;
        
        console.log('Detecting currency for IP:', ip);
        
        // For localhost/development, return default
        if (ip === '::1' || ip === '127.0.0.1' || ip.includes('localhost')) {
            return res.status(200).json({
                success: true,
                currency: 'USD',
                country: 'US',
                detected: false,
                message: 'Localhost detected, using default USD'
            });
        }
        
        // Use free IP geolocation API
        const geoResponse = await axios.get(`http://ip-api.com/json/${ip}?fields=status,country,countryCode`);
        
        if (geoResponse.data.status === 'success') {
            const countryCode = geoResponse.data.countryCode;
            const currency = COUNTRY_CURRENCY_MAP[countryCode] || 'USD';
            
            console.log(`Detected country: ${countryCode}, currency: ${currency}`);
            
            return res.status(200).json({
                success: true,
                currency,
                country: countryCode,
                countryName: geoResponse.data.country,
                detected: true
            });
        }
        
        // Fallback to USD if detection fails
        return res.status(200).json({
            success: true,
            currency: 'USD',
            country: 'US',
            detected: false,
            message: 'Could not detect location, using default USD'
        });
        
    } catch (error) {
        console.error('Currency detection error:', error.message);
        // Return USD as fallback
        return res.status(200).json({
            success: true,
            currency: 'USD',
            country: 'US',
            detected: false,
            message: 'Detection failed, using default USD'
        });
    }
};

// Get exchange rates (cached for 1 hour)
let exchangeRatesCache = null;
let lastFetchTime = 0;
const CACHE_DURATION = 60 * 60 * 1000; // 1 hour

exports.getExchangeRates = async (req, res) => {
    try {
        const now = Date.now();
        
        // Return cached rates if still valid
        if (exchangeRatesCache && (now - lastFetchTime) < CACHE_DURATION) {
            return res.status(200).json({
                success: true,
                rates: exchangeRatesCache,
                cached: true,
                lastUpdate: new Date(lastFetchTime).toISOString()
            });
        }
        
        // Try multiple sources for best accuracy
        let rates = null;
        
        // Source 1: exchangerate.host (free, accurate, Google-quality data)
        try {
            const response = await axios.get('https://api.exchangerate.host/latest?base=USD&symbols=PKR,EUR,GBP');
            if (response.data.success && response.data.rates) {
                rates = {
                    USD: 1,
                    PKR: response.data.rates.PKR,
                    EUR: response.data.rates.EUR,
                    GBP: response.data.rates.GBP
                };
                console.log('✅ Fetched rates from exchangerate.host:', rates);
            }
        } catch (error) {
            console.log('⚠️ exchangerate.host failed, trying backup...');
        }
        
        // Source 2: Fallback to exchangerate-api.com
        if (!rates) {
            try {
                const response = await axios.get('https://api.exchangerate-api.com/v4/latest/USD');
                rates = {
                    USD: 1,
                    PKR: response.data.rates.PKR,
                    EUR: response.data.rates.EUR,
                    GBP: response.data.rates.GBP
                };
                console.log('✅ Fetched rates from exchangerate-api.com:', rates);
            } catch (error) {
                console.log('⚠️ exchangerate-api.com also failed');
            }
        }
        
        // Source 3: Use fallback rates if all APIs fail
        if (!rates) {
            rates = {
                USD: 1,
                PKR: 284.6,
                EUR: 0.92,
                GBP: 0.79
            };
            console.log('⚠️ Using fallback rates:', rates);
        }
        
        // Update cache
        exchangeRatesCache = rates;
        lastFetchTime = now;
        
        return res.status(200).json({
            success: true,
            rates,
            cached: false,
            lastUpdate: new Date(now).toISOString()
        });
        
    } catch (error) {
        console.error('Exchange rate fetch error:', error.message);
        
        // Return fallback rates if API fails
        const fallbackRates = {
            USD: 1,
            PKR: 284.6, // Updated to current rate
            EUR: 0.92,
            GBP: 0.79
        };
        
        return res.status(200).json({
            success: true,
            rates: fallbackRates,
            cached: false,
            fallback: true,
            message: 'Using fallback rates'
        });
    }
};

// Get available currencies
exports.getCurrencies = (req, res) => {
    return res.status(200).json({
        success: true,
        currencies: CURRENCIES
    });
};

// Update user currency preference
exports.updateUserCurrency = async (req, res) => {
    const { id: userId } = req.user;
    const { currency } = req.body;
    
    try {
        if (!currency || !CURRENCIES[currency]) {
            return res.status(400).json({
                success: false,
                msg: 'Invalid currency code'
            });
        }
        
        const User = require('../models/User');
        const user = await User.findById(userId);
        
        if (!user) {
            return res.status(404).json({
                success: false,
                msg: 'User not found'
            });
        }
        
        user.currency = currency;
        await user.save();
        
        return res.status(200).json({
            success: true,
            msg: 'Currency preference updated',
            currency
        });
        
    } catch (error) {
        console.error('Update currency error:', error);
        return res.status(500).json({
            success: false,
            msg: 'Server error while updating currency'
        });
    }
};
