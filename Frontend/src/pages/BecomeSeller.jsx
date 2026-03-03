import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Store, ArrowLeft, Sparkles, CheckCircle, TrendingUp, Shield, BarChart3, Phone, MapPin } from 'lucide-react';
import { toast } from 'react-toastify';
import axios from 'axios';
import { useAuth } from '../contexts/AuthContext';

export default function BecomeSeller() {
  const navigate = useNavigate();
  const { currentUser, fetchAndUpdateCurrentUser } = useAuth();
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({
    phoneNumber: '',
    address: '',
    city: '',
    country: '',
    businessName: ''
  });

  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleBecomeSeller = async (e) => {
    e.preventDefault();
    
    // Validate phone number
    if (!formData.phoneNumber || formData.phoneNumber.trim().length < 10) {
      toast.error('Please enter a valid phone number (at least 10 digits)');
      return;
    }

    // Validate address
    if (!formData.address || formData.address.trim().length < 5) {
      toast.error('Please enter a valid address');
      return;
    }

    // Validate city
    if (!formData.city || formData.city.trim().length < 2) {
      toast.error('Please enter your city');
      return;
    }

    // Validate country
    if (!formData.country || formData.country.trim().length < 2) {
      toast.error('Please enter your country');
      return;
    }

    setLoading(true);

    try {
      const token = localStorage.getItem('jwtToken');

      const res = await axios.post(
        `${import.meta.env.VITE_API_URL}api/user/become-seller`,
        {
          phoneNumber: formData.phoneNumber.trim(),
          address: formData.address.trim(),
          city: formData.city.trim(),
          country: formData.country.trim(),
          businessName: formData.businessName.trim()
        },
        {
          headers: {
            Authorization: `Bearer ${token}`
          }
        }
      );

      // Save the new token with updated role
      if (res.data.token) {
        localStorage.setItem('jwtToken', res.data.token);
      }

      toast.success('🎉 Congratulations! You are now a seller!');
      
      // Refresh user data to update role
      await fetchAndUpdateCurrentUser();
      
      // Redirect to seller dashboard and reload to ensure fresh data
      setTimeout(() => {
        window.location.href = '/seller-dashboard/store-overview';
      }, 1500);
      
    } catch (error) {
      console.error('Error becoming seller:', error);
      toast.error(error.response?.data?.message || 'Failed to create seller account');
    } finally {
      setLoading(false);
    }
  };

  // Redirect if already a seller or admin
  if (currentUser?.role === 'seller' || currentUser?.role === 'admin') {
    navigate('/');
    return null;
  }

  return (
    <div className="min-h-screen py-12 px-4">
      <div className="max-w-4xl mx-auto">
        {/* Back Button */}
        <button
          onClick={() => navigate(-1)}
          className="flex items-center gap-2 text-gray-600 hover:text-gray-800 mb-6 transition-colors"
        >
          <ArrowLeft size={20} />
          <span>Back</span>
        </button>

        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center mb-8"
        >
          <div className="flex justify-center mb-4">
            <div className="bg-linear-to-r from-indigo-600 to-sky-500 p-4 rounded-full shadow-lg shadow-indigo-300/40">
              <Store size={48} className="text-white" />
            </div>
          </div>
          <h1 className="text-4xl sm:text-5xl font-bold bg-linear-to-r from-indigo-600 to-sky-500 bg-clip-text text-transparent mb-3">
            Become a Seller - FREE
          </h1>
          <p className="text-gray-600 text-lg max-w-2xl mx-auto mb-2">
            Join thousands of successful sellers and start your e-commerce journey today
          </p>
          <p className="text-green-600 font-bold text-xl">
            🎁 Create your store for FREE - No hidden costs!
          </p>
        </motion.div>

        {/* Benefits Grid */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="grid md:grid-cols-3 gap-6 mb-8"
        >
          <div className="bg-white/80 backdrop-blur-sm rounded-2xl shadow-md border border-white/60 p-6 text-center">
            <div className="bg-indigo-100 w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4">
              <TrendingUp size={32} className="text-indigo-600" />
            </div>
            <h3 className="text-xl font-bold mb-2">Grow Your Business</h3>
            <p className="text-gray-600 text-sm">
              Reach millions of customers and scale your sales
            </p>
          </div>

          <div className="bg-white/80 backdrop-blur-sm rounded-2xl shadow-md border border-white/60 p-6 text-center">
            <div className="bg-sky-100 w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4">
              <Shield size={32} className="text-sky-600" />
            </div>
            <h3 className="text-xl font-bold mb-2">Secure Platform</h3>
            <p className="text-gray-600 text-sm">
              Safe payments and buyer protection guaranteed
            </p>
          </div>

          <div className="bg-white/80 backdrop-blur-sm rounded-2xl shadow-md border border-white/60 p-6 text-center">
            <div className="bg-green-100 w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4">
              <BarChart3 size={32} className="text-green-600" />
            </div>
            <h3 className="text-xl font-bold mb-2">Analytics & Insights</h3>
            <p className="text-gray-600 text-sm">
              Track performance with powerful analytics tools
            </p>
          </div>
        </motion.div>

        {/* Features List */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="bg-white/80 backdrop-blur-sm rounded-2xl shadow-md border border-white/60 p-8 mb-8"
        >
          <h2 className="text-2xl font-bold mb-6 flex items-center gap-2">
            <Sparkles className="text-yellow-500" size={28} />
            What You'll Get
          </h2>
          <div className="grid sm:grid-cols-2 gap-4">
            {[
              'Full store management dashboard',
              'Product listing & inventory control',
              'Order management system',
              'Secure payment processing',
              'Real-time sales analytics',
              'Customer communication tools',
              'Marketing & promotion features',
              '24/7 seller support'
            ].map((benefit, idx) => (
              <div key={idx} className="flex items-center gap-3">
                <CheckCircle size={20} className="text-green-500 shrink-0" />
                <span className="text-gray-700">{benefit}</span>
              </div>
            ))}
          </div>
        </motion.div>

        {/* CTA Section or Form */}
        {!showForm ? (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
            className="bg-linear-to-r from-indigo-600 to-sky-500 rounded-2xl shadow-2xl shadow-indigo-300/40 p-8 text-center text-white"
          >
            <h2 className="text-3xl font-bold mb-4">Ready to Start Selling?</h2>
            <p className="text-white/90 mb-2 max-w-2xl mx-auto text-lg">
              Click the button below to provide your details and activate your seller account!
            </p>
            <p className="text-yellow-300 font-semibold text-xl mb-6">
              ✨ 100% FREE - No setup fees, no monthly charges!
            </p>
            
            <motion.button
              onClick={() => setShowForm(true)}
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              className="bg-white text-indigo-600 font-bold text-lg px-12 py-4 rounded-full shadow-lg hover:shadow-xl transition-all inline-flex items-center gap-3"
            >
              <Store size={24} />
              Get Started
            </motion.button>

            <p className="text-white/90 text-sm mt-4 font-medium">
              🎉 Create your free store • No credit card required • Start selling immediately
            </p>
          </motion.div>
        ) : (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-white/80 backdrop-blur-sm rounded-2xl shadow-xl border border-white/60 p-8"
          >
            <h2 className="text-3xl font-bold mb-2 text-center bg-linear-to-r from-indigo-600 to-sky-500 bg-clip-text text-transparent">
              Seller Information
            </h2>
            <p className="text-gray-600 text-center mb-6">
              Please provide your contact details to activate your seller account
            </p>

            <form onSubmit={handleBecomeSeller} className="space-y-6">
              {/* Phone Number */}
              <div>
                <label className="flex text-gray-700 font-semibold mb-2 items-center gap-2">
                  <Phone size={18} className="text-indigo-600" />
                  Phone Number <span className="text-red-500">*</span>
                </label>
                <input
                  type="tel"
                  name="phoneNumber"
                  value={formData.phoneNumber}
                  onChange={handleInputChange}
                  placeholder="+1 234 567 8900"
                  className="w-full px-4 py-3 border border-slate-200 rounded-lg focus:ring-2 focus:ring-indigo-400 focus:border-indigo-400 bg-white/70 outline-none transition-all"
                  required
                />
              </div>

              {/* Business Name (Optional) */}
              <div>
                <label className="flex text-gray-700 font-semibold mb-2 items-center gap-2">
                  <Store size={18} className="text-indigo-600" />
                  Business Name (Optional)
                </label>
                <input
                  type="text"
                  name="businessName"
                  value={formData.businessName}
                  onChange={handleInputChange}
                  placeholder="Your business or brand name"
                  className="w-full px-4 py-3 border border-slate-200 rounded-lg focus:ring-2 focus:ring-indigo-400 focus:border-indigo-400 bg-white/70 outline-none transition-all"
                  maxLength={100}
                />
              </div>

              {/* Address */}
              <div>
                <label className="flex text-gray-700 font-semibold mb-2 items-center gap-2">
                  <MapPin size={18} className="text-indigo-600" />
                  Address <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  name="address"
                  value={formData.address}
                  onChange={handleInputChange}
                  placeholder="Street address"
                  className="w-full px-4 py-3 border border-slate-200 rounded-lg focus:ring-2 focus:ring-indigo-400 focus:border-indigo-400 bg-white/70 outline-none transition-all"
                  required
                />
              </div>

              {/* City and Country */}
              <div className="grid sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-gray-700 font-semibold mb-2">
                    City <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    name="city"
                    value={formData.city}
                    onChange={handleInputChange}
                    placeholder="Your city"
                    className="w-full px-4 py-3 border border-slate-200 rounded-lg focus:ring-2 focus:ring-indigo-400 focus:border-indigo-400 bg-white/70 outline-none transition-all"
                    required
                  />
                </div>

                <div>
                  <label className="block text-gray-700 font-semibold mb-2">
                    Country <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    name="country"
                    value={formData.country}
                    onChange={handleInputChange}
                    placeholder="Your country"
                    className="w-full px-4 py-3 border border-slate-200 rounded-lg focus:ring-2 focus:ring-indigo-400 focus:border-indigo-400 bg-white/70 outline-none transition-all"
                    required
                  />
                </div>
              </div>

              {/* Buttons */}
              <div className="flex gap-2 sm:gap-4 pt-4">
                <motion.button
                  type="button"
                  onClick={() => setShowForm(false)}
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  className="flex-1 bg-gray-200 text-gray-700 font-semibold py-2 sm:py-3 px-2 sm:px-6 rounded-lg hover:bg-gray-300 transition-all text-xs sm:text-base min-w-0"
                >
                  Back
                </motion.button>
                
                <motion.button
                  type="submit"
                  disabled={loading}
                  whileHover={{ scale: loading ? 1 : 1.02 }}
                  whileTap={{ scale: loading ? 1 : 0.98 }}
                  className="flex-1 bg-linear-to-r from-indigo-600 to-sky-500 text-white font-bold py-2 sm:py-3 px-2 sm:px-6 rounded-lg shadow-lg shadow-indigo-300/30 hover:shadow-xl hover:from-indigo-700 hover:to-sky-600 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1 sm:gap-2 text-xs sm:text-base min-w-0"
                >
                  {loading ? (
                    <>
                      <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      Activating...
                    </>
                  ) : (
                    <>
                      <Store size={20} />
                      Activate Seller Account
                    </>
                  )}
                </motion.button>
              </div>
            </form>
          </motion.div>
        )}
      </div>
    </div>
  );
}
