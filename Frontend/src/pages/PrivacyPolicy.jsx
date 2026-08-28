import React, { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Shield, Eye, Database, Lock, UserCheck, Bell, Trash2, Globe, Bot, MapPin, MessageSquare, Baby } from 'lucide-react';
import { motion } from 'framer-motion';
import SEOHead from '../components/common/SEOHead';

const sections = [
  {
    icon: <Database size={20} />,
    title: '1. Information We Collect',
    content: `We collect account and profile details such as your name, email address, avatar, phone or WhatsApp number, saved shipping addresses, preferences, and seller business or store information. We collect order, cart, Wallet, payment-status, refund, return, product, review, support, report, and account-blocking records created when you use Rozare. Payment card details are handled by our payment processors; Rozare receives transaction references and payment status needed to complete and support a purchase.`
  },
  {
    icon: <Eye size={20} />,
    title: '2. How We Use Your Information',
    content: `We use information to operate accounts and stores; show relevant products; process purchases, payments, deliveries, returns, refunds, and seller settlements; preserve carts and chat history; send service, email, push, and optional WhatsApp updates; provide support; investigate reports; enforce safety rules; prevent fraud; measure performance and advertising; improve Rozare; and meet legal obligations.`
  },
  {
    icon: <UserCheck size={20} />,
    title: '3. Information Sharing',
    content: `We share only what is needed with sellers and delivery providers to fulfill orders; payment processors to complete transactions; cloud hosting, storage, email, push-notification, customer-support, and WhatsApp service providers; and analytics or advertising-measurement partners, including Meta or TikTok when those integrations are enabled. We may disclose information to authorities or other parties when required by law, to protect users, or during a business transfer. We do not sell personal information for money.`
  },
  {
    icon: <Lock size={20} />,
    title: '4. Data Security',
    content: `We use safeguards such as encrypted network connections, restricted access, secure credential storage, payment processing through specialist providers, monitoring, and backups. No online system is completely risk-free, so protect your password and contact security@rozare.com if you believe your account has been compromised.`
  },
  {
    icon: <Bell size={20} />,
    title: '5. Cookies & Tracking',
    content: `We use cookies, local storage, mobile identifiers, pixels, and similar technologies for sign-in, security, preferences, cart continuity, performance, analytics, and marketing measurement. Depending on your settings, Meta or TikTok technologies may receive event, device, page, or purchase information for measurement. Browser and device controls may limit some technologies, though essential features may then work differently.`
  },
  {
    icon: <Shield size={20} />,
    title: '6. Your Rights',
    content: `Depending on your location, you may be entitled to access, correct, delete, or receive a copy of personal data; object to or restrict certain processing; or withdraw consent. You can update common account information in Rozare. You can delete your account in the app under Settings, or use our public account-deletion page. Contact privacy@rozare.com for other requests; we may verify your identity before acting.`
  },
  {
    icon: <Trash2 size={20} />,
    title: '7. Data Retention',
    content: `We retain active account and chat data while needed to provide Rozare. When you delete an account, we delete or de-identify data that is not required for fraud prevention, safety investigations, tax, accounting, payment, dispute, or other legal obligations. Order and transaction records may therefore be retained for the legally required period. Moderation reports and security logs may be retained as necessary to protect users and document enforcement decisions.`
  },
  {
    icon: <Globe size={20} />,
    title: '8. International Transfers',
    content: `Your data may be transferred to and processed in countries other than your own. We ensure appropriate safeguards are in place for international data transfers, including standard contractual clauses and adequacy decisions where applicable.`
  },
  {
    icon: <Bot size={20} />,
    title: '9. AI, Chat, Voice & Attachments',
    content: `When you use Rozare AI, we process your prompts, conversation context, selected account or commerce information, AI results, and any images, files, or voice notes you choose to send. Voice notes may be transcribed. This information is sent to third-party AI routing and model providers to produce the requested response or action. Do not include sensitive information that is not needed. Saved conversations remain available in your chat history until you delete the conversation or account, subject to the retention exceptions above.`
  },
  {
    icon: <MapPin size={20} />,
    title: '10. Device, Location & Permissions',
    content: `We may collect device type, operating system, app version, crash or diagnostic data, IP address, and an approximate location inferred from IP. If you select a country, region, city, town, or nearby-store location, we use it to show stores and delivery availability. Media-library access is used only when you choose an image or file; microphone access is used when you choose to record a voice note; notification access is used for alerts you enable.`
  },
  {
    icon: <MessageSquare size={20} />,
    title: '11. Marketplace Safety',
    content: `Reports about AI responses, products, stores, sellers, and reviews are provided to authorized moderators with a snapshot of the reported content and your optional explanation. A private block list is associated with your account so Rozare can hide blocked accounts and their content from you. Reporting does not automatically remove content; we review context and may take action under our policies.`
  },
  {
    icon: <Baby size={20} />,
    title: '12. Children & Families',
    content: `Rozare is a general shopping marketplace, not a service directed specifically to children. A person under the age of legal majority should use Rozare only with the permission and involvement of a parent or legal guardian, especially for account creation, selling, purchases, payments, and sharing personal information. Where law requires verifiable parental consent, a child must not provide personal data until that consent is obtained. A parent or guardian may contact privacy@rozare.com about a child’s information.`
  }
];

function PrivacyPolicy() {
  useEffect(() => { window.scrollTo(0, 0); }, []);

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <SEOHead
        title="Privacy Policy — Data Protection & Security"
        description="Learn how Rozare collects, uses, shares, and protects personal data for accounts, orders, payments, analytics, cookies, seller tools, and support."
        canonical="/privacy"
        keywords="rozare privacy policy, rozare data protection, rozare security, rozare cookies, online shopping privacy, marketplace privacy, e-commerce privacy, data security, personal data, GDPR, user data protection, secure shopping"
      />
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
            Last updated: August 29, 2026
          </p>
        </div>

        <div className="glass-panel p-6 sm:p-8 mb-8">
          <p style={{ color: 'hsl(var(--foreground))' }} className="leading-relaxed">
            At Rozare, your privacy is important to us. This policy explains what information we collect, 
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
            For privacy inquiries, email <span className="font-medium" style={{ color: 'hsl(var(--primary))' }}>privacy@rozare.com</span>. 
            Also see our <Link to="/terms" className="font-medium" style={{ color: 'hsl(var(--primary))' }}>Terms of Service</Link> and{' '}
            <Link to="/account-deletion" className="font-medium" style={{ color: 'hsl(var(--primary))' }}>account-deletion instructions</Link>.
          </p>
        </div>
      </motion.div>
    </div>
  );
}

export default PrivacyPolicy;
