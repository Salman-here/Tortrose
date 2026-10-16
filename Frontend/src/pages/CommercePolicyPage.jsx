import { useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { FileText, Mail, Phone } from 'lucide-react';
import SEOHead from '../components/common/SEOHead';
import { commercePolicies, policyConfig, policyPublicationReady } from '../../../MobileApp/src/content/commercePolicies';

export default function CommercePolicyPage({ policy = 'terms' }) {
  const document = commercePolicies[policy] || commercePolicies.terms;
  const { hash } = useLocation();
  useEffect(() => {
    const sectionId = hash.slice(1);
    const target = document.sections.some(section => section.id === sectionId) ? window.document.getElementById(sectionId) : null;
    if (target) target.scrollIntoView({ block: 'start' });
    else window.scrollTo(0, 0);
  }, [document, hash]);
  return <main data-commerce-content className="max-w-4xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
    <SEOHead title={document.title} description={document.description} canonical={document.path} />
    <header className="text-center mb-8"><FileText className="mx-auto mb-4 text-primary" size={28} /><h1 className="text-3xl sm:text-4xl font-bold">{document.title}</h1><p className="text-sm text-muted-foreground mt-3">Last updated: {policyConfig.updatedAt}</p></header>
    {!policyPublicationReady && <p role="status" className="glass-panel p-4 mb-5 border border-amber-400">Draft policy update — business details and service timelines are awaiting merchant confirmation. This draft is not approved for publication.</p>}
    <p className="glass-panel p-6 mb-6 leading-relaxed">{document.description}</p>
    <nav aria-label="Policy contents" className="flex flex-wrap gap-x-4 gap-y-3 text-sm mb-6">{document.sections.map(section => <Link key={section.id} to={`${document.path}#${section.id}`} className="underline text-primary">{section.title.replace(/^\d+\.\s*/, '')}</Link>)}</nav>
    <div className="space-y-5">{document.sections.map(section => <section id={section.id} key={section.id} className="glass-panel p-6 scroll-mt-24"><h2 className="text-lg font-semibold mb-3">{section.title}</h2><p className="text-sm text-muted-foreground leading-relaxed whitespace-pre-line">{section.content}</p></section>)}</div>
    <aside className="glass-panel p-6 mt-8 space-y-4"><h2 className="font-semibold">Customer support</h2><a className="inline-flex items-center gap-2 underline break-all" href={`mailto:${policyConfig.supportEmail}`}><Mail size={17} />{policyConfig.supportEmail}</a>{policyConfig.supportPhone && <a className="flex items-center gap-2 underline" href={`tel:${policyConfig.supportPhone.replace(/[^+\d]/g, '')}`}><Phone size={17} />{policyConfig.supportPhone}</a>}
      <nav aria-label="Related policies" className="flex flex-wrap gap-x-5 gap-y-3 text-sm">{Object.entries(commercePolicies).filter(([key]) => key !== policy).map(([key, doc]) => <Link key={key} className="underline" to={doc.path}>{doc.title}</Link>)}<Link className="underline" to="/privacy">Privacy Policy</Link><Link className="underline" to="/contact">Contact us</Link></nav>
    </aside>
  </main>;
}
