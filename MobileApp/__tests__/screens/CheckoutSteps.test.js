import { readFileSync } from 'fs';
import { parse } from '@babel/parser';
import { createCheckoutReviewIdentity, getReviewedCheckoutStep } from '../../src/utils/checkoutProgress';

const cart = () => [{ product: { _id: 'p1', seller: 's1', price: 100, priceCurrency: 'PKR' }, qty: 2,
  selectedOptions: { Color: 'Blue', Size: 'M' } }];
const identity = (items = cart(), currency = 'PKR', owner = 'buyerA') => createCheckoutReviewIdentity(items, currency, owner);
const source = readFileSync(require.resolve('../../src/screens/CheckoutScreen.js'), 'utf8');

test('review progress is stable across object/order replacement, but changes in the exact order require cart review', () => {
  const initial = identity(), progress = { identity: initial, step: 2 };
  const equivalent = cart(); equivalent[0].selectedOptions = { Size: 'M', Color: 'Blue' };
  expect(identity(equivalent)).toBe(initial);
  expect(getReviewedCheckoutStep(progress, identity(equivalent))).toBe(2);
  for (const patch of [items => { items[0].qty = 3; }, items => { items[0].selectedOptions.Color = 'Red'; },
    items => { items[0].product.price = 101; }, items => { items[0].product.seller = 'otherSeller'; }]) {
    const changed = cart(); patch(changed);
    expect(getReviewedCheckoutStep(progress, identity(changed))).toBe(0);
  }
  expect(getReviewedCheckoutStep(progress, identity(cart(), 'USD'))).toBe(0);
  expect(getReviewedCheckoutStep(progress, identity(cart(), 'PKR', 'buyerB'))).toBe(0);
  expect(getReviewedCheckoutStep(progress, null)).toBe(0);
  expect(getReviewedCheckoutStep({ identity: initial, step: 3 }, initial)).toBe(0);
});

test('the actual screen mounts shipping only in step 2 and payment only in step 3', () => {
  const ast = parse(source, { sourceType: 'module', plugins: ['jsx'] });
  const sections = {};
  const walk = (node, ancestors = []) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'JSXText' && ['Order Items', 'Shipping Information', 'Payment Method'].includes(node.value.trim())) {
      const guards = ancestors.filter(parent => parent.type === 'LogicalExpression' && parent.operator === '&&')
        .map(parent => source.slice(parent.left.start, parent.left.end));
      sections[node.value.trim()] = guards;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'loc' || key === 'tokens') continue;
      if (Array.isArray(value)) value.forEach(child => walk(child, [...ancestors, node]));
      else if (value && typeof value === 'object') walk(value, [...ancestors, node]);
    }
  };
  walk(ast);
  expect(sections['Order Items']).toContain('currentStep === 0');
  expect(sections['Shipping Information']).toContain('currentStep === 1');
  expect(sections['Payment Method']).toContain('currentStep === 2');
  expect(source).toContain('if (currentStep !== 2) return;');
  expect(source).toContain('onPress={currentStep === 2 ? handlePlaceOrder : handleNextStep}');
  expect(source).toContain('key={currentStep}');
  const changeStep = source.split('const setCurrentStep = step => {')[1].split('\n  };')[0];
  expect(changeStep).not.toContain('setFormData');
  expect(source).toContain('step: currentStep - 1');
});

test('Next validates shipping and delivery, never posts or creates a payment', () => {
  const body = source.split('const handleNextStep = () => {')[1].split('\n  const autoFillShipping')[0].replace(/};\s*$/, '');
  const next = new Function('isProcessing', 'isCartReady', 'currentStep', 'setCurrentStep', 'validateForm',
    'summaryLoading', 'shippingError', 'shippingPricing', 'Feedback', body);
  const step = jest.fn(), validate = jest.fn(), show = jest.fn();
  const run = (index, valid = true, ready = true) => {
    validate.mockReturnValue(valid);
    return next(false, true, index, step, validate, !ready, '', { valid: ready }, { show });
  };
  run(0); expect(step).toHaveBeenLastCalledWith(1); expect(validate).not.toHaveBeenCalled();
  step.mockClear(); run(1, false); expect(step).not.toHaveBeenCalled();
  run(1, true, false); expect(step).not.toHaveBeenCalled();
  run(1, true, true); expect(step).toHaveBeenLastCalledWith(2);
  expect(body).not.toMatch(/api\.|handlePlaceOrder|getOrCreateCheckoutAttempt/);
});
