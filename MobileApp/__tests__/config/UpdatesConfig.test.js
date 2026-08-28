const appConfig = require('../../app.json').expo;
const easConfig = require('../../eas.json');
const packageConfig = require('../../package.json');

describe('EAS Update release contract', () => {
  it('uses the linked Expo project with automatic on-load checks', () => {
    const projectId = appConfig.extra.eas.projectId;

    expect(appConfig.updates).toEqual({
      url: `https://u.expo.dev/${projectId}`,
      enabled: true,
      checkAutomatically: 'ON_LOAD',
      fallbackToCacheTimeout: 0,
    });
    expect(packageConfig.dependencies['expo-updates']).toBeTruthy();
  });

  it('isolates OTA updates by app version and release channel', () => {
    expect(appConfig.runtimeVersion).toEqual({ policy: 'appVersion' });
    expect(packageConfig.version).toBe(appConfig.version);
    expect(easConfig.build.preview).toMatchObject({
      channel: 'preview',
      environment: 'preview',
      distribution: 'internal',
      android: { buildType: 'apk' },
    });
    expect(easConfig.build.production).toMatchObject({
      channel: 'production',
      environment: 'production',
    });
  });

  it('publishes preview updates to Android with the matching environment', () => {
    expect(packageConfig.scripts['update:preview']).toContain('--channel preview');
    expect(packageConfig.scripts['update:preview']).toContain('--environment preview');
    expect(packageConfig.scripts['update:preview']).toContain('--platform android');
  });

  it('pins Stripe Android to the compatible exact release used by Stripe React Native', () => {
    expect(appConfig.plugins).toContainEqual([
      './plugins/withPinnedStripeAndroid',
      { version: '23.3.0' },
    ]);
  });
});
