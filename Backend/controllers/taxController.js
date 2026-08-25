const TaxConfig = require('../models/TaxConfig');
const { isSupportedCurrency, normalizeCurrency } = require('../services/currencyService');
const { percentageOfMoney, roundMoney } = require('../services/moneyMath');
const { parseStrictFiniteNumber } = require('../services/numericInputService');

// Get current tax configuration (public)
const getTaxConfig = async (req, res) => {
  try {
    let taxConfig = await TaxConfig.findOne({ isActive: true });
    
    // If no config exists, create default one
    if (!taxConfig) {
      taxConfig = await TaxConfig.create({
        type: 'none',
        value: 0,
        currency: 'USD',
        isActive: true
      });
    }
    
    res.status(200).json({
      success: true,
      taxConfig
    });
  } catch (error) {
    console.error('Error fetching tax config:', error);
    res.status(500).json({
      success: false,
      msg: 'Failed to fetch tax configuration'
    });
  }
};

// Update tax configuration (admin only)
const updateTaxConfig = async (req, res) => {
  try {
    const { type, value, currency = 'USD' } = req.body;
    
    // Validation
    if (!type || !['none', 'percentage', 'fixed'].includes(type)) {
      return res.status(400).json({
        success: false,
        msg: 'Invalid tax type. Must be none, percentage, or fixed'
      });
    }
    
    if (
      value === null
      || value === undefined
      || typeof value === 'boolean'
      || (typeof value === 'string' && !value.trim())
    ) {
      return res.status(400).json({
        success: false,
        msg: 'Tax value must be a non-negative number'
      });
    }

    const numericValue = parseStrictFiniteNumber(value);
    if (numericValue === null || numericValue < 0) {
      return res.status(400).json({
        success: false,
        msg: 'Tax value must be a non-negative number'
      });
    }
    
    if (type === 'percentage') {
      if (numericValue > 100) {
        return res.status(400).json({
          success: false,
          msg: 'Percentage value cannot exceed 100'
        });
      }
      if (roundMoney(numericValue, 6) !== numericValue) {
        return res.status(400).json({
          success: false,
          msg: 'Percentage tax may use at most six decimal places',
        });
      }
    }

    if (type === 'fixed' && !isSupportedCurrency(currency)) {
      return res.status(400).json({
        success: false,
        msg: 'Choose a supported currency for the fixed tax'
      });
    }

    const taxCurrency = type === 'fixed' ? normalizeCurrency(currency) : 'USD';
    let storedValue = type === 'none' ? 0 : numericValue;
    if (type === 'fixed') {
      try {
        storedValue = roundMoney(numericValue);
      } catch (error) {
        if (
          error?.code === 'MONEY_AMOUNT_OUT_OF_RANGE'
          || error?.code === 'MONEY_AMOUNT_INVALID'
        ) {
          return res.status(400).json({
            success: false,
            msg: 'Tax value is too large'
          });
        }
        throw error;
      }
      if (storedValue !== numericValue) {
        return res.status(400).json({
          success: false,
          msg: 'Fixed tax must use an exact amount to the nearest cent',
        });
      }
    }
    
    // Find existing config or create new one
    let taxConfig = await TaxConfig.findOne({ isActive: true });
    
    if (taxConfig) {
      taxConfig.type = type;
      taxConfig.value = storedValue;
      taxConfig.currency = taxCurrency;
      taxConfig.updatedBy = req.user._id || req.user.id;
      await taxConfig.save();
    } else {
      taxConfig = await TaxConfig.create({
        type,
        value: storedValue,
        currency: taxCurrency,
        isActive: true,
        updatedBy: req.user._id || req.user.id
      });
    }
    
    res.status(200).json({
      success: true,
      msg: 'Tax configuration updated successfully',
      taxConfig
    });
  } catch (error) {
    if (error.name === 'VersionError' || error.code === 11000) {
      return res.status(409).json({
        success: false,
        msg: 'The tax configuration changed while your update was being saved. Refresh it and retry.',
        code: 'TAX_CONFIG_UPDATE_CONFLICT',
      });
    }
    console.error('Error updating tax config:', error);
    res.status(500).json({
      success: false,
      msg: 'Failed to update tax configuration'
    });
  }
};

// Calculate tax amount based on subtotal
const calculateTax = (subtotal, taxConfig) => {
  if (!taxConfig || taxConfig.type === 'none') {
    return 0;
  }
  
  if (taxConfig.type === 'percentage') {
    return percentageOfMoney(subtotal, taxConfig.value);
  }
  
  if (taxConfig.type === 'fixed') {
    return taxConfig.value;
  }
  
  return 0;
};

module.exports = {
  getTaxConfig,
  updateTaxConfig,
  calculateTax
};
