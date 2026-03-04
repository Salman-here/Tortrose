import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Store, ArrowLeft, Sparkles, CheckCircle, TrendingUp, Shield, BarChart3, Phone, MapPin } from 'lucide-react';
import { toast } from 'react-toastify';
import axios from 'axios';
import { useAuth } from '../contexts/AuthContext';
import SEOHead from '../components/common/SEOHead';

export default function BecomeSeller() {
  const navigate = useNavigate();
  const { currentUser, fetchAndUpdateCurrentUser } = useAuth();
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({ phoneNumber: '', address: '', city: '', country: '', businessName: '' });

  const handleInputChange = (e) => { const { name, value } = e.target; setFormData(prev => ({ ...prev, [name]: value })); };

  const handleBecomeSeller = async (e) => {
    e.preventDefault();
    if (!formData.phoneNumber || formData.phoneNumber.trim().length < 10) { toast.error('Please enter a valid phone number (at least 10 digits)'); return; }
    if (!formData.address || formData.address.trim().length < 5) { toast.error('Please enter a valid address'); return; }
    if (!formData.city || formData.city.trim().length < 2) { toast.error('Please enter your city'); return; }
    if (!formData.country || formData.country.trim().length < 2) { toast.error('Please enter your country'); return; }
    setLoading(true);
    try {
      const token = localStorage.getItem('jwtToken');
      const res = await axios.post(`${import.meta.env.VITE_API_URL}api/user/become-seller`, { phoneNumber: formData.phoneNumber.trim(), address: formData.address.trim(), city: formData.city.trim(), country: formData.country.trim(), businessName: formData.businessName.trim() }, { headers: { Authorization: `Bearer ${token}` } });
      if (res.data.token) localStorage.setItem('jwtToken', res.data.token);
      toast.success('Congratulations! You are now a seller!');
      await fetchAndUpdateCurrentUser();
      setTimeout(() => { window.location.href = '/seller-dashboard/store-overview'; }, 1500);
    } catch (error) { toast.error(error.response?.data?.message || 'Failed to create seller account'); }
    finally { setLoading(false); }
  };

  if (currentUser?.role === 'seller' || currentUser?.role === 'admin') { navigate('/'); return null; }

  const benefits = [
    { icon: <TrendingUp size={28} />, title: 'Grow Your Business', description: 'Reach millions of customers and scale your sales', color: 'hsl(220, 70%, 55%)' },
    { icon: <Shield size={28} />, title: 'Secure Platform', description: 'Safe payments and buyer protection guaranteed', color: 'hsl(200, 80%, 50%)' },
    { icon: <BarChart3 size={28} />, title: 'Analytics & Insights', description: 'Track performance with powerful analytics tools', color: 'hsl(150, 60%, 45%)' },
  ];

  const features = ['Full store management dashboard', 'Product listing & inventory control', 'Order management system', 'Secure payment processing', 'Real-time sales analytics', 'Customer communication tools', 'Marketing & promotion features', '24/7 seller support'];

  return (
    <div className="min-h-screen py-12 px-4">
      <SEOHead
        title="Become a Seller — Start Selling for Free"
        description="Join Tortrose as a seller. Create your free store, list products, and reach customers worldwide with powerful analytics and tools."
        canonical="/become-seller"
      />
      <div className="max-w-4xl mx-auto">
        <button onClick={() => navigate(-1)} className="flex items-center gap-2 mb-6 transition-colors text-sm font-medium" style={{ color: 'hsl(var(--muted-foreground))' }}>
          <ArrowLeft size={20} /> <span>Back</span>
        </button>

        {/* Header */}
        <motion.div initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }} className="text-center mb-8">
          <div className="flex justify-center mb-4">
            <div className="p-4 rounded-full shadow-lg" style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(200, 80%, 50%))', boxShadow: '0 0 30px -4px hsl(220, 70%, 55%, 0.4)' }}>
              <Store size={48} className="text-white" />
            </div>
          </div>
          <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight mb-3" style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(200, 80%, 50%))', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
            Become a Seller - FREE
          </h1>
          <p className="text-lg max-w-2xl mx-auto mb-2" style={{ color: 'hsl(var(--muted-foreground))' }}>Join thousands of successful sellers and start your e-commerce journey today</p>
          <p className="text-xl font-bold" style={{ color: 'hsl(150, 60%, 45%)' }}>
            <Sparkles size={18} className="inline mr-1" /> Create your store for FREE - No hidden costs!
          </p>
        </motion.div>

        {/* Benefits */}
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="grid md:grid-cols-3 gap-6 mb-8">
          {benefits.map((b, i) => (
            <motion.div key={i} whileHover={{ y: -4 }} className="glass-card p-6 text-center">
              <div className="glass-inner w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-4" style={{ color: b.color }}>{b.icon}</div>
              <h3 className="text-xl font-bold mb-2" style={{ color: 'hsl(var(--foreground))' }}>{b.title}</h3>
              <p className="text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>{b.description}</p>
            </motion.div>
          ))}
        </motion.div>

        {/* Features */}
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }} className="glass-panel p-8 mb-8">
          <h2 className="text-2xl font-bold mb-6 flex items-center gap-2" style={{ color: 'hsl(var(--foreground))' }}>
            <Sparkles size={24} style={{ color: 'hsl(45, 93%, 47%)' }} /> What You'll Get
          </h2>
          <div className="grid sm:grid-cols-2 gap-4">
            {features.map((f, i) => (
              <div key={i} className="flex items-center gap-3">
                <CheckCircle size={20} style={{ color: 'hsl(150, 60%, 45%)' }} className="shrink-0" />
                <span className="text-sm" style={{ color: 'hsl(var(--foreground))' }}>{f}</span>
              </div>
            ))}
          </div>
        </motion.div>

        {/* CTA / Form */}
        {!showForm ? (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }}
            className="rounded-2xl p-8 text-center text-white" style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(200, 80%, 50%))', boxShadow: '0 0 40px -8px hsl(220, 70%, 55%, 0.4)' }}>
            <h2 className="text-3xl font-bold mb-4">Ready to Start Selling?</h2>
            <p className="text-white/90 mb-2 max-w-2xl mx-auto text-lg">Click below to provide your details and activate your seller account!</p>
            <p className="font-semibold text-xl mb-6" style={{ color: 'hsl(45, 93%, 70%)' }}>
              <Sparkles size={18} className="inline mr-1" /> 100% FREE - No setup fees, no monthly charges!
            </p>
            <motion.button onClick={() => setShowForm(true)} whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}
              className="font-bold text-lg px-12 py-4 rounded-full shadow-lg hover:shadow-xl transition-all inline-flex items-center gap-3"
              style={{ background: 'white', color: 'hsl(220, 70%, 55%)' }}>
              <Store size={24} /> Get Started
            </motion.button>
          </motion.div>
        ) : (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="glass-panel p-8">
            <h2 className="text-3xl font-bold mb-2 text-center" style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(200, 80%, 50%))', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>Seller Information</h2>
            <p className="text-center mb-6 text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>Please provide your contact details</p>

            <form onSubmit={handleBecomeSeller} className="space-y-6">
              <div>
                <label className="flex text-xs font-semibold uppercase tracking-wider mb-2 items-center gap-2" style={{ color: 'hsl(var(--muted-foreground))' }}>
                  <Phone size={14} style={{ color: 'hsl(var(--primary))' }} /> Phone Number <span style={{ color: 'hsl(0, 72%, 55%)' }}>*</span>
                </label>
                <input type="tel" name="phoneNumber" value={formData.phoneNumber} onChange={handleInputChange} placeholder="+1 234 567 8900" className="glass-input" required />
              </div>
              <div>
                <label className="flex text-xs font-semibold uppercase tracking-wider mb-2 items-center gap-2" style={{ color: 'hsl(var(--muted-foreground))' }}>
                  <Store size={14} style={{ color: 'hsl(var(--primary))' }} /> Business Name (Optional)
                </label>
                <input type="text" name="businessName" value={formData.businessName} onChange={handleInputChange} placeholder="Your business or brand name" className="glass-input" maxLength={100} />
              </div>
              <div>
                <label className="flex text-xs font-semibold uppercase tracking-wider mb-2 items-center gap-2" style={{ color: 'hsl(var(--muted-foreground))' }}>
                  <MapPin size={14} style={{ color: 'hsl(var(--primary))' }} /> Address <span style={{ color: 'hsl(0, 72%, 55%)' }}>*</span>
                </label>
                <input type="text" name="address" value={formData.address} onChange={handleInputChange} placeholder="Street address" className="glass-input" required />
              </div>
              <div className="grid sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'hsl(var(--muted-foreground))' }}>City <span style={{ color: 'hsl(0, 72%, 55%)' }}>*</span></label>
                  <input type="text" name="city" value={formData.city} onChange={handleInputChange} placeholder="Your city" className="glass-input" required />
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'hsl(var(--muted-foreground))' }}>Country <span style={{ color: 'hsl(0, 72%, 55%)' }}>*</span></label>
                  <input type="text" name="country" value={formData.country} onChange={handleInputChange} placeholder="Your country" className="glass-input" required />
                </div>
              </div>
              <div className="flex gap-2 sm:gap-4 pt-4">
                <motion.button type="button" onClick={() => setShowForm(false)} whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}
                  className="flex-1 py-2 sm:py-3 px-2 sm:px-6 rounded-xl text-xs sm:text-base font-semibold glass-inner" style={{ color: 'hsl(var(--foreground))' }}>Back</motion.button>
                <motion.button type="submit" disabled={loading} whileHover={{ scale: loading ? 1 : 1.02 }} whileTap={{ scale: loading ? 1 : 0.98 }}
                  className="flex-1 py-2 sm:py-3 px-2 sm:px-6 rounded-xl text-xs sm:text-base font-bold text-white disabled:opacity-50 flex items-center justify-center gap-1 sm:gap-2"
                  style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(200, 80%, 50%))', boxShadow: '0 0 20px -4px hsl(220, 70%, 55%, 0.3)' }}>
                  {loading ? <><div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" /> Activating...</> : <><Store size={20} /> Activate Seller Account</>}
                </motion.button>
              </div>
            </form>
          </motion.div>
        )}
      </div>
    </div>
  );
}
