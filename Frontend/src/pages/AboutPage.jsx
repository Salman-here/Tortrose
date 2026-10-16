import React, { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Heart, Globe, Shield, Zap, Users, Star, TrendingUp, Award } from 'lucide-react';
import { motion } from 'framer-motion';
import SEOHead from '../components/common/SEOHead';

const values = [
  { icon: <Shield size={22} />, title: 'Trust & Safety', desc: 'Stores can earn trust signals and verified badges, helping shoppers choose with more confidence.' },
  { icon: <Zap size={22} />, title: 'Fast & Seamless', desc: 'Buyers can browse, compare, save, and checkout while sellers manage products, orders, and promotions from one place.' },
  { icon: <Globe size={22} />, title: 'Flexible Commerce', desc: 'Multi-currency browsing, seller-managed shipping, and custom storefronts support growing online businesses.' },
  { icon: <Heart size={22} />, title: 'Community First', desc: 'Built for independent sellers and conscious shoppers who value quality over quantity.' }
];

const stats = [
  { value: '15 Days', label: 'Free Trial' },
  { value: '2 Plans', label: 'Starter & Elite' },
  { value: 'AI + Dashboard', label: 'Store Management' },
  { value: 'Web + WhatsApp', label: 'Seller Workflows' }
];

function AboutPage() {
  useEffect(() => { window.scrollTo(0, 0); }, []);

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <SEOHead
        page="/about"
        keywords="about rozare, rozare story, rozare mission, rozare marketplace about, who is rozare, rozare company, rozare team, online marketplace mission, trusted marketplace, community marketplace, independent sellers platform, fair e-commerce, transparent shopping"
        jsonLd={{
            '@context': 'https://schema.org',
            '@type': 'AboutPage',
            name: 'About Rozare',
            description: 'Learn about Rozare marketplace and our mission to empower independent sellers with AI-assisted tools.',
            url: 'https://rozare.com/about',
            mainEntity: {
                '@type': 'Organization',
                name: 'Rozare',
                url: 'https://rozare.com',
                description: 'AI-powered online marketplace for buyers, independent sellers, and brands',
            },
        }}
      />
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
            About Rozare
          </h1>
          <p style={{ color: 'hsl(var(--muted-foreground))' }} className="text-base sm:text-lg max-w-2xl mx-auto">
            An AI-powered marketplace built for independent sellers, brands, and thoughtful shoppers
            who value clear information, flexible tools, and trust.
          </p>
        </div>

        {/* Mission */}
        <div className="glass-panel-strong p-8 sm:p-10 mb-10 text-center">
          <h2 className="text-xl sm:text-2xl font-bold mb-4" style={{ color: 'hsl(var(--foreground))' }}>
            Our Mission
          </h2>
          <p style={{ color: 'hsl(var(--muted-foreground))' }} className="text-base leading-relaxed max-w-3xl mx-auto">
            To empower independent sellers with storefronts, AI-assisted workflows, and practical dashboard
            tools, while giving shoppers a clearer way to discover products, compare stores, and buy with
            confidence.
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
            Ready to join Rozare?
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
