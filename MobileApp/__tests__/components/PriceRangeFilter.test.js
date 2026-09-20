import React, { useState } from 'react';
import { Text } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';
import PriceRangeFilter from '../../src/components/common/PriceRangeFilter';
import { parsePriceFilterInput, priceFilterError } from '../../src/utils/priceFilters';
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('../../src/contexts/ThemeContext', () => ({ useTheme: () => ({ palette: require('../../src/styles/palettes').lightPalette }) }));
jest.mock('../../src/contexts/CurrencyContext', () => ({ useCurrency: () => ({ currency: 'USD', convertAmount: amount => amount, exchangeRatesFallback: false, exchangeRatesLoading: false, formatAmount: (amount, options) => options.targetCurrency + ' ' + amount.toFixed(options.decimals) }) }));
function Harness() {
  const [range, setRange] = useState({ min: 0, max: null });
  return <><PriceRangeFilter {...range} onChange={setRange} /><Text testID="range">{JSON.stringify(range)}</Text></>;
}
test('decimal typing is retained, zero is a real maximum, and inverted ranges are explained', () => {
  const screen = render(<Harness />);
  const minimum = () => screen.getByLabelText('Minimum price'), maximum = () => screen.getByLabelText('Maximum price');
  fireEvent.changeText(minimum(), '1'); fireEvent.changeText(minimum(), '1.');
  expect(minimum().props.value).toBe('1.');
  fireEvent.changeText(minimum(), '1.25'); expect(minimum().props.value).toBe('1.25');
  fireEvent.changeText(maximum(), '0');
  expect(screen.getByText('Minimum price cannot exceed maximum price.')).toBeTruthy();
  fireEvent.changeText(minimum(), '');
  expect(screen.getByTestId('range').props.children).toBe('{"min":0,"max":0}');
  expect(maximum().props.value).toBe('0');
  fireEvent.changeText(maximum(), ''); expect(screen.getByTestId('range').props.children).toBe('{"min":0,"max":null}');
});
test('inclusive presets describe the actual inclusive filter boundary', () => {
  const screen = render(<Harness />); fireEvent.press(screen.getByLabelText('Up to USD 25'));
  expect(screen.getByTestId('range').props.children).toBe('{"min":0,"max":25}');
});
test('threshold validation never converts invalid or partial text to an unrelated price', () => {
  expect(parsePriceFilterInput('1,000.50')).toBe(1000.5); expect(parsePriceFilterInput('0')).toBe(0);
  expect(parsePriceFilterInput('')).toBeNull();
  for (const value of ['1abc', '-1', '1,20', 'Infinity', 'NaN']) expect(Number.isNaN(parsePriceFilterInput(value))).toBe(true);
  expect(priceFilterError({ min: 5, max: 4 })).toMatch(/exceed/); expect(priceFilterError({ min: 5, max: null })).toBe('');
});
