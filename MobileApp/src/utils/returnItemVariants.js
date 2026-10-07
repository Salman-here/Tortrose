const text = value => typeof value === 'string' && value.trim() ? value.trim() : null;
const owns = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);

export const readReturnItemVariants = item => {
  const result = {};
  const color = owns(item, 'selectedColor') ? text(item.selectedColor) : null;
  if (color) result.selectedColor = color;
  const options = owns(item, 'selectedOptions') ? item.selectedOptions : null;
  if (options && typeof options === 'object' && !Array.isArray(options)) {
    const seen = new Set();
    const pairs = Object.entries(options).flatMap(([rawName, rawValue]) => {
      const name = text(rawName), value = text(rawValue);
      const key = name?.toLocaleLowerCase();
      if (!name || !value || seen.has(key)) return [];
      seen.add(key);
      return [[name, value]];
    });
    if (pairs.length) result.selectedOptions = Object.fromEntries(pairs);
  }
  return result;
};

export const getReturnItemVariantLabels = item => {
  const variants = readReturnItemVariants(item);
  const pairs = Object.entries(variants.selectedOptions || {});
  const labels = pairs.map(([name, value]) => `${name}: ${value}`);
  const colorGroup = pairs.find(([name]) => ['color', 'colour'].includes(name.toLocaleLowerCase()));
  if (variants.selectedColor && colorGroup?.[1].toLocaleLowerCase() !== variants.selectedColor.toLocaleLowerCase()) {
    labels.push(`${colorGroup ? 'Selected color' : 'Color'}: ${variants.selectedColor}`);
  }
  return labels;
};
