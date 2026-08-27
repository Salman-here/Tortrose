/**
 * Product option helpers shared by the catalogue cards and product detail
 * page. Sellers can define flexible option groups (Size, Color, Material,
 * etc.) and older products may still expose a `colors` array. Keeping the
 * normalization in one place prevents the two buyer surfaces from drifting.
 */

const asTrimmedString = (value) => String(value ?? '').trim();

export const normalizeOptionValues = (values) => {
  if (!Array.isArray(values)) return [];

  const seen = new Set();
  return values.reduce((result, value) => {
    const normalized = asTrimmedString(value);
    const key = normalized.toLocaleLowerCase();
    if (!normalized || seen.has(key)) return result;
    seen.add(key);
    result.push(normalized);
    return result;
  }, []);
};

const findOptionValue = (value, values) => {
  const normalized = asTrimmedString(value).toLocaleLowerCase();
  if (!normalized) return '';
  return values.find((candidate) => candidate.toLocaleLowerCase() === normalized) || '';
};

const readSelection = (selections, name) => {
  if (!selections || typeof selections !== 'object' || Array.isArray(selections)) return '';
  if (Object.prototype.hasOwnProperty.call(selections, name)) return selections[name];
  const key = Object.keys(selections).find(
    (candidate) => candidate.toLocaleLowerCase() === String(name).toLocaleLowerCase(),
  );
  return key ? selections[key] : '';
};

/**
 * Return buyer-facing option groups with clean names/values. Legacy colors
 * become a synthetic Color group so every entry point gets the same picker.
 * Empty or malformed groups are ignored; the API cannot validate a group with
 * no selectable values and showing one would trap the buyer in the dialog.
 */
export const normalizeProductOptionGroups = (product = {}) => {
  const groups = [];
  const seenNames = new Set();
  const sourceGroups = Array.isArray(product?.optionGroups) ? product.optionGroups : [];

  sourceGroups.forEach((group) => {
    const name = asTrimmedString(group?.name);
    const values = normalizeOptionValues(group?.values);
    const nameKey = name.toLocaleLowerCase();
    if (!name || !values.length || seenNames.has(nameKey)) return;

    seenNames.add(nameKey);
    groups.push({
      name,
      values,
      default: findOptionValue(group?.default, values),
      legacy: false,
    });
  });

  const legacyColors = normalizeOptionValues(product?.colors);
  if (legacyColors.length && !seenNames.has('color')) {
    groups.push({
      name: 'Color',
      values: legacyColors,
      default: '',
      legacy: true,
    });
  }

  return groups;
};

export const hasProductOptions = (product = {}) => normalizeProductOptionGroups(product).length > 0;

/**
 * Validate an explicit buyer selection without silently applying seller
 * defaults. Defaults are presentation hints in the picker; reaching a cart
 * or checkout boundary still requires a concrete submitted value.
 */
export const validateProductSelection = (
  product = {},
  selectedOptions = {},
  selectedColor = null,
) => {
  const groups = normalizeProductOptionGroups(product);
  const normalizedOptions = {};
  const missingOptions = [];
  const invalidOptions = [];
  const rawColor = asTrimmedString(selectedColor);
  let color = null;

  groups.forEach((group) => {
    const fromOptions = readSelection(selectedOptions, group.name);
    const raw = asTrimmedString(fromOptions)
      || (group.name.toLocaleLowerCase() === 'color' ? rawColor : '');

    if (!raw) {
      missingOptions.push({ name: group.name, values: group.values });
      return;
    }

    const chosen = findOptionValue(raw, group.values);
    if (!chosen) {
      invalidOptions.push({ name: group.name, value: raw, values: group.values });
      return;
    }

    if (
      group.name.toLocaleLowerCase() === 'color'
      && rawColor
      && asTrimmedString(fromOptions)
      && rawColor.toLocaleLowerCase() !== chosen.toLocaleLowerCase()
    ) {
      invalidOptions.push({ name: group.name, value: rawColor, values: group.values });
      return;
    }

    if (group.legacy) {
      color = chosen;
    } else {
      normalizedOptions[group.name] = chosen;
      if (group.name.toLocaleLowerCase() === 'color') color = chosen;
    }
  });

  const knownNames = new Set(groups.map((group) => group.name.toLocaleLowerCase()));
  if (selectedOptions && typeof selectedOptions === 'object' && !Array.isArray(selectedOptions)) {
    Object.entries(selectedOptions).forEach(([name, value]) => {
      if (!asTrimmedString(value) || knownNames.has(name.toLocaleLowerCase())) return;
      invalidOptions.push({ name, value: asTrimmedString(value), values: [] });
    });
  } else if (selectedOptions !== null && selectedOptions !== undefined) {
    invalidOptions.push({ name: 'Options', value: 'Invalid selection', values: [] });
  }

  const hasColor = groups.some((group) => group.name.toLocaleLowerCase() === 'color');
  if (rawColor && !hasColor) {
    invalidOptions.push({ name: 'Color', value: rawColor, values: [] });
  }

  return {
    ok: missingOptions.length === 0 && invalidOptions.length === 0,
    selectedOptions: Object.keys(normalizedOptions).length ? normalizedOptions : null,
    selectedColor: color,
    missingOptions,
    invalidOptions,
    groups,
  };
};

/**
 * Build a canonical selection for a product from values the buyer has already
 * chosen. Seller defaults remain visible suggestions in the picker, but they
 * are never converted into consent at a cart boundary.
 */
export const createProductSelection = (
  product = {},
  selectedOptions = {},
  selectedColor = null,
) => {
  const groups = normalizeProductOptionGroups(product);
  const options = {};
  const hasRealColorGroup = groups.some(
    (group) => !group.legacy && group.name.toLocaleLowerCase() === 'color',
  );
  let color = hasRealColorGroup
    ? null
    : findOptionValue(selectedColor, normalizeOptionValues(product?.colors));

  groups.forEach((group) => {
    const values = group.values;
    const fromOptions = findOptionValue(readSelection(selectedOptions, group.name), values);
    const fromColor = group.name.toLocaleLowerCase() === 'color'
      ? findOptionValue(color || readSelection(selectedOptions, 'Color'), values)
      : '';
    const chosen = fromOptions || fromColor;
    if (!chosen) return;

    if (group.legacy) {
      color = chosen;
    } else {
      options[group.name] = chosen;
    }
  });

  return {
    selectedOptions: options,
    selectedColor: color || null,
  };
};

/**
 * Canonical payload used by the add-to-cart call. Synthetic legacy Color is
 * represented by `selectedColor`; real option groups are sent in
 * `selectedOptions`, matching the server contract.
 */
export const getProductSelectionPayload = (product = {}, selectedOptions = {}, selectedColor = null) => {
  const selection = validateProductSelection(product, selectedOptions, selectedColor);
  return {
    selectedOptions: selection.selectedOptions,
    selectedColor: selection.selectedColor,
  };
};

export const isProductSelectionComplete = (
  product = {},
  selectedOptions = {},
  selectedColor = null,
) => {
  return validateProductSelection(product, selectedOptions, selectedColor).ok;
};

export const getMissingProductOptionGroups = (
  product = {},
  selectedOptions = {},
  selectedColor = null,
) => {
  const selection = validateProductSelection(product, selectedOptions, selectedColor);
  return selection.missingOptions;
};
