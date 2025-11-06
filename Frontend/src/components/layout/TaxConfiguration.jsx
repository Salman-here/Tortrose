import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { DollarSign, Percent, Ban, Save, Loader2 } from 'lucide-react';
import axios from 'axios';
import { toast } from 'react-toastify';

export default function TaxConfiguration() {
  const [taxType, setTaxType] = useState('none');
  const [taxValue, setTaxValue] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    fetchTaxConfig();
  }, []);

  const fetchTaxConfig = async () => {
    try {
      const res = await axios.get(`${import.meta.env.VITE_API_URL}api/tax/config`);
      if (res.data.success) {
        setTaxType(res.data.taxConfig.type);
        setTaxValue(res.data.taxConfig.value);
      }
    } catch (error) {
      console.error('Error fetching tax config:', error);
      toast.error('Failed to load tax configuration');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSave = async () => {
    // Validation
    if (taxValue < 0) {
      toast.error('Tax value cannot be negative');
      return;
    }

    if (taxType === 'percentage' && taxValue > 100) {
      toast.error('Percentage cannot exceed 100');
      return;
    }

    setIsSaving(true);
    try {
      const token = localStorage.getItem('jwtToken');
      const res = await axios.put(
        `${import.meta.env.VITE_API_URL}api/tax/config`,
        { type: taxType, value: parseFloat(taxValue) },
        {
          headers: {
            Authorization: `Bearer ${token}`
          }
        }
      );

      if (res.data.success) {
        toast.success('Tax configuration updated successfully');
      }
    } catch (error) {
      console.error('Error updating tax config:', error);
      toast.error(error.response?.data?.msg || 'Failed to update tax configuration');
    } finally {
      setIsSaving(false);
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
      <div className="max-w-3xl mx-auto">
        <div className="bg-white rounded-xl shadow-lg p-8">
          <div className="mb-8">
            <h1 className="text-3xl font-bold text-gray-900">Tax Configuration</h1>
            <p className="mt-2 text-gray-600">
              Configure platform-wide tax settings for all orders
            </p>
          </div>

          <div className="space-y-6">
            {/* No Tax Option */}
            <motion.div
              whileHover={{ scale: 1.02 }}
              className={`border-2 rounded-lg p-6 cursor-pointer transition-all ${
                taxType === 'none'
                  ? 'border-blue-600 bg-blue-50 ring-2 ring-blue-100'
                  : 'border-gray-300 hover:border-gray-400'
              }`}
              onClick={() => {
                setTaxType('none');
                setTaxValue(0);
              }}
            >
              <div className="flex items-center gap-4">
                <div
                  className={`p-3 rounded-full ${
                    taxType === 'none' ? 'bg-blue-100 text-blue-600' : 'bg-gray-100 text-gray-600'
                  }`}
                >
                  <Ban className="w-6 h-6" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold">No Tax</h3>
                  <p className="text-sm text-gray-600">No tax will be applied to orders</p>
                </div>
              </div>
            </motion.div>

            {/* Percentage Tax Option */}
            <motion.div
              whileHover={{ scale: 1.02 }}
              className={`border-2 rounded-lg p-6 cursor-pointer transition-all ${
                taxType === 'percentage'
                  ? 'border-blue-600 bg-blue-50 ring-2 ring-blue-100'
                  : 'border-gray-300 hover:border-gray-400'
              }`}
              onClick={() => setTaxType('percentage')}
            >
              <div className="flex items-center gap-4">
                <div
                  className={`p-3 rounded-full ${
                    taxType === 'percentage' ? 'bg-blue-100 text-blue-600' : 'bg-gray-100 text-gray-600'
                  }`}
                >
                  <Percent className="w-6 h-6" />
                </div>
                <div className="flex-1">
                  <h3 className="text-lg font-semibold">Percentage Based Tax</h3>
                  <p className="text-sm text-gray-600">Tax calculated as percentage of subtotal</p>
                </div>
              </div>
              {taxType === 'percentage' && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  className="mt-4"
                >
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Tax Percentage (0-100)
                  </label>
                  <div className="relative">
                    <input
                      type="number"
                      min="0"
                      max="100"
                      step="0.1"
                      value={taxValue}
                      onChange={(e) => setTaxValue(e.target.value)}
                      className="w-full border rounded-lg px-4 py-3 pr-10 focus:border-blue-600 outline-none"
                      placeholder="Enter percentage"
                    />
                    <Percent className="absolute right-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-gray-400" />
                  </div>
                </motion.div>
              )}
            </motion.div>

            {/* Fixed Amount Tax Option */}
            <motion.div
              whileHover={{ scale: 1.02 }}
              className={`border-2 rounded-lg p-6 cursor-pointer transition-all ${
                taxType === 'fixed'
                  ? 'border-blue-600 bg-blue-50 ring-2 ring-blue-100'
                  : 'border-gray-300 hover:border-gray-400'
              }`}
              onClick={() => setTaxType('fixed')}
            >
              <div className="flex items-center gap-4">
                <div
                  className={`p-3 rounded-full ${
                    taxType === 'fixed' ? 'bg-blue-100 text-blue-600' : 'bg-gray-100 text-gray-600'
                  }`}
                >
                  <DollarSign className="w-6 h-6" />
                </div>
                <div className="flex-1">
                  <h3 className="text-lg font-semibold">Fixed Amount Tax</h3>
                  <p className="text-sm text-gray-600">Fixed tax amount added to all orders</p>
                </div>
              </div>
              {taxType === 'fixed' && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  className="mt-4"
                >
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Tax Amount ($)
                  </label>
                  <div className="relative">
                    <DollarSign className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-gray-400" />
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={taxValue}
                      onChange={(e) => setTaxValue(e.target.value)}
                      className="w-full border rounded-lg pl-10 pr-4 py-3 focus:border-blue-600 outline-none"
                      placeholder="Enter amount"
                    />
                  </div>
                </motion.div>
              )}
            </motion.div>
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
                  Save Configuration
                </>
              )}
            </button>
          </div>

          {/* Preview */}
          <div className="mt-8 p-4 bg-gray-50 rounded-lg">
            <h4 className="font-semibold text-gray-900 mb-2">Preview</h4>
            <p className="text-sm text-gray-600">
              {taxType === 'none' && 'No tax will be applied to orders.'}
              {taxType === 'percentage' && `${taxValue}% tax will be calculated on order subtotal.`}
              {taxType === 'fixed' && `$${taxValue} tax will be added to all orders.`}
            </p>
            {taxType !== 'none' && (
              <div className="mt-3 text-sm text-gray-600">
                <p className="font-medium">Example (Subtotal: $100.00):</p>
                <p>
                  Tax:{' '}
                  {taxType === 'percentage'
                    ? `$${((100 * taxValue) / 100).toFixed(2)}`
                    : `$${parseFloat(taxValue).toFixed(2)}`}
                </p>
                <p className="font-semibold">
                  Total:{' '}
                  {taxType === 'percentage'
                    ? `$${(100 + (100 * taxValue) / 100).toFixed(2)}`
                    : `$${(100 + parseFloat(taxValue || 0)).toFixed(2)}`}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
