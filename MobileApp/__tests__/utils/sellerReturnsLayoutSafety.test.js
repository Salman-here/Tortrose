const fs = require('fs');

describe('seller return status modal layout safety', () => {
  test('gives the keyboard-aware form a bounded parent height on Android', () => {
    const source = fs.readFileSync(
      require.resolve('../../src/components/SellerReturnsPanel.js'),
      'utf8',
    );

    expect(source).toContain("modalCard: { width: '100%', maxWidth: 540, height: '88%',");
    expect(source).toContain('<KeyboardAwareFormScrollView');
  });
});
