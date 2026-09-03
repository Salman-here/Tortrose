import fs from 'fs';
import path from 'path';

const source = fs.readFileSync(
  path.resolve(__dirname, '../../src/screens/HomeScreen.js'),
  'utf8'
);

describe('Home filter sheet presentation', () => {
  const filterSheet = source.match(
    /const renderFilterModal = \(\) => \{[\s\S]*?\n  const renderEmptyState/
  )?.[0] || '';

  it('uses a bounded, explicit viewport height so Android cannot collapse the filters', () => {
    expect(source).toContain('const filterSheetHeight = Math.min(viewportHeight * 0.92, 760);');
    expect(filterSheet).toContain('style={[styles.modalContent, { height: filterSheetHeight }]}');
    expect(source).toContain('modalBody: { flex: 1, minHeight: 0 }');
  });

  it('uses the native modal ScrollView for reliable Android rendering and interaction', () => {
    expect(filterSheet).toContain('<ScrollView');
    expect(filterSheet).toContain('keyboardShouldPersistTaps="handled"');
    expect(filterSheet).toContain('nestedScrollEnabled');
    expect(filterSheet).not.toContain('<KeyboardAwareFormScrollView');
  });

  it('keeps the modal discoverable to accessibility and automation', () => {
    expect(source).toContain('onPress={openFilters}');
    expect(source).toContain('setShowFilters(true);');
    expect(filterSheet).toContain('visible={showFilters}');
    expect(filterSheet).toContain('accessibilityViewIsModal');
    expect(filterSheet).toContain('testID="home-filter-modal"');
    expect(filterSheet).toContain('accessibilityLabel="Apply filters"');
  });
});
