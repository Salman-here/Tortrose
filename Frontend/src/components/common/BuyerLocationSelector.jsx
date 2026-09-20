import { Globe, MapPin, ChevronDown } from 'lucide-react';
import { useBuyerLocation } from '../../contexts/BuyerLocationContext';
import { shoppingLocationLabel } from '../../utils/shoppingLocation';

export default function BuyerLocationSelector({ compact = false }) {
  const { buyerLocation, detecting, openLocationSelector, persistenceWarning } = useBuyerLocation();
  const Icon = buyerLocation.mode === 'global' ? Globe : MapPin;
  return (
    <div className={'glass-inner rounded-2xl p-3 sm:p-4 min-w-0 ' + (compact ? 'w-full' : '')}>
      <div className="flex items-center gap-3 min-w-0">
        <Icon size={20} className="shrink-0" style={{ color: 'hsl(var(--primary))' }} />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'hsl(var(--muted-foreground))' }}>Shopping location</p>
          <p className="text-sm font-bold break-words">{detecting ? 'Detecting your country…' : shoppingLocationLabel(buyerLocation)}</p>
        </div>
        <button type="button" onClick={openLocationSelector} className="glass-button px-3 py-2 rounded-xl text-xs font-semibold flex items-center gap-1" aria-label="Change shopping location">
          Change <ChevronDown size={14} />
        </button>
      </div>
      {persistenceWarning && <p role="status" className="text-xs mt-2">{persistenceWarning}</p>}
    </div>
  );
}
