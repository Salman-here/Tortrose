import { useEffect, useId, useRef, useState } from 'react'
import { readPriceRange } from '../../utils/priceFilters'

export default function PriceRangeFilter({ value, onChange, currency, sliderMax }) {
  const [draft, setDraft] = useState(value)
  const inputId = useId()
  const lastEmitted = useRef(JSON.stringify(value))
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const valueKey = JSON.stringify(value)
  useEffect(() => {
    if (valueKey !== lastEmitted.current) {
      setDraft(JSON.parse(valueKey))
      lastEmitted.current = valueKey
    }
  }, [valueKey])
  const { min, max, error } = readPriceRange(draft)
  useEffect(() => {
    if (error) return undefined
    const next = [String(min), max === null ? '' : String(max)]
    const key = JSON.stringify(next)
    if (key === lastEmitted.current) return undefined
    const timer = setTimeout(() => { lastEmitted.current = key; onChangeRef.current(next) }, 350)
    return () => clearTimeout(timer)
  }, [min, max, error])
  return <div className='space-y-3'>
    <div className='grid grid-cols-1 gap-3'>
      {['min', 'max'].map((field, index) => {
        const label = index === 0 ? 'Minimum' : 'Maximum'
        return <div key={field}>
          <label className='block text-xs font-medium mb-1' htmlFor={`${inputId}-${field}`}>{label} ({currency})</label>
          <input id={`${inputId}-${field}`} aria-label={`${label} price`} inputMode='decimal' type='text'
            value={draft[index]} placeholder={index === 0 ? '0' : 'No limit'} aria-invalid={!!error}
            onChange={event => { const text = event.target.value; setDraft(current => current.map((old, i) => i === index ? text : old)) }}
            className='glass-input w-full min-w-0 text-sm text-center' />
        </div>
      })}
    </div>
    {error ? <p role='alert' className='text-xs text-red-500'>{error}</p> : <>
      <input type='range' aria-label='Minimum price slider' min={0} max={Math.max(sliderMax, max ?? 0, min)} step='0.01' value={min}
        onChange={event => setDraft([String(Math.min(Number(event.target.value), max ?? Infinity)), draft[1]])}
        className='w-full h-2 rounded-full appearance-none cursor-pointer accent-indigo-600' />
      <p className='text-xs' style={{ color: 'hsl(var(--muted-foreground))' }}>{max === null ? 'No price limit' : `${min} – ${max} ${currency}`}</p>
    </>}
  </div>
}
