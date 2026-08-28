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

function readPngMetadata(relativePath) {
  const absolutePath = path.join(projectRoot, relativePath);
  const bytes = fs.readFileSync(absolutePath);
  const pngSignature = '89504e470d0a1a0a';

  if (bytes.length < 26 || bytes.subarray(0, 8).toString('hex') !== pngSignature) {
    fail(`${relativePath} must be a valid PNG image`);
  }

  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    colorType: bytes[25],
  };
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

  const previewUpdateScript = packageConfig.scripts?.['update:preview'] || '';
  for (const requiredPart of [
    'eas-cli update',
    '--channel preview',
    '--environment preview',
    '--platform android',
  ]) {
    if (!previewUpdateScript.includes(requiredPart)) {
      fail(`update:preview must include ${requiredPart}`);
    }
  }

  const productionUpdateScript = packageConfig.scripts?.['update:production'] || '';
  for (const requiredPart of [
    'eas-cli update',
    '--channel production',
    '--environment production',
  ]) {
    if (!productionUpdateScript.includes(requiredPart)) {
      fail(`update:production must include ${requiredPart}`);
    }
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

  const pinnedStripePlugin = (expoConfig.plugins || []).find(
    (plugin) => Array.isArray(plugin) && plugin[0] === './plugins/withPinnedStripeAndroid'
  );
  if (pinnedStripePlugin?.[1]?.version !== '23.3.0') {
    fail('Stripe Android must be pinned to exact version 23.3.0 for deterministic Gradle resolution');
  }
}

function validateBranding(expoConfig) {
  const packageConfig = readJson('package.json');

  if (expoConfig.name !== 'Rozare') {
    fail('expo.name must be exactly "Rozare"');
  }

  if (packageConfig.version !== expoConfig.version) {
    fail('package.json and app.json versions must match');
  }

  if (expoConfig.userInterfaceStyle !== 'automatic') {
    fail('expo.userInterfaceStyle must be "automatic" so System theme follows the device');
  }

  if (!packageConfig.dependencies?.['expo-system-ui']) {
    fail('expo-system-ui must be installed for automatic Android appearance');
  }

  const englishLocale = readJson(expoConfig.locales?.en || 'locales/en.json');
  if (
    englishLocale.android?.app_name !== expoConfig.name ||
    englishLocale.ios?.CFBundleDisplayName !== expoConfig.name
  ) {
    fail('Localized Android and iOS display names must match expo.name');
  }

  const requiredIcons = [
    expoConfig.icon,
    expoConfig.android?.icon,
    expoConfig.android?.adaptiveIcon?.foregroundImage,
    expoConfig.android?.adaptiveIcon?.backgroundImage,
    expoConfig.android?.adaptiveIcon?.monochromeImage,
  ];

  for (const iconPath of requiredIcons) {
    if (typeof iconPath !== 'string' || !fs.existsSync(path.join(projectRoot, iconPath))) {
      fail(`Missing configured launcher icon asset: ${iconPath || '<unset>'}`);
    }

    const metadata = readPngMetadata(iconPath);
    if (metadata.width !== 1024 || metadata.height !== 1024) {
      fail(`Launcher icon ${iconPath} must be exactly 1024x1024`);
    }
  }

  const splashPlugin = (expoConfig.plugins || []).find(
    (plugin) => Array.isArray(plugin) && plugin[0] === 'expo-splash-screen'
  );
  const splashOptions = splashPlugin?.[1];

  if (!packageConfig.dependencies?.['expo-splash-screen']) {
    fail('expo-splash-screen must be installed as a direct dependency');
  }

  if (
    !splashOptions ||
    splashOptions.backgroundColor !== '#F4F8FF' ||
    splashOptions.resizeMode !== 'contain' ||
    splashOptions.imageWidth !== 200
  ) {
    fail('expo-splash-screen must use the premium Rozare launch configuration');
  }

  const splashPath = splashOptions.image;
  if (typeof splashPath !== 'string' || !fs.existsSync(path.join(projectRoot, splashPath))) {
    fail(`Missing configured splash image: ${splashPath || '<unset>'}`);
  }

  const splashMetadata = readPngMetadata(splashPath);
  if (
    splashMetadata.width !== 1024 ||
    splashMetadata.height !== 1024 ||
    ![4, 6].includes(splashMetadata.colorType)
  ) {
    fail('Splash image must be a transparent 1024x1024 PNG');
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
validateBranding(expoConfig);

console.log(
  '[build-config] Validated Expo project, preview APK profile, plugins, and localized native resources.'
);
