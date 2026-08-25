import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveSubdomainOwnershipTerms,
  subdomainOwnershipResponseIsValid,
} from '../src/utils/subdomainOwnership.js';

test('subdomain ownership renders the exact authoritative minor-unit USD terms', () => {
  assert.deepEqual(resolveSubdomainOwnershipTerms({
    priceMinor: 1500,
    priceCurrency: 'USD',
    ownershipYears: 3,
  }), {
    amountMinor: 1500,
    currency: 'USD',
    years: 3,
    priceLabel: '$15.00 USD',
  });
});

test('subdomain ownership keeps exact legacy compatibility and rejects ambiguous pricing', () => {
  assert.equal(resolveSubdomainOwnershipTerms({ price: 15, ownershipYears: 3 }).amountMinor, 1500);
  assert.equal(resolveSubdomainOwnershipTerms({
    priceMinor: 1500,
    priceCurrency: 'PKR',
    ownershipYears: 3,
  }), null);
  assert.equal(resolveSubdomainOwnershipTerms({ price: 15.001, ownershipYears: 3 }), null);
  assert.equal(resolveSubdomainOwnershipTerms({ priceMinor: 1500, priceCurrency: 'USD' }), null);
});

test('subdomain ownership state must be internally consistent before actions are enabled', () => {
  const response = {
    subdomain: 'my-store',
    url: 'my-store.rozare.com',
    ownership: {
      isPurchased: true,
      isOwned: true,
      purchasedAt: '2026-08-01T00:00:00.000Z',
      expiresAt: '2029-08-01T00:00:00.000Z',
      daysRemaining: 1000,
    },
    priceMinor: 1500,
    priceCurrency: 'USD',
    ownershipYears: 3,
  };
  assert.equal(subdomainOwnershipResponseIsValid(response), true);
  assert.equal(subdomainOwnershipResponseIsValid({
    ...response,
    ownership: { ...response.ownership, isPurchased: false },
  }), false);
});
