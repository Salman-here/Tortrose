import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import PhoneNumberInput, { fetchPhoneCountries } from '../../../src/components/common/PhoneNumberInput';
import api from '../../../src/config/api';
import { resolveBuyerLocation } from '../../../src/utils/buyerLocation';

jest.mock('@expo/vector-icons', () => {
  const ReactModule = require('react');
  const { Text } = require('react-native');
  return { Ionicons: ({ name }) => ReactModule.createElement(Text, null, name) };
});

jest.mock('react-native-safe-area-context', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  return { SafeAreaView: ({ children, ...props }) => ReactModule.createElement(View, props, children) };
});

jest.mock('../../../src/config/api', () => ({
  __esModule: true,
  default: { get: jest.fn() },
}));

jest.mock('../../../src/utils/buyerLocation', () => ({
  resolveBuyerLocation: jest.fn(() => Promise.resolve({ country: 'Pakistan', countryCode: 'PK' })),
}));

jest.mock('../../../src/contexts/ThemeContext', () => ({
  useTheme: () => ({
    palette: {
      colors: {
        background: '#fff', surface: '#fff', text: '#111', textSecondary: '#666', textLight: '#888',
        primary: '#6366f1', primarySubtle: '#eef2ff', error: '#dc2626', errorSubtle: '#fef2f2',
      },
      glass: {
        bgSubtle: '#f8fafc', bgStrong: '#fff', borderSubtle: '#ddd', borderStrong: '#bbb',
      },
    },
  }),
}));

describe('PhoneNumberInput', () => {
  beforeEach(() => {
    resolveBuyerLocation.mockReset();
    resolveBuyerLocation.mockResolvedValue({ country: 'Pakistan', countryCode: 'PK' });
    api.get.mockResolvedValue({
      data: { countries: [{ name: 'Pakistan', isoCode: 'PK', phonecode: '92' }] },
    });
  });

  it('emits E.164 while presenting a country selector and national input', async () => {
    const onChangeText = jest.fn();
    const screen = render(
      <PhoneNumberInput value="" onChangeText={onChangeText} label="Mobile" testID="mobile" />
    );

    await waitFor(() => expect(screen.getByTestId('mobile-country')).toBeTruthy());
    fireEvent.changeText(screen.getByTestId('mobile-input'), '03028588506');
    expect(onChangeText).toHaveBeenLastCalledWith('+923028588506');
  });

  it('merges the API catalog with the complete offline country fallback', async () => {
    const countries = await fetchPhoneCountries('');
    expect(countries.length).toBeGreaterThan(200);
    expect(countries[0]).toEqual(expect.objectContaining({ isoCode: 'PK', phonecode: '92' }));
  });

  it('hydrates a legacy national-format value into canonical E.164', async () => {
    const onChangeText = jest.fn();
    render(
      <PhoneNumberInput
        value="03391234567"
        onChangeText={onChangeText}
        defaultCountryCode="PK"
        testID="legacy-mobile"
      />
    );

    await waitFor(() => expect(onChangeText).toHaveBeenCalledWith('+923391234567'));
  });

  it('selects the detected country when no saved or explicit country exists', async () => {
    resolveBuyerLocation.mockResolvedValueOnce({ country: 'United Kingdom', countryCode: 'GB' });
    api.get.mockResolvedValue({
      data: { countries: [{ name: 'United Kingdom', isoCode: 'GB', phonecode: '44' }] },
    });

    const screen = render(
      <PhoneNumberInput value="" onChangeText={jest.fn()} testID="auto-country-mobile" />
    );

    await waitFor(() => {
      expect(screen.getByLabelText('Country code United Kingdom, plus 44')).toBeTruthy();
    });
  });

  it('uses detected country but never overwrites an explicit in-flight selection', async () => {
    let finishDetection;
    resolveBuyerLocation.mockImplementationOnce(() => new Promise(resolve => { finishDetection = resolve; }));
    api.get.mockImplementation((url, config = {}) => {
      const query = config.params?.q;
      if (query === 'United Kingdom') {
        return Promise.resolve({ data: { countries: [{ name: 'United Kingdom', isoCode: 'GB', phonecode: '44' }] } });
      }
      return Promise.resolve({ data: { countries: [{ name: 'Pakistan', isoCode: 'PK', phonecode: '92' }] } });
    });

    const screen = render(<PhoneNumberInput value="" onChangeText={jest.fn()} testID="detected-mobile" />);
    fireEvent.press(screen.getByTestId('detected-mobile-country'));
    fireEvent.changeText(screen.getByLabelText('Search country codes'), 'United Kingdom');
    const unitedKingdom = await screen.findByLabelText('Select United Kingdom, country code plus 44');
    fireEvent.press(unitedKingdom);
    expect(screen.getByLabelText('Country code United Kingdom, plus 44')).toBeTruthy();

    await act(async () => {
      finishDetection({ country: 'Pakistan', countryCode: 'PK' });
      await Promise.resolve();
    });
    expect(screen.getByLabelText('Country code United Kingdom, plus 44')).toBeTruthy();
  });
});
