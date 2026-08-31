const fs = require('fs');

describe('saved address modal layout safety', () => {
  test('gives the keyboard-aware form a bounded parent height on small screens', () => {
    const source = fs.readFileSync(
      require.resolve('../../src/screens/SavedAddressesScreen.js'),
      'utf8',
    );

    expect(source).toContain("height: '90%',");
    expect(source).toContain('<KeyboardAwareFormScrollView style={{ maxHeight: 460 }}>');
  });
});
