import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { HelpCircle, ChevronDown, ShoppingBag, CreditCard, Truck, RotateCcw, Store, Shield } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import SEOHead from '../components/common/SEOHead';

const faqCategories = [
  {
    category: 'Shopping',
    icon: <ShoppingBag size={18} />,
    questions: [
      { q: 'How do I create an account?', a: 'Open "Sign Up" from the account menu. You can register with your email or continue with Google for a faster setup.' },
      { q: 'How do I search for products?', a: 'Use the main search bar to find products. You can narrow results by category, price range, and other available filters.' },
      { q: 'Can I save items for later?', a: 'Yes. Select the heart icon on a product to add it to your Wishlist, then open Wishlist from your account whenever you want to review saved items.' }
    ]
  },
  {
    category: 'Payments',
    icon: <CreditCard size={18} />,
    questions: [
      { q: 'What payment methods are accepted?', a: 'Checkout supports Stripe card, Rozare Wallet, and Cash on Delivery. One order uses one payment method. COD is available only when every seller allows it; if any seller accepts online payment only, use card or a sufficient Wallet balance in the checkout currency.' },
      { q: 'How does Rozare Wallet work?', a: 'Open Wallet from your account to add balance securely by card and view transactions. USD, PKR, EUR, and GBP balances stay separate, so Wallet checkout requires enough balance in the exact order currency.' },
      { q: 'Is my payment information secure?', a: 'Payments are processed through Stripe, and Rozare does not store your card details on its servers.' },
      { q: 'Are there any hidden fees?', a: 'No hidden fees. The price you see includes all applicable taxes (calculated at checkout). Shipping costs are shown before you confirm your order.' }
    ]
  },
  {
    category: 'Shipping',
    icon: <Truck size={18} />,
    questions: [
      { q: 'How long does shipping take?', a: 'Shipping times vary by seller and destination. Each seller configures their own shipping methods with estimated delivery times shown at checkout.' },
      { q: 'Do you ship internationally?', a: 'Many sellers offer international shipping. Check the product page for available shipping destinations. Currency conversion is handled automatically.' },
      { q: 'How do I track my order?', a: 'When an order ships, its status is updated and supported notifications are sent. Open Orders from your account to view the latest status.' }
    ]
  },
  {
    category: 'Returns',
    icon: <RotateCcw size={18} />,
    questions: [
      { q: 'What is the return policy?', a: 'Return eligibility is set per seller and can be overridden per product. The policy saved when you order controls the deadline. In a multi-seller order, only items from sellers who allow returns become eligible after their portion is delivered.' },
      { q: 'How do I initiate a return?', a: 'Open the delivered order, select Request Return for an eligible seller, choose item quantities, and provide the reason. The seller then updates pickup, transit, receipt, and review statuses.' },
      { q: 'When do I receive a return refund?', a: 'The seller must accept the return and fund the approved amount from seller balance or by card. Rozare credits your Wallet in the order currency only after that funding is verified; failed or expired payments cannot complete the return.' }
    ]
  },
  {
    category: 'Selling',
    icon: <Store size={18} />,
    questions: [
      { q: 'How do I become a seller?', a: 'Open "Become a Seller" from the account menu, create or sign in to your account, add your store details, and verify your WhatsApp number. Your store is created instantly and your 15-day free trial begins.' },
      { q: 'What are the seller fees?', a: 'New sellers start with a 15-day free trial. Starter is $9.99/month after a 15% launch discount, with a 30-day free intro when eligible. Elite is $21.65/month after a 30% launch discount, with a 45-day free intro when eligible. The first 100 sellers to complete Checkout with FIRST100 get an extra locked 40% founder discount: $5.99 Starter or $12.99 Elite while the subscription remains uninterrupted. Meta ads add $4/month.' },
      { q: 'How do I manage my store?', a: 'The Seller Dashboard gives you full manual control: manage products, track orders, view analytics, configure shipping, and customize your store settings. You can also manage supported tasks by chatting with the Rozare AI.' }
    ]
  },
  {
    category: 'Trust & Safety',
    icon: <Shield size={18} />,
    questions: [
      { q: 'What is the Trust system?', a: 'Users can "trust" stores they\'ve had good experiences with. The public trust count is social proof, but it does not grant a verified badge.' },
      { q: 'How are stores verified?', a: 'Verification is separate from trust counts. A seller applies and an admin reviews the store before any verified badge is granted.' }
    ]
  }
];

function FAQItem({ q, a }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="glass-inner p-4 cursor-pointer" onClick={() => setOpen(!open)}>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium" style={{ color: 'hsl(var(--foreground))' }}>{q}</h3>
        <ChevronDown
          size={16}
          className="shrink-0 transition-transform duration-300"
          style={{ color: 'hsl(var(--muted-foreground))', transform: open ? 'rotate(180deg)' : 'rotate(0)' }}
        />
      </div>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25 }}
            className="overflow-hidden"
          >
            <p className="text-sm mt-3 leading-relaxed" style={{ color: 'hsl(var(--muted-foreground))' }}>{a}</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function FAQPage() {
  useEffect(() => { window.scrollTo(0, 0); }, []);

  const faqJsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": faqCategories.flatMap(cat =>
      cat.questions.map(item => ({
        "@type": "Question",
        "name": item.q,
        "acceptedAnswer": { "@type": "Answer", "text": item.a }
      }))
    )
  };

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <SEOHead
        title="FAQ — Help Center & Common Questions"
        description="Answers about Rozare shopping, seller plans, WhatsApp AI, payments, shipping, returns, order tracking, account management, and trust tools."
        canonical="/faq"
        keywords="rozare FAQ, rozare help, rozare questions, how to shop on rozare, rozare shipping, rozare returns, rozare payments, rozare refund, rozare seller FAQ, how to sell on rozare, rozare order tracking, rozare trust system, rozare verified stores, online shopping FAQ, marketplace help, e-commerce FAQ"
        jsonLd={faqJsonLd}
      />
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
      >
        <div className="text-center mb-10">
          <div className="inline-flex items-center gap-2 tag-pill mb-4">
            <HelpCircle size={14} />
            <span>Help Center</span>
          </div>
          <h1 className="text-3xl sm:text-4xl font-bold mb-3" style={{ color: 'hsl(var(--foreground))' }}>
            Frequently Asked Questions
          </h1>
          <p style={{ color: 'hsl(var(--muted-foreground))' }}>
            Find answers to the most common questions about Rozare.
          </p>
        </div>

        <div className="space-y-6">
          {faqCategories.map((cat, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.06, duration: 0.4 }}
              className="glass-panel p-6"
            >
              <div className="flex items-center gap-3 mb-4">
                <div className="p-2 rounded-xl" style={{ background: 'hsl(var(--primary) / 0.12)', color: 'hsl(var(--primary))' }}>
                  {cat.icon}
                </div>
                <h2 className="text-lg font-semibold" style={{ color: 'hsl(var(--foreground))' }}>{cat.category}</h2>
              </div>
              <div className="space-y-3">
                {cat.questions.map((item, j) => (
                  <FAQItem key={j} q={item.q} a={item.a} />
                ))}
              </div>
            </motion.div>
          ))}
        </div>

        <div className="glass-panel p-6 mt-8 text-center">
          <p style={{ color: 'hsl(var(--muted-foreground))' }} className="text-sm">
            Still have questions? <Link to="/contact" className="font-medium" style={{ color: 'hsl(var(--primary))' }}>Contact our support team</Link>.
          </p>
        </div>
      </motion.div>
    </div>
  );
}

export default FAQPage;
