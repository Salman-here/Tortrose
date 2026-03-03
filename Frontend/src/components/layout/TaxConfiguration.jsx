import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { DollarSign, Percent, Ban, Save, Loader2 } from 'lucide-react';
import axios from 'axios';
import { toast } from 'react-toastify';
import { useCurrency } from '../../contexts/CurrencyContext';

export default function TaxConfiguration() {
  const { currency, convertPrice, convertToUSD, getCurrencySymbol } = useCurrency();
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
    <div className="min-h-screen py-12 px-4 sm:px-6 lg:px-8">
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
                    Tax Amount ({getCurrencySymbol()})
                    <span className="text-xs text-gray-500 ml-2">in {currency}</span>
                  </label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-500 font-medium">
                      {getCurrencySymbol()}
                    </span>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={convertPrice(taxValue).toFixed(2)}
                      onChange={(e) => {
                        const amountInCurrency = parseFloat(e.target.value) || 0;
                        const amountInUSD = convertToUSD(amountInCurrency);
                        setTaxValue(amountInUSD);
                      }}
                      className="w-full border rounded-lg pl-10 pr-4 py-3 focus:border-blue-600 outline-none"
                      placeholder={`Enter amount in ${currency}`}
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
              className="w-full bg-linear-to-r from-indigo-600 to-sky-500 hover:from-indigo-700 hover:to-sky-600 disabled:opacity-60 disabled:cursor-not-allowed text-white py-3 rounded-lg font-medium transition-colors flex items-center justify-center gap-2"
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
              {taxType === 'fixed' && `${getCurrencySymbol()}${convertPrice(taxValue).toFixed(2)} tax will be added to all orders.`}
            </p>
            {taxType !== 'none' && (
              <div className="mt-3 text-sm text-gray-600">
                <p className="font-medium">Example (Subtotal: {getCurrencySymbol()}{convertPrice(100).toFixed(2)}):</p>
                <p>
                  Tax: {getCurrencySymbol()}
                  {taxType === 'percentage'
                    ? `${convertPrice((100 * taxValue) / 100).toFixed(2)}`
                    : `${convertPrice(taxValue).toFixed(2)}`}
                </p>
                <p className="font-semibold">
                  Total: {getCurrencySymbol()}
                  {taxType === 'percentage'
                    ? `${convertPrice(100 + (100 * taxValue) / 100).toFixed(2)}`
                    : `${convertPrice(100 + parseFloat(taxValue || 0)).toFixed(2)}`}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
