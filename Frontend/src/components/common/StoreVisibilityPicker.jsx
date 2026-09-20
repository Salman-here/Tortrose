import { Globe, MapPin } from 'lucide-react';
import LocationAutocomplete from './LocationAutocomplete';
import { STORE_VISIBILITY_OPTIONS, GLOBAL_SHIPPING_NOTICE } from '../../utils/storeVisibilityForm';

export default function StoreVisibilityPicker({ value, onChange, disabled = false }) {
  const patch = changes => onChange({ ...value, ...changes });
  return <div className="space-y-5">
    <div role="radiogroup" aria-label="Store visibility" className="grid grid-cols-2 sm:grid-cols-3 gap-3">
      {STORE_VISIBILITY_OPTIONS.map(option => <button key={option.mode} type="button" disabled={disabled} role="radio" aria-checked={value.mode === option.mode} onClick={() => patch({ mode: option.mode })} className="min-w-0 rounded-2xl p-4 text-left border transition-colors disabled:opacity-50" style={{ borderColor: value.mode === option.mode ? 'hsl(var(--primary))' : 'hsl(var(--border))', background: value.mode === option.mode ? 'hsl(var(--primary) / 0.1)' : 'var(--glass-bg)' }}>
        {option.mode === 'global' ? <Globe size={18} /> : <MapPin size={18} />}<span className="block text-sm font-semibold mt-2">{option.label}</span><span className="block text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>{option.description}</span>
      </button>)}
    </div>
    {value.mode === 'global' ? <p role="note" className="glass-inner rounded-2xl p-4 text-sm" style={{ border: '1px solid hsl(var(--primary) / 0.3)' }}>{GLOBAL_SHIPPING_NOTICE}</p> : <div className="space-y-4">
      <LocationAutocomplete type="country" label="Country" value={value.country} code={value.countryCode} disabled={disabled} onSelect={option => patch({ country: option.name, countryCode: option.isoCode, region: '', regionCode: '', city: '', cityStateCode: '', town: '', townStateCode: '' })} onClear={() => patch({ country: '', countryCode: '', region: '', regionCode: '', city: '', cityStateCode: '', town: '', townStateCode: '' })} />
      {['region', 'city', 'town'].includes(value.mode) && <LocationAutocomplete type="state" label="State / Province" value={value.region} code={value.regionCode} countryCode={value.countryCode} countryName={value.country} disabled={disabled || !value.countryCode} onSelect={option => patch({ region: option.name, regionCode: option.isoCode, city: '', cityStateCode: '', town: '', townStateCode: '' })} onClear={() => patch({ region: '', regionCode: '', city: '', cityStateCode: '', town: '', townStateCode: '' })} />}
      {['city', 'town'].includes(value.mode) && <LocationAutocomplete type="city" label="City" value={value.city} code={value.cityStateCode} countryCode={value.countryCode} countryName={value.country} stateCode={value.regionCode} stateName={value.region} disabled={disabled || !value.countryCode} onSelect={option => patch({ city: option.name, cityStateCode: option.stateCode || value.regionCode, town: '', townStateCode: '' })} onClear={() => patch({ city: '', cityStateCode: '', town: '', townStateCode: '' })} />}
      {value.mode === 'town' && <label className="block text-sm font-medium">Town / Area<input className="glass-input mt-2 w-full" value={value.town} maxLength={80} placeholder="For example, Johar Town" disabled={disabled || !value.city} onChange={event => patch({ town: event.target.value, townStateCode: value.cityStateCode || value.regionCode })} /></label>}
    </div>}
  </div>;
}
