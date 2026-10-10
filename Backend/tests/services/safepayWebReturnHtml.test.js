'use strict';
const vm = require('node:vm');
const { renderSafepayWebReturnHtml } = require('../../services/safepayWebReturnHtml');

const paymentId = '6ab6e29eba71edafe4fc7596';
const nonce = 'abcdefghijklmnopqrstuvwx';
const render = extra => renderSafepayWebReturnHtml({ paymentId, nonce, ...extra });
function run({ embedded = true } = {}) {
  const html = render();
  const postMessage = jest.fn();
  const replace = jest.fn();
  const window = { parent: { postMessage }, location: { replace } };
  if (!embedded) window.parent = window;
  vm.runInNewContext(html.match(/<script nonce="[^"]+">([\s\S]+?)<\/script>/)[1], { window });
  return { html, postMessage, replace };
}

test('embedded return signals navigation only to the two fixed website origins', () => {
  const { html, postMessage, replace } = run();
  expect(postMessage.mock.calls.map(([signal, origin]) => ({ signal: JSON.parse(JSON.stringify(signal)), origin }))).toEqual([
    { signal: { type: 'rozare-safepay-return', paymentId }, origin: 'https://rozare.com' },
    { signal: { type: 'rozare-safepay-return', paymentId }, origin: 'https://www.rozare.com' },
  ]);
  expect(replace).not.toHaveBeenCalled();
  expect(html).toContain(`nonce="${nonce}"`);
  expect(html).toContain(`href="https://rozare.com/safepay/return?paymentId=${paymentId}" target="_blank" rel="noopener noreferrer"`);
  expect(html).not.toMatch(/isPaid|status:|outcome|cancelled|fetch\(/);
});

test('a bridge opened outside an iframe navigates only to the fixed payment status page', () => {
  const { postMessage, replace } = run({ embedded: false });
  expect(replace).toHaveBeenCalledWith(`https://rozare.com/safepay/return?paymentId=${paymentId}`);
  expect(postMessage).not.toHaveBeenCalled();
});

test.each([
  { paymentId: 'bad' }, { paymentId: `${paymentId}<script>` }, { paymentId: [] },
  { nonce: '" onload="alert(1)' }, { nonce: '<script>fixture</script>' }, { nonce: undefined },
])('return renderer rejects unsafe references and script nonces: %j', extra => {
  expect(() => render(extra)).toThrow('Invalid web payment return screen.');
});
