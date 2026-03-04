import React, { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { FileText, Shield, Users, AlertTriangle, Scale, Globe, Mail } from 'lucide-react';
import { motion } from 'framer-motion';

const sections = [
  {
    icon: <Users size={20} />,
    title: '1. Acceptance of Terms',
    content: `By accessing and using Tortrose ("the Platform"), you agree to be bound by these Terms of Service. If you do not agree to these terms, please do not use our platform. These terms apply to all visitors, users, sellers, and others who access or use the service.`
  },
  {
    icon: <Shield size={20} />,
    title: '2. User Accounts',
    content: `You are responsible for maintaining the confidentiality of your account credentials. You must be at least 18 years old to create an account. You agree to provide accurate, current, and complete information during registration. We reserve the right to suspend or terminate accounts that violate these terms.`
  },
  {
    icon: <Scale size={20} />,
    title: '3. Seller Obligations',
    content: `Sellers on Tortrose must provide accurate product descriptions, pricing, and availability information. Sellers are responsible for fulfilling orders in a timely manner, handling returns per our return policy, and complying with all applicable laws and regulations regarding their products and business operations.`
  },
  {
    icon: <AlertTriangle size={20} />,
    title: '4. Prohibited Activities',
    content: `Users may not: sell counterfeit or illegal products; engage in fraudulent transactions; harass other users; attempt to circumvent platform fees; use automated tools to scrape data; or violate any applicable laws. Violation of these terms may result in immediate account termination.`
  },
  {
    icon: <Globe size={20} />,
    title: '5. Intellectual Property',
    content: `All content on Tortrose, including logos, designs, and software, is owned by Tortrose or its licensors. Users retain ownership of content they upload but grant Tortrose a non-exclusive license to use, display, and distribute such content in connection with the platform's services.`
  },
  {
    icon: <FileText size={20} />,
    title: '6. Payments & Refunds',
    content: `All payments are processed securely through our payment partners. Refund policies vary by seller and are subject to our platform-wide refund guidelines. Tortrose is not liable for disputes between buyers and sellers but will facilitate resolution through our dispute resolution process.`
  },
  {
    icon: <Shield size={20} />,
    title: '7. Limitation of Liability',
    content: `Tortrose provides the platform "as is" without warranties of any kind. We are not liable for any indirect, incidental, special, or consequential damages. Our total liability shall not exceed the amount paid by you to us in the preceding 12 months. We do not guarantee uninterrupted or error-free service.`
  },
  {
    icon: <Scale size={20} />,
    title: '8. Changes to Terms',
    content: `We reserve the right to modify these terms at any time. Users will be notified of significant changes via email or platform notification. Continued use of the platform after changes constitutes acceptance of the new terms. It is your responsibility to review these terms periodically.`
  }
];

function TermsOfService() {
  useEffect(() => {
    document.title = 'Terms of Service — Tortrose';
    window.scrollTo(0, 0);
  }, []);

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
      >
        {/* Header */}
        <div className="text-center mb-10">
          <div className="inline-flex items-center gap-2 tag-pill mb-4">
            <FileText size={14} />
            <span>Legal</span>
          </div>
          <h1 className="text-3xl sm:text-4xl font-bold mb-3" style={{ color: 'hsl(var(--foreground))' }}>
            Terms of Service
          </h1>
          <p style={{ color: 'hsl(var(--muted-foreground))' }} className="text-sm">
            Last updated: March 1, 2026
          </p>
        </div>

        {/* Intro */}
        <div className="glass-panel p-6 sm:p-8 mb-8">
          <p style={{ color: 'hsl(var(--foreground))' }} className="leading-relaxed">
            Welcome to Tortrose. These Terms of Service govern your use of our marketplace platform. 
            By using Tortrose, you agree to these terms. Please read them carefully before creating 
            an account or making any transactions.
          </p>
        </div>

        {/* Sections */}
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

        {/* Contact */}
        <div className="glass-panel p-6 mt-8 text-center">
          <p style={{ color: 'hsl(var(--muted-foreground))' }} className="text-sm">
            Questions about these terms? <Link to="/contact" className="font-medium" style={{ color: 'hsl(var(--primary))' }}>Contact us</Link> or read our{' '}
            <Link to="/privacy" className="font-medium" style={{ color: 'hsl(var(--primary))' }}>Privacy Policy</Link>.
          </p>
        </div>
      </motion.div>
    </div>
  );
}

export default TermsOfService;
