'use strict';

const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');

function fail(message) {
  throw new Error(`[build-config] ${message}`);
}

function readJson(relativePath) {
  const absolutePath = path.join(projectRoot, relativePath);

  if (!fs.existsSync(absolutePath)) {
    fail(`Missing ${relativePath}`);
  }

  try {
    return JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
  } catch (error) {
    fail(`Invalid JSON in ${relativePath}: ${error.message}`);
  }
}

function assertStringMap(value, location) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${location} must be an object`);
  }

  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') {
      fail(`${location}.${key} must be a string, received ${typeof entry}`);
    }
  }
}

function validateLocales(expoConfig) {
  const locales = expoConfig.locales || {};

  for (const [language, localeReference] of Object.entries(locales)) {
    const locale =
      typeof localeReference === 'string'
        ? readJson(localeReference)
        : localeReference;
    const location = `locales.${language}`;

    if (!locale || typeof locale !== 'object' || Array.isArray(locale)) {
      fail(`${location} must resolve to an object`);
    }

    const unsupportedKeys = Object.keys(locale).filter(
      (key) => key !== 'android' && key !== 'ios'
    );
    if (unsupportedKeys.length > 0) {
      fail(
        `${location} contains non-platform keys (${unsupportedKeys.join(
          ', '
        )}); place metadata under "android" or "ios"`
      );
    }

    if (locale.android !== undefined) {
      assertStringMap(locale.android, `${location}.android`);

      const unsupportedAndroidKeys = Object.keys(locale.android).filter(
        (key) => key !== 'app_name'
      );
      if (unsupportedAndroidKeys.length > 0) {
        fail(
          `${location}.android contains resources without default fallbacks (${unsupportedAndroidKeys.join(
            ', '
          )})`
        );
      }
    }

    if (locale.ios !== undefined) {
      const { ['Localizable.strings']: localizableStrings, ...iosMetadata } =
        locale.ios;
      assertStringMap(iosMetadata, `${location}.ios`);

      if (localizableStrings !== undefined) {
        assertStringMap(
          localizableStrings,
          `${location}.ios.Localizable.strings`
        );
      }
    }
  }
}

function validateEasConfig(expoConfig) {
  const easConfig = readJson('eas.json');
  const packageConfig = readJson('package.json');
  const projectId = expoConfig.extra?.eas?.projectId;
  const preview = easConfig.build?.preview;
  const production = easConfig.build?.production;

  if (
    typeof projectId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      projectId
    )
  ) {
    fail('expo.extra.eas.projectId must be a valid UUID');
  }

  if (preview?.distribution !== 'internal') {
    fail('build.preview.distribution must be "internal"');
  }

  if (preview?.android?.buildType !== 'apk') {
    fail('build.preview.android.buildType must be "apk"');
  }

  if (preview?.channel !== 'preview' || preview?.environment !== 'preview') {
    fail('Preview builds must use the preview update channel and environment');
  }

  if (
    production?.channel !== 'production' ||
    production?.environment !== 'production'
  ) {
    fail('Production builds must use the production update channel and environment');
  }

  if (preview?.env?.EXPO_PUBLIC_PROJECT_ID !== projectId) {
    fail('Preview EXPO_PUBLIC_PROJECT_ID must match expo.extra.eas.projectId');
  }

  if (
    preview?.env?.SENTRY_DISABLE_AUTO_UPLOAD !== 'true' ||
    preview?.env?.SENTRY_DISABLE_NATIVE_DEBUG_UPLOAD !== 'true'
  ) {
    fail('Preview builds must disable authenticated Sentry artifact uploads');
  }

  const expectedUpdatesUrl = `https://u.expo.dev/${projectId}`;
  if (
    expoConfig.updates?.url !== expectedUpdatesUrl ||
    expoConfig.updates?.enabled !== true ||
    expoConfig.updates?.checkAutomatically !== 'ON_LOAD' ||
    expoConfig.updates?.fallbackToCacheTimeout !== 0
  ) {
    fail('Expo Updates must use the linked EAS project and safe on-load policy');
  }

  if (expoConfig.runtimeVersion?.policy !== 'appVersion') {
    fail('runtimeVersion.policy must be "appVersion" for OTA compatibility');
  }

  if (!packageConfig.dependencies?.['expo-updates']) {
    fail('expo-updates must be installed as a direct dependency');
  }
}

function validatePlugins(expoConfig) {
  const pluginNames = (expoConfig.plugins || []).map((plugin) =>
    Array.isArray(plugin) ? plugin[0] : plugin
  );
  const duplicates = pluginNames.filter(
    (plugin, index) => pluginNames.indexOf(plugin) !== index
  );

  if (duplicates.length > 0) {
    fail(`Duplicate Expo config plugins: ${[...new Set(duplicates)].join(', ')}`);
  }
}

const appConfig = readJson('app.json');
const expoConfig = appConfig.expo;

if (!expoConfig || typeof expoConfig !== 'object') {
  fail('app.json must contain an expo configuration object');
}

validateLocales(expoConfig);
validateEasConfig(expoConfig);
validatePlugins(expoConfig);

console.log(
  '[build-config] Validated Expo project, preview APK profile, plugins, and localized native resources.'
);
