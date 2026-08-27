'use strict';

/**
 * Product option/variant selection is shared by every server entry point that
 * can create a cart or order line.  Product.optionGroups is the canonical
 * source for modern options; Product.colors is retained as a legacy Color
 * option for older listings.
 *
 * A selection is deliberately explicit.  A seller may expose a `default`
 * value for presentation, but the client still has to send the selected value
 * (the default is not silently assumed at a money/inventory boundary).
 */

const MAX_OPTION_NAME_LENGTH = 100;
const MAX_OPTION_VALUE_LENGTH = 200;
const MAX_SELECTION_KEYS = 50;

const safeString = (value, { allowNumber = true } = {}) => {
  if (typeof value === 'string') return value.trim();
  if (allowNumber && typeof value === 'number' && Number.isFinite(value)) {
    return String(value).trim();
  }
  return '';
};

const caseKey = value => String(value || '').trim().toLowerCase();

/**
 * Convert a Mongoose Map/document or a JSON object to a plain object.  Arrays,
 * functions, and scalar values are not valid option maps and are represented
 * as an empty map plus an invalid-input marker by readSelectionOptions().
 */
const plainOptions = value => {
  if (value === null || value === undefined) return {};
  if (value instanceof Map) return Object.fromEntries(value.entries());
  if (typeof value?.toJSON === 'function') return plainOptions(value.toJSON());
  if (typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
};

const readSelectionOptions = value => {
  if (value === null || value === undefined) {
    return { options: {}, invalidInput: false };
  }
  if (value instanceof Map) return { options: plainOptions(value), invalidInput: false };
  if (typeof value?.toJSON === 'function') {
    const json = value.toJSON();
    return readSelectionOptions(json);
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { options: {}, invalidInput: true };
  }
  return { options: value, invalidInput: false };
};

const normalizeStringArray = value => {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const values = [];
  for (const raw of value) {
    const normalized = safeString(raw);
    if (!normalized || normalized.length > MAX_OPTION_VALUE_LENGTH) continue;
    const key = caseKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(normalized);
  }
  return values;
};

/**
 * Normalize seller-defined option groups while preserving the first display
 * spelling. Duplicate group names are merged case-insensitively so malformed
 * legacy rows cannot create two competing requirements for one option.
 */
function normalizeProductOptionGroups(product) {
  const rawGroups = Array.isArray(product?.optionGroups) ? product.optionGroups : [];
  const groups = [];
  const byName = new Map();

  for (const rawGroup of rawGroups) {
    const name = safeString(rawGroup?.name, { allowNumber: false });
    if (!name || name.length > MAX_OPTION_NAME_LENGTH) continue;
    const values = normalizeStringArray(rawGroup?.values);
    if (!values.length) continue;

    const key = caseKey(name);
    const existing = byName.get(key);
    if (existing) {
      const seen = new Set(existing.values.map(caseKey));
      for (const value of values) {
        if (!seen.has(caseKey(value))) {
          existing.values.push(value);
          seen.add(caseKey(value));
        }
      }
    } else {
      const group = { name, values: [...values] };
      groups.push(group);
      byName.set(key, group);
    }
  }

  return groups;
}

function findCaseInsensitive(value, choices = []) {
  const raw = safeString(value);
  if (!raw) return '';
  return choices.find(choice => caseKey(choice) === caseKey(raw)) || '';
}

function optionEntries(options) {
  return Object.entries(options || {}).map(([rawName, rawValue]) => ({
    rawName,
    name: safeString(rawName, { allowNumber: false }),
    value: safeString(rawValue),
    valueTypeValid: typeof rawValue === 'string'
      || (typeof rawValue === 'number' && Number.isFinite(rawValue)),
  }));
}

function findEntry(entries, name) {
  const key = caseKey(name);
  return entries.find(entry => caseKey(entry.name) === key);
}

function invalidOption(name, value, values = []) {
  return {
    name: String(name || '').trim() || 'Option',
    value: value === undefined || value === null ? '' : String(value),
    values: Array.isArray(values) ? values : [],
  };
}

/**
 * Validate and canonicalize a product selection.
 *
 * Return shape intentionally mirrors the existing AI action contract so web,
 * mobile, WhatsApp, and HTTP callers can render the same option picker:
 * `{ ok, selectedColor, selectedOptions, missingOptions, invalidOptions,
 *    requiredOptions, availableColors }`.
 */
function validateProductSelection(product, selections = {}) {
  const groups = normalizeProductOptionGroups(product);
  const legacyColors = normalizeStringArray(product?.colors);
  const { options: selectedOptions, invalidInput: selectedOptionsInvalid } =
    readSelectionOptions(selections?.selectedOptions);
  const entries = optionEntries(selectedOptions).slice(0, MAX_SELECTION_KEYS);
  const normalizedOptions = {};
  const missingOptions = [];
  const invalidOptions = [];
  const recognizedKeys = new Set();
  const hasColorGroup = groups.some(group => caseKey(group.name) === 'color');

  if (selectedOptionsInvalid) {
    invalidOptions.push(invalidOption('Options', '[invalid selection map]', []));
  }
  if (Object.keys(selectedOptions || {}).length > MAX_SELECTION_KEYS) {
    invalidOptions.push(invalidOption('Options', 'Too many selections', []));
  }

  const rawSelectedColor = selections?.selectedColor;
  const selectedColorTypeValid = rawSelectedColor === null
    || rawSelectedColor === undefined
    || typeof rawSelectedColor === 'string'
    || (typeof rawSelectedColor === 'number' && Number.isFinite(rawSelectedColor));
  let selectedColor = safeString(rawSelectedColor);
  if (!selectedColorTypeValid) {
    invalidOptions.push(invalidOption('Color', '[invalid selection]', []));
    selectedColor = '';
  }

  for (const group of groups) {
    const entry = findEntry(entries, group.name);
    const isColor = caseKey(group.name) === 'color';
    const rawFromColor = isColor && selectedColor ? selectedColor : '';
    const rawValue = entry ? entry.value : rawFromColor;

    if (entry) recognizedKeys.add(caseKey(entry.name));
    if (isColor && selectedColor) recognizedKeys.add('color');

    if (!entry && !rawFromColor) {
      missingOptions.push({ name: group.name, values: group.values });
      continue;
    }
    if (entry && (!entry.valueTypeValid || entry.value.length === 0 || entry.value.length > MAX_OPTION_VALUE_LENGTH)) {
      if (!entry.value) {
        missingOptions.push({ name: group.name, values: group.values });
      } else {
        invalidOptions.push(invalidOption(group.name, entry.value, group.values));
      }
      continue;
    }

    const chosen = findCaseInsensitive(rawValue, group.values);
    if (!chosen) {
      invalidOptions.push(invalidOption(group.name, rawValue, group.values));
      continue;
    }

    normalizedOptions[group.name] = chosen;
    if (isColor) {
      if (selectedColor && caseKey(selectedColor) !== caseKey(chosen)) {
        invalidOptions.push(invalidOption(group.name, selectedColor, group.values));
      }
      selectedColor = chosen;
    }
  }

  // Legacy colors are a required Color option when no modern Color group is
  // configured. Accept either selectedColor or selectedOptions.Color so older
  // clients and the modern option-map payload converge on one representation.
  if (!hasColorGroup && legacyColors.length > 0) {
    const colorEntry = findEntry(entries, 'Color');
    if (colorEntry) recognizedKeys.add(caseKey(colorEntry.name));
    const colorFromMap = colorEntry?.value || '';
    if (selectedColor && colorFromMap && caseKey(selectedColor) !== caseKey(colorFromMap)) {
      invalidOptions.push(invalidOption('Color', selectedColor, legacyColors));
    }
    const rawColor = selectedColor || colorFromMap;
    if (!rawColor) {
      missingOptions.push({ name: 'Color', values: legacyColors });
    } else if (colorEntry && (!colorEntry.valueTypeValid || colorEntry.value.length > MAX_OPTION_VALUE_LENGTH)) {
      invalidOptions.push(invalidOption('Color', colorEntry.value, legacyColors));
    } else {
      const chosenColor = findCaseInsensitive(rawColor, legacyColors);
      if (!chosenColor) {
        invalidOptions.push(invalidOption('Color', rawColor, legacyColors));
      } else {
        selectedColor = chosenColor;
      }
    }
  }

  // A color sent for a product that exposes neither a modern Color group nor
  // legacy colors is not a valid variant and must not be persisted as free-form
  // metadata. Empty/null values are the normal payload for products without
  // options and remain valid.
  if (selectedColor && hasColorGroup === false && legacyColors.length === 0) {
    invalidOptions.push(invalidOption('Color', selectedColor, []));
  }

  // Never persist arbitrary client-provided keys. Besides preventing fake
  // variant identities, this catches stale selections after a seller edits a
  // product's option groups.
  for (const entry of entries) {
    const key = caseKey(entry.name);
    if (!key || recognizedKeys.has(key)) continue;
    if (!entry.value) continue;
    invalidOptions.push(invalidOption(entry.name || 'Option', entry.value, []));
  }

  return {
    ok: missingOptions.length === 0 && invalidOptions.length === 0,
    selectedColor: selectedColor || null,
    selectedOptions: Object.keys(normalizedOptions).length > 0 ? normalizedOptions : undefined,
    missingOptions,
    invalidOptions,
    requiredOptions: groups.map(group => ({ name: group.name, values: group.values })),
    availableColors: legacyColors,
  };
}

function summarizeSelectionRequest(product, selection, action = 'checkout') {
  const missing = selection?.missingOptions || [];
  const invalid = selection?.invalidOptions || [];
  const details = [];
  for (const option of missing) {
    details.push(`${option.name}: ${option.values.join(', ')}`);
  }
  for (const option of invalid) {
    details.push(option.values.length > 0
      ? `${option.name} must be one of: ${option.values.join(', ')}`
      : `${option.name} is not an option for this product`);
  }
  const verb = action === 'add' ? 'add this product to your cart' : 'continue with checkout';
  const productName = safeString(product?.name, { allowNumber: false }) || 'This product';
  return `Please choose valid options for "${productName}" before you ${verb}.${details.length ? ` Available choices — ${details.join(' | ')}` : ''}`;
}

function createProductSelectionError(product, selection, action = 'add') {
  const hasInvalid = (selection?.invalidOptions || []).length > 0;
  const error = new Error(summarizeSelectionRequest(product, selection, action));
  error.status = 400;
  error.statusCode = 400;
  error.code = hasInvalid ? 'PRODUCT_OPTIONS_INVALID' : 'PRODUCT_OPTIONS_REQUIRED';
  error.needsSelection = true;
  error.productId = product?._id || null;
  error.productName = product?.name || '';
  error.requiredOptions = selection?.requiredOptions || [];
  error.availableColors = selection?.availableColors || [];
  error.missingOptions = selection?.missingOptions || [];
  error.invalidOptions = selection?.invalidOptions || [];
  return error;
}

function productSelectionErrorPayload(product, selection, action = 'add') {
  const error = createProductSelectionError(product, selection, action);
  return {
    msg: error.message,
    code: error.code,
    needsSelection: true,
    productId: error.productId,
    productName: error.productName,
    requiredOptions: error.requiredOptions,
    availableColors: error.availableColors,
    missingOptions: error.missingOptions,
    invalidOptions: error.invalidOptions,
  };
}

module.exports = {
  MAX_OPTION_NAME_LENGTH,
  MAX_OPTION_VALUE_LENGTH,
  MAX_SELECTION_KEYS,
  plainOptions,
  normalizeStringArray,
  normalizeProductOptionGroups,
  findCaseInsensitive,
  validateProductSelection,
  summarizeSelectionRequest,
  createProductSelectionError,
  productSelectionErrorPayload,
};
