import { Link } from 'react-router-dom';
import { checkoutPolicyNotice } from '../../../../MobileApp/src/content/commercePolicies';
export default function CheckoutPolicyLinks() {
  return <aside aria-label="Checkout policies" className="text-xs text-muted-foreground leading-relaxed space-y-2 my-4">
    <p>{checkoutPolicyNotice.introduction}{' '}<Link className="underline" to={checkoutPolicyNotice.terms.path}>{checkoutPolicyNotice.terms.label}</Link>.</p>
    <nav aria-label="Related checkout policies" className="flex flex-wrap gap-x-4 gap-y-2">
      {checkoutPolicyNotice.links.map(link => <Link key={link.path} className="underline" to={link.path}>{link.label}</Link>)}
    </nav>
  </aside>;
}
