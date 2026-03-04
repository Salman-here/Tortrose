import React, { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Heart, Globe, Shield, Zap, Users, Star, TrendingUp, Award } from 'lucide-react';
import { motion } from 'framer-motion';

const values = [
  { icon: <Shield size={22} />, title: 'Trust & Safety', desc: 'Every store is verified. Our trust system lets the community vouch for quality sellers.' },
  { icon: <Zap size={22} />, title: 'Fast & Seamless', desc: 'From discovery to checkout in seconds. We optimize every step of the shopping journey.' },
  { icon: <Globe size={22} />, title: 'Global Reach', desc: 'Multi-currency support and international shipping connect buyers and sellers worldwide.' },
  { icon: <Heart size={22} />, title: 'Community First', desc: 'Built for independent sellers and conscious shoppers who value quality over quantity.' }
];

const stats = [
  { value: '10K+', label: 'Products Listed' },
  { value: '500+', label: 'Verified Sellers' },
  { value: '50+', label: 'Countries Served' },
  { value: '99.9%', label: 'Uptime' }
];

function AboutPage() {
  useEffect(() => {
    document.title = 'About Tortrose — Modern Marketplace';
    window.scrollTo(0, 0);
  }, []);

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
      >
        {/* Hero */}
        <div className="text-center mb-12">
          <div className="inline-flex items-center gap-2 tag-pill mb-4">
            <Star size={14} />
            <span>Our Story</span>
          </div>
          <h1 className="text-3xl sm:text-5xl font-bold mb-4 gradient-text">
            About Tortrose
          </h1>
          <p style={{ color: 'hsl(var(--muted-foreground))' }} className="text-base sm:text-lg max-w-2xl mx-auto">
            A modern marketplace built on trust, designed for independent sellers and thoughtful shoppers 
            who believe in quality, transparency, and community.
          </p>
        </div>

        {/* Mission */}
        <div className="glass-panel-strong p-8 sm:p-10 mb-10 text-center">
          <h2 className="text-xl sm:text-2xl font-bold mb-4" style={{ color: 'hsl(var(--foreground))' }}>
            Our Mission
          </h2>
          <p style={{ color: 'hsl(var(--muted-foreground))' }} className="text-base leading-relaxed max-w-3xl mx-auto">
            To empower independent sellers with beautiful storefronts and powerful tools, while giving 
            shoppers a curated, trustworthy marketplace experience. We believe commerce should be personal, 
            transparent, and accessible to everyone — no matter where they are in the world.
          </p>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-10">
          {stats.map((stat, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: i * 0.1, duration: 0.4 }}
              className="glass-panel p-5 text-center"
            >
              <div className="text-2xl sm:text-3xl font-bold gradient-text">{stat.value}</div>
              <div className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>{stat.label}</div>
            </motion.div>
          ))}
        </div>

        {/* Values */}
        <h2 className="text-xl sm:text-2xl font-bold mb-6 text-center" style={{ color: 'hsl(var(--foreground))' }}>
          What We Stand For
        </h2>
        <div className="grid sm:grid-cols-2 gap-5 mb-10">
          {values.map((v, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.08, duration: 0.4 }}
              className="glass-panel p-6"
            >
              <div className="flex items-center gap-3 mb-3">
                <div className="p-2 rounded-xl" style={{ background: 'hsl(var(--primary) / 0.12)', color: 'hsl(var(--primary))' }}>
                  {v.icon}
                </div>
                <h3 className="font-semibold" style={{ color: 'hsl(var(--foreground))' }}>{v.title}</h3>
              </div>
              <p className="text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>{v.desc}</p>
            </motion.div>
          ))}
        </div>

        {/* CTA */}
        <div className="glass-panel p-8 text-center">
          <h2 className="text-xl font-bold mb-3" style={{ color: 'hsl(var(--foreground))' }}>
            Ready to join Tortrose?
          </h2>
          <p className="text-sm mb-5" style={{ color: 'hsl(var(--muted-foreground))' }}>
            Start shopping or become a seller today.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Link to="/" className="glass-button px-6 py-3 font-medium text-sm" style={{ background: 'hsl(var(--primary))', color: 'hsl(var(--primary-foreground))' }}>
              Browse Products
            </Link>
            <Link to="/become-seller" className="glass-button px-6 py-3 font-medium text-sm" style={{ color: 'hsl(var(--foreground))' }}>
              Become a Seller
            </Link>
          </div>
        </div>
      </motion.div>
    </div>
  );
}

export default AboutPage;
