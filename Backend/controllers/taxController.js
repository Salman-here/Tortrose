const TaxConfig = require('../models/TaxConfig');

// Get current tax configuration (public)
const getTaxConfig = async (req, res) => {
  try {
    let taxConfig = await TaxConfig.findOne({ isActive: true });
    
    // If no config exists, create default one
    if (!taxConfig) {
      taxConfig = await TaxConfig.create({
        type: 'none',
        value: 0,
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
    const { type, value } = req.body;
    
    // Validation
    if (!type || !['none', 'percentage', 'fixed'].includes(type)) {
      return res.status(400).json({
        success: false,
        msg: 'Invalid tax type. Must be none, percentage, or fixed'
      });
    }
    
    if (value === undefined || value < 0) {
      return res.status(400).json({
        success: false,
        msg: 'Tax value must be a non-negative number'
      });
    }
    
    if (type === 'percentage' && value > 100) {
      return res.status(400).json({
        success: false,
        msg: 'Percentage value cannot exceed 100'
      });
    }
    
    // Find existing config or create new one
    let taxConfig = await TaxConfig.findOne({ isActive: true });
    
    if (taxConfig) {
      taxConfig.type = type;
      taxConfig.value = value;
      taxConfig.updatedBy = req.user._id || req.user.id;
      await taxConfig.save();
    } else {
      taxConfig = await TaxConfig.create({
        type,
        value,
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
    return (subtotal * taxConfig.value) / 100;
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
