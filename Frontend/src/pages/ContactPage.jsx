import React, { useEffect, useState } from 'react';
import { Mail, MessageSquare, MapPin, Clock, Send, Phone, HelpCircle } from 'lucide-react';
import { motion } from 'framer-motion';
import { toast } from 'react-toastify';
import { Link } from 'react-router-dom';
import SEOHead from '../components/common/SEOHead';

const contactMethods = [
  { icon: <Mail size={22} />, title: 'Email Us', value: 'support@tortrose.com', desc: 'We respond within 24 hours' },
  { icon: <MessageSquare size={22} />, title: 'Live Chat', value: 'Available on platform', desc: 'Mon–Fri, 9 AM – 6 PM EST' },
  { icon: <MapPin size={22} />, title: 'Headquarters', value: 'Global / Remote', desc: 'Serving customers worldwide' }
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
    setTimeout(() => {
      toast.success('Message sent! We\'ll get back to you soon.');
      setForm({ name: '', email: '', subject: '', message: '' });
      setSending(false);
    }, 1200);
  };

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <SEOHead
        title="Contact Us"
        description="Get in touch with the Tortrose team. We respond within 24 hours for all support and seller inquiries."
        canonical="/contact"
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
              <p className="text-sm font-medium" style={{ color: 'hsl(var(--primary))' }}>{m.value}</p>
              <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>{m.desc}</p>
            </motion.div>
          ))}
        </div>

        {/* Contact Form */}
        <div className="glass-panel-strong p-6 sm:p-8">
          <h2 className="text-xl font-bold mb-6" style={{ color: 'hsl(var(--foreground))' }}>
            Send us a message
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
              {sending ? 'Sending...' : 'Send Message'}
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
