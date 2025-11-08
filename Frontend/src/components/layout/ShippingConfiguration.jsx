import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Truck, Zap, Gift, Save, Loader2, Clock, DollarSign } from 'lucide-react';
import axios from 'axios';
import { toast } from 'react-toastify';
import { useCurrency } from '../../contexts/CurrencyContext';

export default function ShippingConfiguration() {
  const { currency, convertPrice, convertToUSD, getCurrencySymbol } = useCurrency();
  const [methods, setMethods] = useState([
    { type: 'free', cost: 0, deliveryDays: 5, isActive: true },
    { type: 'standard', cost: 5.99, deliveryDays: 5, isActive: false },
    { type: 'fast', cost: 12.99, deliveryDays: 2, isActive: false }
  ]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    fetchShippingMethods();
  }, []);

  const fetchShippingMethods = async () => {
    try {
      const token = localStorage.getItem('jwtToken');
      const userStr = localStorage.getItem('currentUser');
      
      if (!userStr) {
        toast.error('User not found. Please login again.');
        setIsLoading(false);
        return;
      }
      
      const user = JSON.parse(userStr);
      const userId = user._id || user.id;
      
      if (!userId) {
        toast.error('Invalid user data. Please login again.');
        setIsLoading(false);
        return;
      }
      
      const res = await axios.get(
        `${import.meta.env.VITE_API_URL}api/shipping/seller/${userId}`
      );
      
      if (res.data.success && res.data.shippingMethods.methods.length > 0) {
        setMethods(res.data.shippingMethods.methods);
      }
    } catch (error) {
      console.error('Error fetching shipping methods:', error);
      toast.error('Failed to load shipping methods');
    } finally {
      setIsLoading(false);
    }
  };

  const handleMethodChange = (type, field, value) => {
    setMethods(methods.map(method => {
      if (method.type === type) {
        // If changing cost for free shipping, keep it at 0
        if (type === 'free' && field === 'cost') {
          return method;
        }
        return { ...method, [field]: value };
      }
      return method;
    }));
  };

  const handleSave = async () => {
    // Validation
    const activeMethodsCount = methods.filter(m => m.isActive).length;
    if (activeMethodsCount === 0) {
      toast.error('At least one shipping method must be active');
      return;
    }

    // Validate each method
    for (const method of methods) {
      if (method.isActive) {
        if (method.type === 'free' && method.cost !== 0) {
          toast.error('Free shipping must have 0 cost');
          return;
        }
        if (method.type !== 'free' && method.cost <= 0) {
          toast.error('Paid shipping methods must have cost greater than 0');
          return;
        }
        if (method.deliveryDays < 1) {
          toast.error('Delivery days must be at least 1');
          return;
        }
      }
    }

    setIsSaving(true);
    try {
      const token = localStorage.getItem('jwtToken');
      const res = await axios.put(
        `${import.meta.env.VITE_API_URL}api/shipping/methods`,
        { methods },
        {
          headers: {
            Authorization: `Bearer ${token}`
          }
        }
      );

      if (res.data.success) {
        toast.success('Shipping methods updated successfully');
      }
    } catch (error) {
      console.error('Error updating shipping methods:', error);
      toast.error(error.response?.data?.msg || 'Failed to update shipping methods');
    } finally {
      setIsSaving(false);
    }
  };

  const getMethodIcon = (type) => {
    switch (type) {
      case 'free':
        return <Gift className="w-6 h-6" />;
      case 'standard':
        return <Truck className="w-6 h-6" />;
      case 'fast':
        return <Zap className="w-6 h-6" />;
      default:
        return <Truck className="w-6 h-6" />;
    }
  };

  const getMethodTitle = (type) => {
    switch (type) {
      case 'free':
        return 'Free Shipping';
      case 'standard':
        return 'Standard Shipping';
      case 'fast':
        return 'Fast Shipping';
      default:
        return type;
    }
  };

  const getMethodDescription = (type) => {
    switch (type) {
      case 'free':
        return 'No cost shipping option for customers';
      case 'standard':
        return 'Regular delivery with standard rates';
      case 'fast':
        return 'Express delivery for urgent orders';
      default:
        return '';
    }
  };

  if (isLoading) {
    return (
      <div className="flex justify-center items-center min-h-screen">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-6xl mx-auto">
        <div className="bg-white rounded-xl shadow-lg p-8">
          <div className="mb-8">
            <h1 className="text-3xl font-bold text-gray-900">Shipping Methods Configuration</h1>
            <p className="mt-2 text-gray-600">
              Configure shipping options for your products
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {methods.map((method) => (
              <motion.div
                key={method.type}
                whileHover={{ scale: 1.02 }}
                className={`border-2 rounded-lg p-6 transition-all ${
                  method.isActive
                    ? 'border-blue-600 bg-blue-50 ring-2 ring-blue-100'
                    : 'border-gray-300 bg-gray-50 opacity-60'
                }`}
              >
                {/* Header */}
                <div className="flex items-center justify-between mb-4">
                  <div
                    className={`p-3 rounded-full ${
                      method.isActive ? 'bg-blue-100 text-blue-600' : 'bg-gray-200 text-gray-500'
                    }`}
                  >
                    {getMethodIcon(method.type)}
                  </div>
                  <label className="flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={method.isActive}
                      onChange={(e) => handleMethodChange(method.type, 'isActive', e.target.checked)}
                      className="w-5 h-5 text-blue-600 rounded focus:ring-2 focus:ring-blue-500"
                    />
                    <span className="ml-2 text-sm font-medium text-gray-700">Enable</span>
                  </label>
                </div>

                {/* Title and Description */}
                <div className="flex items-center gap-2 mb-1">
                  <h3 className="text-lg font-semibold text-gray-900">
                    {getMethodTitle(method.type)}
                  </h3>
                  {method.type === 'free' && (
                    <span className="px-2 py-1 text-xs font-semibold bg-green-100 text-green-700 rounded-full">
                      Recommended
                    </span>
                  )}
                </div>
                <p className="text-sm text-gray-600 mb-4">
                  {getMethodDescription(method.type)}
                </p>

                {/* Cost Input */}
                <div className="mb-4">
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    <div className="flex items-center gap-2">
                      <DollarSign className="w-4 h-4" />
                      Shipping Cost ({getCurrencySymbol()})
                      <span className="text-xs text-gray-500">in {currency}</span>
                    </div>
                  </label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-500 font-medium">
                      {getCurrencySymbol()}
                    </span>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={method.type === 'free' ? 0 : convertPrice(method.cost).toFixed(2)}
                      onChange={(e) => {
                        const costInCurrency = parseFloat(e.target.value) || 0;
                        const costInUSD = convertToUSD(costInCurrency);
                        handleMethodChange(method.type, 'cost', costInUSD);
                      }}
                      disabled={!method.isActive || method.type === 'free'}
                      className="w-full border rounded-lg pl-9 pr-4 py-2 focus:border-blue-600 outline-none disabled:bg-gray-100 disabled:cursor-not-allowed"
                      placeholder="0.00"
                    />
                  </div>
                  {method.type === 'free' && (
                    <p className="text-xs text-gray-500 mt-1">Free shipping must be {getCurrencySymbol()}0.00</p>
                  )}
                </div>

                {/* Delivery Days Input */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    <div className="flex items-center gap-2">
                      <Clock className="w-4 h-4" />
                      Delivery Days
                    </div>
                  </label>
                  <input
                    type="number"
                    min="1"
                    value={method.deliveryDays}
                    onChange={(e) => handleMethodChange(method.type, 'deliveryDays', parseInt(e.target.value) || 1)}
                    disabled={!method.isActive}
                    className="w-full border rounded-lg px-4 py-2 focus:border-blue-600 outline-none disabled:bg-gray-100 disabled:cursor-not-allowed"
                    placeholder="Enter days"
                  />
                </div>

                {/* Preview */}
                {method.isActive && (
                  <div className="mt-4 p-3 bg-white rounded-lg border border-gray-200">
                    <p className="text-xs font-medium text-gray-700 mb-1">Preview:</p>
                    <p className="text-sm text-gray-900">
                      {getCurrencySymbol()}{convertPrice(method.cost).toFixed(2)} • {method.deliveryDays} {method.deliveryDays === 1 ? 'day' : 'days'}
                    </p>
                  </div>
                )}
              </motion.div>
            ))}
          </div>

          {/* Save Button */}
          <div className="mt-8">
            <button
              onClick={handleSave}
              disabled={isSaving}
              className="w-full bg-blue-600 text-white py-3 rounded-lg font-medium hover:bg-blue-700 disabled:bg-blue-400 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
            >
              {isSaving ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Save className="w-5 h-5" />
                  Save Shipping Methods
                </>
              )}
            </button>
          </div>

          {/* Info Box */}
          <div className="mt-6 p-4 bg-blue-50 rounded-lg border border-blue-200">
            <h4 className="font-semibold text-blue-900 mb-2">Important Notes:</h4>
            <ul className="text-sm text-blue-800 space-y-1 list-disc list-inside">
              <li>At least one shipping method must be active</li>
              <li>Free shipping must have $0.00 cost</li>
              <li>Standard and Fast shipping must have cost greater than $0</li>
              <li>Delivery days must be at least 1</li>
              <li>Customers will see these options at checkout</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
