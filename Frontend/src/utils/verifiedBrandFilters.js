export function verifiedBrandOptions(value) {
  const seen = new Set()
  return (Array.isArray(value) ? value : []).filter(option => {
    if (option?.verified !== true || !/^[a-f\d]{24}$/i.test(option.value || '') || typeof option.label !== 'string' || !option.label.trim() || seen.has(option.value)) return false
    seen.add(option.value)
    return true
  })
}
export const verifiedBrandLabel = (options, id) => options.find(option => option.value === id)?.label || 'Unavailable brand'
