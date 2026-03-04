import React, { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Shield, Eye, Database, Lock, UserCheck, Bell, Trash2, Globe } from 'lucide-react';
import { motion } from 'framer-motion';

const sections = [
  {
    icon: <Database size={20} />,
    title: '1. Information We Collect',
    content: `We collect information you provide directly: name, email, shipping address, payment details, and phone number. We also collect usage data including browsing patterns, device information, IP addresses, and cookies to improve your experience and platform security.`
  },
  {
    icon: <Eye size={20} />,
    title: '2. How We Use Your Information',
    content: `Your information is used to: process orders and payments; personalize your shopping experience; communicate about orders and promotions; improve platform features; detect and prevent fraud; comply with legal obligations; and provide customer support.`
  },
  {
    icon: <UserCheck size={20} />,
    title: '3. Information Sharing',
    content: `We share information with: sellers (to fulfill orders); payment processors (to process transactions); shipping providers (for delivery); and service providers (for analytics and support). We never sell your personal information to third parties for marketing purposes.`
  },
  {
    icon: <Lock size={20} />,
    title: '4. Data Security',
    content: `We implement industry-standard security measures including SSL/TLS encryption, secure payment processing through Stripe, regular security audits, and access controls. While we strive to protect your data, no method of transmission over the internet is 100% secure.`
  },
  {
    icon: <Bell size={20} />,
    title: '5. Cookies & Tracking',
    content: `We use cookies and similar technologies for: session management; remembering preferences; analytics and performance monitoring; and personalized content. You can manage cookie preferences through your browser settings, though some features may not function properly without cookies.`
  },
  {
    icon: <Shield size={20} />,
    title: '6. Your Rights',
    content: `Depending on your jurisdiction, you may have rights to: access your personal data; correct inaccurate data; request deletion of your data; object to processing; data portability; and withdraw consent. To exercise these rights, contact us at privacy@tortrose.com.`
  },
  {
    icon: <Trash2 size={20} />,
    title: '7. Data Retention',
    content: `We retain personal data for as long as necessary to provide our services, comply with legal obligations, resolve disputes, and enforce agreements. Account data is retained for the duration of your account and for a reasonable period after deletion for legal compliance.`
  },
  {
    icon: <Globe size={20} />,
    title: '8. International Transfers',
    content: `Your data may be transferred to and processed in countries other than your own. We ensure appropriate safeguards are in place for international data transfers, including standard contractual clauses and adequacy decisions where applicable.`
  }
];

function PrivacyPolicy() {
  useEffect(() => {
    document.title = 'Privacy Policy — Tortrose';
    window.scrollTo(0, 0);
  }, []);

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
      >
        <div className="text-center mb-10">
          <div className="inline-flex items-center gap-2 tag-pill mb-4">
            <Shield size={14} />
            <span>Privacy</span>
          </div>
          <h1 className="text-3xl sm:text-4xl font-bold mb-3" style={{ color: 'hsl(var(--foreground))' }}>
            Privacy Policy
          </h1>
          <p style={{ color: 'hsl(var(--muted-foreground))' }} className="text-sm">
            Last updated: March 1, 2026
          </p>
        </div>

        <div className="glass-panel p-6 sm:p-8 mb-8">
          <p style={{ color: 'hsl(var(--foreground))' }} className="leading-relaxed">
            At Tortrose, your privacy is important to us. This policy explains what information we collect, 
            how we use it, and what choices you have. We are committed to protecting your personal data and 
            being transparent about our practices.
          </p>
        </div>

        <div className="space-y-5">
          {sections.map((section, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.06, duration: 0.4 }}
              className="glass-panel p-6"
            >
              <div className="flex items-center gap-3 mb-3">
                <div className="p-2 rounded-xl" style={{ background: 'hsl(var(--primary) / 0.12)', color: 'hsl(var(--primary))' }}>
                  {section.icon}
                </div>
                <h2 className="text-lg font-semibold" style={{ color: 'hsl(var(--foreground))' }}>
                  {section.title}
                </h2>
              </div>
              <p style={{ color: 'hsl(var(--muted-foreground))' }} className="text-sm leading-relaxed">
                {section.content}
              </p>
            </motion.div>
          ))}
        </div>

        <div className="glass-panel p-6 mt-8 text-center">
          <p style={{ color: 'hsl(var(--muted-foreground))' }} className="text-sm">
            For privacy inquiries, email <span className="font-medium" style={{ color: 'hsl(var(--primary))' }}>privacy@tortrose.com</span>. 
            Also see our <Link to="/terms" className="font-medium" style={{ color: 'hsl(var(--primary))' }}>Terms of Service</Link>.
          </p>
        </div>
      </motion.div>
    </div>
  );
}

export default PrivacyPolicy;
