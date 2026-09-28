import { Link } from 'react-router-dom';
export default function CheckoutPolicyLinks() {
  return <aside className="text-xs text-muted-foreground leading-relaxed space-y-2 my-4">
    <p>Before placing your order, review the <Link className="underline" to="/terms">Terms and Conditions</Link>, <Link className="underline" to="/shipping-policy">Shipping and Delivery</Link>, <Link className="underline" to="/refund-policy">Return and Refund</Link>, <Link className="underline" to="/cancellation-policy">Cancellation</Link> and <Link className="underline" to="/privacy">Privacy</Link> policies.</p>
    <p>Standard approved product returns are credited to your Rozare Wallet after funding is verified; they are not automatically refunded to the original card. Review the item’s return eligibility before purchase.</p>
  </aside>;
}
