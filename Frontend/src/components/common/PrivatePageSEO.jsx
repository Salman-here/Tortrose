import { useLocation } from 'react-router-dom';
import { isPrivatePath } from '../../utils/indexingPolicy';
import SEOHead from './SEOHead';

export default function PrivatePageSEO() {
  const { pathname } = useLocation();
  if (!isPrivatePath(pathname)) return null;
  return <SEOHead title="Your Rozare Account" description="Secure access to your Rozare account, orders and payment settings." noindex />;
}
