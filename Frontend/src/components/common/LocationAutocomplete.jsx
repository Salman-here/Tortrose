import { useEffect, useState } from 'react';
import axios from 'axios';
import { ChevronDown, Loader2, MapPin, X } from 'lucide-react';

const endpointByType = {
  country: 'countries',
  state: 'states',
  city: 'cities',
};

const listKeyByType = {
  country: 'countries',
  state: 'states',
  city: 'cities',
};

const clean = (value) => String(value || '').trim().replace(/\s+/g, ' ');

const optionLabel = (option, type) => {
  if (!option) return '';
  if (type === 'country') return `${option.name} (${option.isoCode})`;
  if (type === 'state') return `${option.name}${option.isoCode ? ` (${option.isoCode})` : ''}`;
  return `${option.name}${option.stateCode ? `, ${option.stateCode}` : ''}${option.countryCode ? `, ${option.countryCode}` : ''}`;
};

const selectedLabel = (value, code) => {
  const name = clean(value);
  const suffix = clean(code);
  if (!name) return '';
  return suffix && !name.toUpperCase().includes(`(${suffix.toUpperCase()})`) ? `${name} (${suffix})` : name;
};

const LocationAutocomplete = ({
  type = 'country',
  label = '',
  value = '',
  code = '',
  countryCode = '',
  countryName = '',
  stateCode = '',
  stateName = '',
  placeholder = 'Search location',
  disabled = false,
  required = false,
  onSelect,
  onClear,
  className = '',
  inputClassName = 'glass-input w-full',
}) => {
  const [query, setQuery] = useState(() => selectedLabel(value, code));
  const [options, setOptions] = useState([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) setQuery(selectedLabel(value, code));
  }, [value, code, open]);

  useEffect(() => {
    if (!open || disabled) return;

    const endpoint = endpointByType[type] || endpointByType.country;
    const listKey = listKeyByType[type] || listKeyByType.country;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        setLoading(true);
        setError('');
        const params = new URLSearchParams();
        params.set('limit', '35');
        if (clean(query)) params.set('q', clean(query).replace(/\([A-Z]{2,3}\)$/i, '').trim());
        if (type !== 'country') {
          if (countryCode) params.set('countryCode', countryCode);
          else if (countryName) params.set('country', countryName);
        }
        if (type === 'city') {
          if (stateCode) params.set('stateCode', stateCode);
          else if (stateName) params.set('state', stateName);
        }

        const res = await axios.get(`${import.meta.env.VITE_API_URL}api/locations/${endpoint}?${params.toString()}`, {
          signal: controller.signal,
        });
        setOptions(res.data?.[listKey] || []);
      } catch (err) {
        if (err.name === 'CanceledError' || err.code === 'ERR_CANCELED') return;
        setOptions([]);
        setError(err.response?.data?.msg || 'Locations unavailable');
      } finally {
        setLoading(false);
      }
    }, 180);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [countryCode, countryName, disabled, open, query, stateCode, stateName, type]);

  const commitOption = (option) => {
    setQuery(optionLabel(option, type));
    setOpen(false);
    onSelect?.(option);
  };

  const resetQuery = () => {
    setOpen(false);
    setQuery(selectedLabel(value, code));
  };

  return (
    <div className={`relative min-w-0 ${className}`}>
      {label && (
        <label className="block text-xs font-semibold uppercase tracking-wider mb-2 truncate" style={{ color: 'hsl(var(--muted-foreground))' }}>
          {label}{required ? ' *' : ''}
        </label>
      )}
      <div className="relative min-w-0">
        <input
          value={query}
          disabled={disabled}
          required={required}
          placeholder={placeholder}
          className={`${inputClassName} pr-16 min-w-0`}
          autoComplete="off"
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onBlur={() => {
            window.setTimeout(resetQuery, 140);
          }}
        />
        <div className="absolute inset-y-0 right-2 flex items-center gap-1">
          {loading && <Loader2 size={14} className="animate-spin" style={{ color: 'hsl(var(--muted-foreground))' }} />}
          {!disabled && clean(value) && (
            <button
              type="button"
              className="p-1 rounded-lg hover:bg-white/10"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                setQuery('');
                setOptions([]);
                setOpen(false);
                onClear?.();
              }}
              aria-label="Clear location"
            >
              <X size={14} />
            </button>
          )}
          <ChevronDown size={15} style={{ color: 'hsl(var(--muted-foreground))' }} />
        </div>
      </div>

      {open && !disabled && (
        <div
          className="absolute z-50 mt-2 w-full max-w-full max-h-64 overflow-y-auto rounded-xl p-1"
          style={{
            background: 'var(--glass-bg-strong)',
            border: '1px solid var(--glass-border)',
            boxShadow: '0 18px 45px rgba(15,23,42,0.18)',
            backdropFilter: 'blur(18px)',
          }}
        >
          {error ? (
            <div className="px-3 py-3 text-xs" style={{ color: 'hsl(0, 72%, 55%)' }}>{error}</div>
          ) : options.length === 0 && !loading ? (
            <div className="px-3 py-3 text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>No matching locations</div>
          ) : (
            options.map((option) => {
              const key = `${option.countryCode || option.isoCode}-${option.stateCode || ''}-${option.isoCode || ''}-${option.name}`;
              return (
                <button
                  key={key}
                  type="button"
                  className="w-full px-3 py-2.5 rounded-lg text-left text-sm flex items-center gap-2 hover:bg-white/10"
                  style={{ color: 'hsl(var(--foreground))' }}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => commitOption(option)}
                >
                  <MapPin size={14} className="shrink-0" style={{ color: 'hsl(var(--primary))' }} />
                  <span className="truncate">{optionLabel(option, type)}</span>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
};

export default LocationAutocomplete;
