import React, { useEffect, useState } from 'react';
import { Mail, MessageSquare, MapPin, Clock, Send, Phone, HelpCircle } from 'lucide-react';
import { motion } from 'framer-motion';
import { toast } from 'react-toastify';
import { Link } from 'react-router-dom';
import SEOHead from '../components/common/SEOHead';
import { policyConfig, supportTimeline } from '../../../MobileApp/src/content/commercePolicies';

const contactMethods = [
  { icon: <Mail size={22} />, title: 'Email Us', value: policyConfig.supportEmail, href: `mailto:${policyConfig.supportEmail}`, desc: 'For order, account, and seller questions' },
  { icon: <Mail size={22} />, title: 'Company inquiries', value: policyConfig.companyEmail, href: `mailto:${policyConfig.companyEmail}`, desc: 'General and business inquiries' },
  { icon: <MessageSquare size={22} />, title: 'AI Chat', value: 'Available on platform', desc: 'Use Rozare AI for product and account help' },
  { icon: <MapPin size={22} />, title: 'Registered business', value: policyConfig.legalName, desc: policyConfig.registeredAddress || 'Pakistan' },
  ...(policyConfig.supportPhone ? [{ icon: <Phone size={22} />, title: 'Call support', value: policyConfig.supportPhone, href: `tel:${policyConfig.supportPhone.replace(/[^+\d]/g, '')}`, desc: 'Order, payment and account complaints' }] : [])
];

function ContactPage() {
  const [form, setForm] = useState({ name: '', email: '', subject: '', message: '' });
  const [sending, setSending] = useState(false);

  useEffect(() => { window.scrollTo(0, 0); }, []);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!form.name || !form.email || !form.message) {
      toast.error('Please fill in all required fields');
      return;
    }
    setSending(true);
    const subject = encodeURIComponent(form.subject || `Rozare support request from ${form.name}`);
    const body = encodeURIComponent(`Name: ${form.name}\nEmail: ${form.email}\n\n${form.message}`);
    window.location.href = `mailto:support@rozare.com?subject=${subject}&body=${body}`;
    toast.info('Opening your email app with a support draft.');
    setSending(false);
  };

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <SEOHead
        title="Contact Us — Customer Support & Help"
        description="Contact the Rozare support team for help with orders, shipping, payments, seller inquiries, account questions, and marketplace feedback."
        canonical="/contact"
        keywords="contact rozare, rozare support, rozare help, rozare customer service, rozare email, support@rozare.com, rozare phone, rozare live chat, order help, shipping help, payment help, seller support, buyer support, complaint, feedback"
        jsonLd={{
          '@context': 'https://schema.org',
          '@type': 'ContactPage',
          name: 'Contact Rozare',
          url: 'https://rozare.com/contact',
          mainEntity: {
            '@type': 'Organization',
            name: 'Rozare',
            url: 'https://rozare.com',
            contactPoint: {
              '@type': 'ContactPoint',
              email: 'support@rozare.com',
              contactType: 'customer support',
              availableLanguage: 'English',
              areaServed: 'Worldwide',
            },
          },
        }}
      />
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
      >
        <div className="text-center mb-10">
          <div className="inline-flex items-center gap-2 tag-pill mb-4">
            <Mail size={14} />
            <span>Support</span>
          </div>
          <h1 className="text-3xl sm:text-4xl font-bold mb-3" style={{ color: 'hsl(var(--foreground))' }}>
            Contact Us
          </h1>
          <p style={{ color: 'hsl(var(--muted-foreground))' }} className="max-w-lg mx-auto">
            Have a question, feedback, or need help? We'd love to hear from you.
          </p>
        </div>

        {/* Contact Methods */}
        <div className="grid sm:grid-cols-3 gap-4 mb-10">
          {contactMethods.map((m, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.1, duration: 0.4 }}
              className="glass-panel p-6 text-center"
            >
              <div className="inline-flex p-3 rounded-2xl mb-3" style={{ background: 'hsl(var(--primary) / 0.12)', color: 'hsl(var(--primary))' }}>
                {m.icon}
              </div>
              <h3 className="font-semibold mb-1" style={{ color: 'hsl(var(--foreground))' }}>{m.title}</h3>
              {m.href ? <a className="text-sm font-medium underline break-words" style={{ color: 'hsl(var(--primary))' }} href={m.href}>{m.value}</a> : <p className="text-sm font-medium" style={{ color: 'hsl(var(--primary))' }}>{m.value}</p>}
              <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>{m.desc}</p>
            </motion.div>
          ))}
        </div>

        <section className="glass-panel p-6 mb-8 space-y-3"><h2 className="font-semibold">Complaints and payment support</h2><p className="text-sm text-muted-foreground">{supportTimeline}</p><p className="text-sm">Include your order or subscription reference and a description of the issue. Do not send passwords, card numbers, CVV or OTPs.</p><a className="underline" href={`mailto:${policyConfig.supportEmail}`}>{policyConfig.supportEmail}</a>{policyConfig.supportPhone && <a className="block underline" href={`tel:${policyConfig.supportPhone.replace(/[^+\d]/g, '')}`}>{policyConfig.supportPhone}</a>}{policyConfig.sameOperatingAddress === false && policyConfig.operatingAddress && <p className="text-sm">Operating address: {policyConfig.operatingAddress}</p>}<p className="text-sm"><Link className="underline" to="/refund-policy">Refund policy and processing times</Link> · <Link className="underline" to="/cancellation-policy">Cancellation policy</Link></p></section>
        {/* Contact Form */}
        <div className="glass-panel-strong p-6 sm:p-8">
          <h2 className="text-xl font-bold mb-6" style={{ color: 'hsl(var(--foreground))' }}>
            Email support
          </h2>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1.5" style={{ color: 'hsl(var(--foreground))' }}>Name *</label>
                <input
                  type="text"
                  className="glass-input"
                  value={form.name}
                  onChange={e => setForm({ ...form, name: e.target.value })}
                  placeholder="Your name"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1.5" style={{ color: 'hsl(var(--foreground))' }}>Email *</label>
                <input
                  type="email"
                  className="glass-input"
                  value={form.email}
                  onChange={e => setForm({ ...form, email: e.target.value })}
                  placeholder="you@example.com"
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1.5" style={{ color: 'hsl(var(--foreground))' }}>Subject</label>
              <input
                type="text"
                className="glass-input"
                value={form.subject}
                onChange={e => setForm({ ...form, subject: e.target.value })}
                placeholder="What's this about?"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1.5" style={{ color: 'hsl(var(--foreground))' }}>Message *</label>
              <textarea
                className="glass-input min-h-[140px] resize-y"
                value={form.message}
                onChange={e => setForm({ ...form, message: e.target.value })}
                placeholder="Tell us how we can help..."
              />
            </div>
            <button
              type="submit"
              disabled={sending}
              className="glass-button flex items-center gap-2 px-6 py-3 font-medium text-sm"
              style={{ background: 'hsl(var(--primary))', color: 'hsl(var(--primary-foreground))', opacity: sending ? 0.7 : 1 }}
            >
              <Send size={16} />
              {sending ? 'Opening...' : 'Open Email Draft'}
            </button>
          </form>
        </div>

        {/* FAQ link */}
        <div className="glass-panel p-6 mt-8 text-center">
          <p style={{ color: 'hsl(var(--muted-foreground))' }} className="text-sm">
            Check our <Link to="/faq" className="font-medium" style={{ color: 'hsl(var(--primary))' }}>FAQ</Link> for quick answers to common questions.
          </p>
        </div>
      </motion.div>
    </div>
  );
}

export default ContactPage;
