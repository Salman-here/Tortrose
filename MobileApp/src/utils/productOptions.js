/**
 * Buyer-facing product option helpers.
 *
 * Product options have existed in two shapes in the catalog:
 *   - optionGroups: [{ name: 'Size', values: ['S', 'M'] }]
 *   - colors: ['Black', 'White'] (legacy)
 *
 * Keep the normalization here so cards, product detail, and the cart submit
 * path all agree about what a valid selection looks like.  Values are matched
 * case-insensitively but the catalog's canonical spelling is returned.
 */

const hasSelectionValue = (value) => (
  value !== undefined
  && value !== null
  && String(value).trim() !== ''
);

const normalizeValues = (values) => {
  if (!Array.isArray(values)) return [];

  const seen = new Set();
  return values
    .map((value) => String(value ?? '').trim())
    .filter((value) => {
      if (!value) return false;
      const key = value.toLocaleLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
};

const canonicalValue = (value, values) => {
  if (!hasSelectionValue(value)) return null;
  const key = String(value).trim().toLocaleLowerCase();
  return values.find((candidate) => candidate.toLocaleLowerCase() === key) || null;
};

const rawOptionGroups = (source) => {
  if (Array.isArray(source)) return source;
  if (Array.isArray(source?.optionGroups)) return source.optionGroups;
  // A few early catalog/import payloads used `options` before the Product
  // model settled on `optionGroups`; accepting it here keeps old products
  // selectable without weakening the server contract.
  if (Array.isArray(source?.options)) return source.options;
  return [];
};

/**
 * Normalize option groups and discard unusable groups. Duplicate names are
 * collapsed case-insensitively so a malformed payload cannot render two
 * controls that overwrite the same selectedOptions key.
 */
export const normalizeProductOptionGroups = (source) => {
  const seenNames = new Set();

  return rawOptionGroups(source)
    .map((group) => {
      const name = String(group?.name ?? '').trim();
      const values = normalizeValues(group?.values);
      const defaultValue = canonicalValue(group?.default, values);
      return {
        name,
        values,
        default: defaultValue,
      };
    })
    .filter((group) => {
      if (!group.name || group.values.length === 0) return false;
      const key = group.name.toLocaleLowerCase();
      if (seenNames.has(key)) return false;
      seenNames.add(key);
      return true;
    });
};

/**
 * Return every required buyer option. Legacy colors become a synthetic Color
 * group only when a real Color option group is not already present.
 */
export const getProductOptionGroups = (product) => {
  const groups = normalizeProductOptionGroups(product).map((group) => ({
    ...group,
    legacy: false,
  }));

  const hasColorGroup = groups.some((group) => group.name.toLocaleLowerCase() === 'color');
  const legacyColors = normalizeValues(product?.colors);
  if (!hasColorGroup && legacyColors.length > 0) {
    groups.push({
      name: 'Color',
      values: legacyColors,
      default: null,
      legacy: true,
    });
  }

  return groups;
};

export const hasProductOptions = (product) => getProductOptionGroups(product).length > 0;

const optionValueForGroup = (selectedOptions, groupName) => {
  if (!selectedOptions || typeof selectedOptions !== 'object' || Array.isArray(selectedOptions)) {
    return undefined;
  }
  if (Object.prototype.hasOwnProperty.call(selectedOptions, groupName)) {
    return selectedOptions[groupName];
  }
  const matchingKey = Object.keys(selectedOptions).find(
    (key) => key.toLocaleLowerCase() === groupName.toLocaleLowerCase(),
  );
  return matchingKey ? selectedOptions[matchingKey] : undefined;
};

/**
 * Seed a selection draft only from values the buyer has already chosen.
 * Seller defaults are suggestions in the sheet and never implicit consent.
 */
export const getInitialProductSelections = (product, selections = {}) => {
  const groups = getProductOptionGroups(product);
  const normalizedOptions = {};
  let selectedColor = canonicalValue(selections.selectedColor, normalizeValues(product?.colors));

  groups.forEach((group) => {
    const raw = optionValueForGroup(selections.selectedOptions, group.name);
    const chosen = canonicalValue(raw, group.values)
      || canonicalValue(group.name.toLocaleLowerCase() === 'color' ? selections.selectedColor : undefined, group.values);

    if (!chosen) return;
    if (group.legacy) {
      selectedColor = chosen;
    } else {
      normalizedOptions[group.name] = chosen;
      if (group.name.toLocaleLowerCase() === 'color') selectedColor = chosen;
    }
  });

  return {
    selectedColor: selectedColor || null,
    selectedOptions: Object.keys(normalizedOptions).length > 0 ? normalizedOptions : {},
  };
};

/**
 * Validate and canonicalize a buyer's option selection.
 *
 * `missingOptions` and `invalidOptions` are intentionally structured so the
 * native sheet can highlight the exact group rather than showing a generic
 * error toast.
 */
export const validateProductSelections = (product, selections = {}) => {
  const groups = getProductOptionGroups(product);
  const normalizedOptions = {};
  const missingOptions = [];
  const invalidOptions = [];
  const inputColor = hasSelectionValue(selections.selectedColor)
    ? String(selections.selectedColor).trim()
    : null;
  let selectedColor = hasSelectionValue(selections.selectedColor)
    ? String(selections.selectedColor).trim()
    : null;
  let selectedCount = 0;

  if (
    selections.selectedColor !== undefined
    && selections.selectedColor !== null
    && typeof selections.selectedColor !== 'string'
    && !(typeof selections.selectedColor === 'number' && Number.isFinite(selections.selectedColor))
  ) {
    invalidOptions.push({ name: 'Color', value: 'Invalid selection', values: [] });
  }

  groups.forEach((group) => {
    const rawFromOptions = optionValueForGroup(selections.selectedOptions, group.name);
    const raw = hasSelectionValue(rawFromOptions)
      ? rawFromOptions
      : group.name.toLocaleLowerCase() === 'color' && hasSelectionValue(selectedColor)
        ? selectedColor
        : undefined;

    if (!hasSelectionValue(raw)) {
      missingOptions.push({ name: group.name, values: group.values });
      return;
    }

    const chosen = canonicalValue(raw, group.values);
    if (!chosen) {
      invalidOptions.push({ name: group.name, value: String(raw).trim(), values: group.values });
      return;
    }

    if (
      group.name.toLocaleLowerCase() === 'color'
      && hasSelectionValue(rawFromOptions)
      && inputColor
      && inputColor.toLocaleLowerCase() !== chosen.toLocaleLowerCase()
    ) {
      invalidOptions.push({ name: group.name, value: inputColor, values: group.values });
      return;
    }

    if (group.legacy) {
      selectedColor = chosen;
    } else {
      normalizedOptions[group.name] = chosen;
      if (group.name.toLocaleLowerCase() === 'color') selectedColor = chosen;
    }
    selectedCount += 1;
  });

  const knownNames = new Set(groups.map((group) => group.name.toLocaleLowerCase()));
  if (
    selections.selectedOptions !== undefined
    && selections.selectedOptions !== null
    && (typeof selections.selectedOptions !== 'object' || Array.isArray(selections.selectedOptions))
  ) {
    invalidOptions.push({ name: 'Options', value: 'Invalid selection', values: [] });
  } else {
    Object.entries(selections.selectedOptions || {}).forEach(([name, value]) => {
      if (!hasSelectionValue(value) || knownNames.has(name.toLocaleLowerCase())) return;
      invalidOptions.push({ name, value: String(value).trim(), values: [] });
    });
  }

  const hasColorGroup = groups.some((group) => group.name.toLocaleLowerCase() === 'color');
  if (inputColor && !hasColorGroup) {
    invalidOptions.push({ name: 'Color', value: inputColor, values: [] });
  }

  return {
    ok: missingOptions.length === 0 && invalidOptions.length === 0,
    groups,
    selectedColor: selectedColor || null,
    selectedOptions: Object.keys(normalizedOptions).length > 0 ? normalizedOptions : undefined,
    missingOptions,
    invalidOptions,
    selectedCount,
    totalCount: groups.length,
  };
};

export const describeSelectionError = (validation) => {
  if (!validation || validation.ok) return '';
  const missing = validation.missingOptions || [];
  if (missing.length === 1) return `Choose ${missing[0].name.toLowerCase()} to continue`;
  if (missing.length > 1) return `Choose ${missing.length} options to continue`;
  return 'Review your product options to continue';
};

export default {
  normalizeProductOptionGroups,
  getProductOptionGroups,
  hasProductOptions,
  getInitialProductSelections,
  validateProductSelections,
  describeSelectionError,
};
