import React from 'react';
import { Link } from 'react-router-dom';
import { Heart, Globe, Shield, Mail } from 'lucide-react';

function Footer() {
  return (
    <footer className="relative z-10 mt-16">
      <div className="glass-panel-strong mx-4 sm:mx-6 lg:mx-8 mb-6 p-8 sm:p-10">
        <div className="max-w-6xl mx-auto">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-8 mb-8">
            {/* Brand */}
            <div className="col-span-2 sm:col-span-1">
              <Link to="/" className="text-xl font-bold gradient-text">Tortrose</Link>
              <p className="text-xs mt-2 leading-relaxed" style={{ color: 'hsl(var(--muted-foreground))' }}>
                A modern marketplace built on trust, designed for independent sellers and thoughtful shoppers.
              </p>
            </div>

            {/* Shop */}
            <div>
              <h4 className="text-sm font-semibold mb-3" style={{ color: 'hsl(var(--foreground))' }}>Shop</h4>
              <ul className="space-y-2">
                <li><Link to="/" className="text-xs hover:opacity-80 transition-opacity" style={{ color: 'hsl(var(--muted-foreground))' }}>All Products</Link></li>
                <li><Link to="/stores" className="text-xs hover:opacity-80 transition-opacity" style={{ color: 'hsl(var(--muted-foreground))' }}>Stores</Link></li>
                <li><Link to="/stores/trusted" className="text-xs hover:opacity-80 transition-opacity" style={{ color: 'hsl(var(--muted-foreground))' }}>Trusted Stores</Link></li>
                <li><Link to="/become-seller" className="text-xs hover:opacity-80 transition-opacity" style={{ color: 'hsl(var(--muted-foreground))' }}>Become a Seller</Link></li>
              </ul>
            </div>

            {/* Support */}
            <div>
              <h4 className="text-sm font-semibold mb-3" style={{ color: 'hsl(var(--foreground))' }}>Support</h4>
              <ul className="space-y-2">
                <li><Link to="/faq" className="text-xs hover:opacity-80 transition-opacity" style={{ color: 'hsl(var(--muted-foreground))' }}>FAQ</Link></li>
                <li><Link to="/contact" className="text-xs hover:opacity-80 transition-opacity" style={{ color: 'hsl(var(--muted-foreground))' }}>Contact Us</Link></li>
                <li><Link to="/about" className="text-xs hover:opacity-80 transition-opacity" style={{ color: 'hsl(var(--muted-foreground))' }}>About</Link></li>
              </ul>
            </div>

            {/* Legal */}
            <div>
              <h4 className="text-sm font-semibold mb-3" style={{ color: 'hsl(var(--foreground))' }}>Legal</h4>
              <ul className="space-y-2">
                <li><Link to="/terms" className="text-xs hover:opacity-80 transition-opacity" style={{ color: 'hsl(var(--muted-foreground))' }}>Terms of Service</Link></li>
                <li><Link to="/privacy" className="text-xs hover:opacity-80 transition-opacity" style={{ color: 'hsl(var(--muted-foreground))' }}>Privacy Policy</Link></li>
              </ul>
            </div>
          </div>

          {/* Bottom */}
          <div className="pt-6 flex flex-col sm:flex-row items-center justify-between gap-3" style={{ borderTop: '1px solid var(--glass-border)' }}>
            <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>
              © {new Date().getFullYear()} Tortrose. All rights reserved.
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
