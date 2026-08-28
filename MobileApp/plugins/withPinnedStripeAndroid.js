'use strict';

const { createRunOncePlugin, withGradleProperties } = require('@expo/config-plugins');

const PLUGIN_NAME = 'with-pinned-stripe-android';
const PLUGIN_VERSION = '1.0.0';
const STRIPE_VERSION_PROPERTY = 'StripeSdk_stripeVersion';

function withPinnedStripeAndroid(config, { version = '23.3.0' } = {}) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`${PLUGIN_NAME}: version must be an exact semantic version`);
  }

  return withGradleProperties(config, (gradleConfig) => {
    const property = {
      type: 'property',
      key: STRIPE_VERSION_PROPERTY,
      value: version,
    };
    const existingIndex = gradleConfig.modResults.findIndex(
      (entry) => entry.type === 'property' && entry.key === STRIPE_VERSION_PROPERTY,
    );

    if (existingIndex >= 0) {
      gradleConfig.modResults[existingIndex] = property;
    } else {
      gradleConfig.modResults.push(property);
    }

    return gradleConfig;
  });
}

module.exports = createRunOncePlugin(
  withPinnedStripeAndroid,
  PLUGIN_NAME,
  PLUGIN_VERSION,
);
