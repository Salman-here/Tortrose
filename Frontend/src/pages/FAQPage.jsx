import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { HelpCircle, ChevronDown, ShoppingBag, CreditCard, Truck, RotateCcw, Store, Shield } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import SEOHead from '../components/common/SEOHead';
import { commerceFaqCategories } from '../../../MobileApp/src/content/commerceHelpContent';

const icons = { shopping: ShoppingBag, payments: CreditCard, shipping: Truck, returns: RotateCcw, selling: Store, safety: Shield };
function FAQItem({ id, q, a, links }) {
  const [open, setOpen] = useState(false);
  return <div className="glass-inner p-4">
    <button type="button" aria-expanded={open} aria-controls={`faq-${id}`} onClick={() => setOpen(value => !value)} className="flex w-full items-center justify-between gap-3 text-left">
      <span className="text-sm font-medium">{q}</span>
      <ChevronDown size={16} aria-hidden="true" className={`shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} />
    </button>
    <AnimatePresence>{open && <motion.div id={`faq-${id}`} initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
      <p className="text-sm text-muted-foreground mt-3 leading-relaxed">{a}</p>
      {links.length > 0 && <nav aria-label={`Read more: ${q}`} className="flex flex-wrap gap-x-4 gap-y-2 mt-3 text-xs">{links.map(link => <Link key={link.path} to={link.path} className="underline text-primary">{link.label}</Link>)}</nav>}
    </motion.div>}</AnimatePresence>
  </div>;
}
export default function FAQPage() {
  useEffect(() => { window.scrollTo(0, 0); }, []);
  const jsonLd = { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: commerceFaqCategories.flatMap(category => category.questions.map(item => ({ '@type': 'Question', name: item.q, acceptedAnswer: { '@type': 'Answer', text: item.a } }))) };
  return <main data-commerce-content className="max-w-4xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
    <SEOHead title="FAQ — Shopping, Payments and Seller Help" description="Answers about Rozare checkout, saved cards, Wallet refunds, returns, replacements, warranties, seller deductions and withdrawals." canonical="/faq" jsonLd={jsonLd} />
    <header className="text-center mb-10"><div className="inline-flex items-center gap-2 tag-pill mb-4"><HelpCircle size={14} /><span>Help Centre</span></div><h1 className="text-3xl sm:text-4xl font-bold mb-3">Frequently Asked Questions</h1><p className="text-muted-foreground">Clear answers for shopping and selling on Rozare.</p></header>
    <div className="space-y-6">{commerceFaqCategories.map(category => {
      const Icon = icons[category.id];
      return <section key={category.id} aria-labelledby={`category-${category.id}`} className="glass-panel p-6">
        <div className="flex items-center gap-3 mb-4"><Icon size={20} className="text-primary" aria-hidden="true" /><h2 id={`category-${category.id}`} className="text-lg font-semibold">{category.category}</h2></div>
        <div className="space-y-3">{category.questions.map(item => <FAQItem key={item.id} {...item} />)}</div>
      </section>;
    })}</div>
    <aside className="glass-panel p-6 mt-8 text-center text-sm text-muted-foreground">Need help with a specific order or case? <Link to="/contact" className="underline text-primary">Contact support</Link>.</aside>
  </main>;
}
