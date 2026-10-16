import React, { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Shield } from 'lucide-react';
import SEOHead from '../components/common/SEOHead';
import { policyConfig } from '../../../MobileApp/src/content/commercePolicies';
import { paymentPrivacyNotice, privacyIntro, privacySections } from '../../../MobileApp/src/content/privacyContent';

export default function PrivacyPolicy() {
  useEffect(() => { window.scrollTo(0, 0); }, []);
  return <main data-commerce-content className="max-w-4xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
    <SEOHead title="Privacy Policy" description={privacyIntro} canonical="/privacy" />
    <header className="text-center mb-8"><Shield className="mx-auto mb-4 text-primary" size={28} /><h1 className="text-3xl sm:text-4xl font-bold">Privacy Policy</h1><p className="text-sm text-muted-foreground mt-3">Last updated: {policyConfig.updatedAt}</p></header>
    <p className="glass-panel p-6 mb-6 leading-relaxed">{privacyIntro}</p>
    <section className="glass-panel p-6 mb-5"><h2 className="text-lg font-semibold mb-3">Who operates Rozare and handles payments</h2><p className="text-sm text-muted-foreground leading-relaxed">{paymentPrivacyNotice}</p></section>
    <div className="space-y-5">{privacySections.map(section => <section key={section.id} id={section.id} className="glass-panel p-6"><h2 className="text-lg font-semibold mb-3">{section.title}</h2><p className="text-sm text-muted-foreground leading-relaxed">{section.content}</p></section>)}</div>
    <aside className="glass-panel p-6 mt-8 text-sm space-y-4"><p>Privacy requests: <a href="mailto:privacy@rozare.com" className="underline text-primary">privacy@rozare.com</a>.</p><nav aria-label="Privacy policy links" className="flex flex-wrap gap-x-5 gap-y-3"><Link to="/terms" className="underline">Terms and Conditions</Link><Link to="/account-deletion" className="underline">Account-deletion instructions</Link><Link to="/contact" className="underline">Contact support</Link></nav></aside>
  </main>;
}
