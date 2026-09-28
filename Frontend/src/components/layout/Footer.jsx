import React from 'react';
import { Link } from 'react-router-dom';
import { Heart, Globe, Shield, Mail } from 'lucide-react';
import { navigateToMainDomainPath, isSubdomain } from '../../utils/subdomainHelper';

function Footer() {
  // Handle navigation - redirect to main domain if on subdomain
  const handleNavClick = (e, path) => {
    if (isSubdomain()) {
      e.preventDefault();
      navigateToMainDomainPath(path);
    }
  };

  return (
    <footer className="relative z-10 mt-16">
      <div className="glass-panel-strong mx-4 sm:mx-6 lg:mx-8 mb-6 p-8 sm:p-10">
        <div className="max-w-6xl mx-auto">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-8 mb-8">
            {/* Brand */}
            <div className="col-span-2 sm:col-span-1">
              <Link to="/" onClick={(e) => handleNavClick(e, '/')} className="flex items-center">
                <img src="/rozare-logo.svg" alt="Rozare" className="h-8" />
              </Link>
              <p className="text-xs mt-2 leading-relaxed" style={{ color: 'hsl(var(--muted-foreground))' }}>
                Shop from independent sellers and manage your store or brand with dashboard tools, AI chat, and WhatsApp workflows.
              </p>
            </div>

            {/* Shop */}
            <div>
              <h4 className="text-sm font-semibold mb-3" style={{ color: 'hsl(var(--foreground))' }}>Shop</h4>
              <ul className="space-y-2">
                <li><Link to="/products" onClick={(e) => handleNavClick(e, '/products')} className="text-xs hover:opacity-80 transition-opacity" style={{ color: 'hsl(var(--muted-foreground))' }}>All Products</Link></li>
                <li><Link to="/" onClick={(e) => handleNavClick(e, '/')} className="text-xs hover:opacity-80 transition-opacity" style={{ color: 'hsl(var(--muted-foreground))' }}>Home</Link></li>
                <li><Link to="/stores" onClick={(e) => handleNavClick(e, '/stores')} className="text-xs hover:opacity-80 transition-opacity" style={{ color: 'hsl(var(--muted-foreground))' }}>Stores</Link></li>
                <li><Link to="/stores/trusted" onClick={(e) => handleNavClick(e, '/stores/trusted')} className="text-xs hover:opacity-80 transition-opacity" style={{ color: 'hsl(var(--muted-foreground))' }}>Trusted Stores</Link></li>
                <li><Link to="/become-seller" onClick={(e) => handleNavClick(e, '/become-seller')} className="text-xs hover:opacity-80 transition-opacity" style={{ color: 'hsl(var(--muted-foreground))' }}>Become a Seller</Link></li>
              </ul>
            </div>

            {/* Support */}
            <div>
              <h4 className="text-sm font-semibold mb-3" style={{ color: 'hsl(var(--foreground))' }}>Support</h4>
              <ul className="space-y-2">
                <li><Link to="/faq" onClick={(e) => handleNavClick(e, '/faq')} className="text-xs hover:opacity-80 transition-opacity" style={{ color: 'hsl(var(--muted-foreground))' }}>FAQ</Link></li>
                <li><Link to="/contact" onClick={(e) => handleNavClick(e, '/contact')} className="text-xs hover:opacity-80 transition-opacity" style={{ color: 'hsl(var(--muted-foreground))' }}>Contact Us</Link></li>
                <li><Link to="/about" onClick={(e) => handleNavClick(e, '/about')} className="text-xs hover:opacity-80 transition-opacity" style={{ color: 'hsl(var(--muted-foreground))' }}>About</Link></li>
                <li><Link to="/track-order" onClick={(e) => handleNavClick(e, '/track-order')} className="text-xs hover:opacity-80 transition-opacity" style={{ color: 'hsl(var(--muted-foreground))' }}>Track Order</Link></li>
                <li><a href={typeof window !== 'undefined' && window.location.hostname.endsWith('rozare.com') ? 'https://docs.rozare.com/' : '/docs'} className="text-xs hover:opacity-80 transition-opacity" style={{ color: 'hsl(var(--muted-foreground))' }}>Documentation</a></li>
              </ul>
            </div>

            {/* Legal */}
            <div>
              <h4 className="text-sm font-semibold mb-3" style={{ color: 'hsl(var(--foreground))' }}>Legal</h4>
              <ul className="space-y-2">
                <li><Link to="/terms" onClick={(e) => handleNavClick(e, '/terms')} className="text-xs hover:opacity-80 transition-opacity" style={{ color: 'hsl(var(--muted-foreground))' }}>Terms of Service</Link></li>
                <li><Link to="/privacy" onClick={(e) => handleNavClick(e, '/privacy')} className="text-xs hover:opacity-80 transition-opacity" style={{ color: 'hsl(var(--muted-foreground))' }}>Privacy Policy</Link></li>
                <li><Link to="/shipping-policy" onClick={(e) => handleNavClick(e, '/shipping-policy')} className="text-xs hover:opacity-80 transition-opacity" style={{ color: 'hsl(var(--muted-foreground))' }}>Shipping and Delivery</Link></li>
                <li><Link to="/refund-policy" onClick={(e) => handleNavClick(e, '/refund-policy')} className="text-xs hover:opacity-80 transition-opacity" style={{ color: 'hsl(var(--muted-foreground))' }}>Returns and Refunds</Link></li>
                <li><Link to="/cancellation-policy" onClick={(e) => handleNavClick(e, '/cancellation-policy')} className="text-xs hover:opacity-80 transition-opacity" style={{ color: 'hsl(var(--muted-foreground))' }}>Cancellation Policy</Link></li>
              </ul>
            </div>
          </div>

          {/* Bottom */}
          <div className="pt-6 flex flex-col sm:flex-row items-center justify-between gap-3" style={{ borderTop: '1px solid var(--glass-border)' }}>
            <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>
              © {new Date().getFullYear()} Rozare. All rights reserved.
            </p>
            <p className="text-xs flex items-center gap-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
              Made with <Heart size={12} style={{ color: 'hsl(var(--destructive))' }} /> for independent sellers
            </p>
          </div>
        </div>
      </div>
    </footer>
  );
}

export default Footer;
