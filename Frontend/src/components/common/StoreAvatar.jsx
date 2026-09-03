import { useState } from 'react';
import { Store } from 'lucide-react';

const SIZE_CONFIG = {
  xs: { frame: 'w-4 h-4 rounded-md', icon: 10 },
  sm: { frame: 'w-9 h-9 rounded-xl', icon: 16 },
  md: { frame: 'w-10 h-10 rounded-xl', icon: 20 },
};

const cleanLogo = value => (
  typeof value === 'string' && value.trim().length <= 4096
    ? value.trim()
    : ''
);

/**
 * A store identity image with a resilient marketplace-icon fallback. Broken
 * or missing remote media must never leave an empty avatar in commerce UI.
 */
const StoreAvatar = ({ logo, storeName = 'Store', size = 'md', className = '' }) => {
  const logoUrl = cleanLogo(logo);
  const [failedLogo, setFailedLogo] = useState('');
  const config = SIZE_CONFIG[size] || SIZE_CONFIG.md;
  const showLogo = Boolean(logoUrl && failedLogo !== logoUrl);

  return (
    <span
      className={`${config.frame} shrink-0 overflow-hidden flex items-center justify-center ${className}`}
      style={{
        background: 'rgba(99, 102, 241, 0.10)',
        border: '1px solid var(--glass-border-subtle)',
      }}
    >
      {showLogo ? (
        <img
          src={logoUrl}
          alt={`${storeName} logo`}
          className="w-full h-full object-cover"
          onError={() => setFailedLogo(logoUrl)}
        />
      ) : (
        <Store
          size={config.icon}
          aria-label={`${storeName} logo unavailable`}
          style={{ color: 'hsl(var(--primary))' }}
        />
      )}
    </span>
  );
};

export default StoreAvatar;
