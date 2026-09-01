const fs = require('fs');
const path = require('path');
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
    expect(easConfig.build['production-apk']).toMatchObject({
      channel: 'production',
      environment: 'production',
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

  it('binds the production Android package to the public Firebase client only', () => {
    const googleServicesPath = path.resolve(
      __dirname,
      '../..',
      appConfig.android.googleServicesFile
    );
    const googleServices = JSON.parse(fs.readFileSync(googleServicesPath, 'utf8'));
    const androidClient = googleServices.client.find(
      (client) =>
        client.client_info.android_client_info.package_name === appConfig.android.package
    );

    expect(appConfig.android.package).toBe('com.rozare.app');
    expect(appConfig.android.googleServicesFile).toBe('./google-services.json');
    expect(appConfig.android.versionCode).toBeGreaterThanOrEqual(12);
    expect(googleServices.project_info.project_id).toBe('rozare-production');
    expect(androidClient.client_info.mobilesdk_app_id).toBeTruthy();
    expect(JSON.stringify(googleServices)).not.toContain('"private_key"');
    expect(packageConfig.dependencies['expo-notifications']).toBeTruthy();
    expect(appConfig.plugins).toContainEqual(expect.arrayContaining(['expo-notifications']));
  });
});
