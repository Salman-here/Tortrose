import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router-dom';
import { Globe, MapPin, X } from 'lucide-react';
import { useBuyerLocation } from '../../contexts/BuyerLocationContext';
import { useAuth } from '../../contexts/AuthContext';
import { EMPTY_SHOPPING_LOCATION, shoppingCountryPatch, shoppingLocationIsValid } from '../../utils/shoppingLocation';
import LocationAutocomplete from './LocationAutocomplete';

export default function ShoppingLocationPrompt() {
  const { pathname } = useLocation();
  const { currentUser } = useAuth();
  const { buyerLocation, recommendedLocation, detecting, selectionRequired, editorOpen,
    closeLocationSelector, updateBuyerLocation } = useBuyerLocation();
  const catalogRoute = pathname === '/' || /^\/(products|stores|store|single-product|marketplace|trusted-stores)(\/|$)/.test(pathname)
    || (pathname === '/ai-chat' && !['seller', 'admin'].includes(currentUser?.role));
  const open = editorOpen || (selectionRequired && catalogRoute);
  const [draft, setDraft] = useState(buyerLocation);
  const touched = useRef(false);
  const dialog = useRef(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    if (open && !wasOpen.current) touched.current = false;
    if (open && !touched.current) {
      setDraft(selectionRequired
        ? { ...EMPTY_SHOPPING_LOCATION, country: buyerLocation.country, countryCode: buyerLocation.countryCode }
        : { ...buyerLocation });
    }
    wasOpen.current = open;
  }, [open, buyerLocation, selectionRequired]);

  useEffect(() => {
    if (!open) return undefined;
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.current?.focus();
    const onKey = event => {
      if (event.key === 'Escape' && !selectionRequired) { event.preventDefault(); closeLocationSelector(); }
      if (event.key !== 'Tab') return;
      const nodes = [...(dialog.current?.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex="0"]') || [])];
      if (!nodes.length) { event.preventDefault(); return; }
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.body.style.overflow = previousOverflow; document.removeEventListener('keydown', onKey); previousFocus?.focus?.(); };
  }, [open, selectionRequired, closeLocationSelector]);

  const change = patch => { touched.current = true; setDraft(previous => ({ ...previous, ...patch })); };
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[10000] bg-black/45 backdrop-blur-sm flex items-center justify-center p-3 sm:p-6">
      <section ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="shopping-location-title" onFocusCapture={event => { if (event.target.tagName === 'INPUT') touched.current = true; }} className="glass-panel w-full max-w-xl max-h-[90dvh] overflow-y-auto rounded-3xl p-5 sm:p-7 outline-none" style={{ background: 'hsl(var(--background))' }}>
        <div className="flex items-start justify-between gap-3">
          <div><h2 id="shopping-location-title" className="text-xl font-bold">Where would you like to shop?</h2>
            <p className="text-sm mt-2" style={{ color: 'hsl(var(--muted-foreground))' }}>Choose a country or explore stores that sell globally.</p></div>
          {!selectionRequired && <button type="button" onClick={closeLocationSelector} aria-label="Close shopping location" className="glass-button p-2 rounded-full"><X size={18} /></button>}
        </div>
        <div role="radiogroup" aria-label="Shopping location mode" className="grid grid-cols-2 gap-3 mt-5">
          {[{ mode: 'country', icon: MapPin, title: 'Country', detail: 'Stores serving your selected country' }, { mode: 'global', icon: Globe, title: 'Global', detail: 'Global stores + stores in your country' }].map(({ mode, icon: Icon, title, detail }) => (
            <button key={mode} type="button" role="radio" aria-checked={draft.mode === mode} onClick={() => change({ mode })} className="text-left min-w-0 rounded-2xl p-4 border-2 transition-colors" style={{ borderColor: draft.mode === mode ? 'hsl(var(--primary))' : 'hsl(var(--border))', background: draft.mode === mode ? 'hsl(var(--primary) / 0.09)' : 'transparent' }}>
              <Icon size={22} /><span className="block font-semibold mt-2">{title}</span><span className="block text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>{detail}</span>
            </button>
          ))}
        </div>
        {draft.mode === 'global' && <p className="text-xs mt-4" style={{ color: 'hsl(var(--muted-foreground))' }}>{detecting ? 'Detecting your country to include local stores…' : recommendedLocation.country ? `Includes Global stores and stores serving ${recommendedLocation.country}.` : 'If your country cannot be identified, only Global stores are shown.'}</p>}
        {draft.mode === 'country' && <div className="mt-5 space-y-4">
          <p className="text-xs" role="status">{detecting ? 'Detecting your country… You can also choose it below.' : recommendedLocation.country ? 'Suggested country: ' + recommendedLocation.country + '. You can choose another country.' : selectionRequired ? 'We could not reliably detect your country. Choose a country below or select Global.' : 'Choose a country below.'}</p>
          <LocationAutocomplete type="country" label="Country" value={draft.country} code={draft.countryCode} placeholder="Choose a country" onSelect={option => change(shoppingCountryPatch(option))} onClear={() => change(shoppingCountryPatch(null))} />
          {!selectionRequired && <>
            <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>Optional: include stores serving your state, city or town by selecting a matching local area.</p>
            <LocationAutocomplete type="state" label="State / Province (optional)" value={draft.region} code={draft.regionCode} countryCode={draft.countryCode} countryName={draft.country} disabled={!draft.countryCode} onSelect={option => change({ region: option.name, regionCode: option.isoCode, city: '', cityStateCode: '', town: '', townStateCode: '' })} onClear={() => change({ region: '', regionCode: '', city: '', cityStateCode: '', town: '', townStateCode: '' })} />
            <LocationAutocomplete type="city" label="City (optional)" value={draft.city} code={draft.cityStateCode} countryCode={draft.countryCode} countryName={draft.country} stateCode={draft.regionCode} stateName={draft.region} disabled={!draft.countryCode} onSelect={option => change({ city: option.name, cityStateCode: option.stateCode || draft.regionCode, town: '', townStateCode: '' })} onClear={() => change({ city: '', cityStateCode: '', town: '', townStateCode: '' })} />
            <label className="block text-sm font-medium">Town / Area (optional)<input className="glass-input mt-2 w-full" value={draft.town} maxLength={80} placeholder="Select a city, then enter your town or area" disabled={!draft.city} onChange={event => change({ town: event.target.value, townStateCode: draft.cityStateCode || draft.regionCode })} /></label>
          </>}
        </div>}
        <p className="text-xs mt-5" style={{ color: 'hsl(var(--muted-foreground))' }}>You can change your selection any time in Filters. This does not change your currency or delivery address.</p>
        <button type="button" disabled={!shoppingLocationIsValid(draft)} onClick={() => updateBuyerLocation(draft)} className="w-full mt-4 px-5 py-3 rounded-xl text-sm font-semibold disabled:opacity-50" style={{ color: 'hsl(var(--primary-foreground))', background: 'hsl(var(--primary))' }}>{selectionRequired ? 'Start shopping' : 'Save shopping location'}</button>
      </section>
    </div>, document.body,
  );
}
