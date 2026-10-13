import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import LocationAutocomplete from '../../src/components/common/LocationAutocomplete';
import api from '../../src/config/api';

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('../../src/contexts/ThemeContext', () => ({ useTheme: () => ({ palette: require('../../src/styles/palettes').lightPalette }) }));
jest.mock('../../src/config/api', () => ({ __esModule: true, default: { get: jest.fn() } }));

beforeEach(() => { jest.clearAllMocks(); });

test('a late old-country city response cannot overwrite the current picker', async () => {
  const pending = [];
  api.get.mockImplementation((url, options) => new Promise(resolve => pending.push({ url, options, resolve })));
  const onSelect = jest.fn();
  const screen = render(<LocationAutocomplete type="city" countryCode="PK" placeholder="Select city" onSelect={onSelect} />);
  fireEvent(screen.getByPlaceholderText('Select city'), 'focus');
  await waitFor(() => expect(pending).toHaveLength(1));
  screen.rerender(<LocationAutocomplete type="city" countryCode="GB" placeholder="Select city" onSelect={onSelect} />);
  await waitFor(() => expect(pending).toHaveLength(2));
  expect(pending[0].options.signal.aborted).toBe(true);
  await act(async () => { pending[1].resolve({ data: { cities: [{ name: 'London', countryCode: 'GB' }] } }); });
  await screen.findByText('London, GB');
  await act(async () => { pending[0].resolve({ data: { cities: [{ name: 'Lahore', countryCode: 'PK' }] } }); });
  expect(screen.queryByText('Lahore, PK')).toBeNull();
  fireEvent.press(screen.getByText('London, GB'));
  expect(onSelect).toHaveBeenCalledWith({ name: 'London', countryCode: 'GB' });
});

test('query edits notify the profile separately from simply opening the selected location', () => {
  const onQueryChange = jest.fn();
  const screen = render(<LocationAutocomplete type="country" value="Pakistan" code="PK" placeholder="Select country" onQueryChange={onQueryChange} />);
  fireEvent(screen.getByPlaceholderText('Select country'), 'focus');
  expect(onQueryChange).not.toHaveBeenCalled();
  fireEvent.changeText(screen.getByPlaceholderText('Select country'), 'United');
  expect(onQueryChange).toHaveBeenCalledWith('United');
});
