const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const projectRoot = path.resolve(__dirname, '../..');

function readPng(relativePath) {
  return PNG.sync.read(fs.readFileSync(path.join(projectRoot, relativePath)));
}

function alphaBounds(png, threshold = 8) {
  let minX = png.width;
  let minY = png.height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const alpha = png.data[((y * png.width) + x) * 4 + 3];
      if (alpha <= threshold) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  return { minX, minY, maxX, maxY };
}

function alphaAt(png, x, y) {
  return png.data[((y * png.width) + x) * 4 + 3];
}

describe('native branding assets', () => {
  test.each(['assets/adaptive-icon.png', 'assets/adaptive-icon-monochrome.png'])(
    '%s keeps the approved artwork intact inside a circular launcher mask',
    (relativePath) => {
      const png = readPng(relativePath);
      const bounds = alphaBounds(png);
      let pixelsOutsideCircle = 0;

      for (let y = 0; y < png.height; y += 1) {
        for (let x = 0; x < png.width; x += 1) {
          const alpha = alphaAt(png, x, y);
          const distanceSquared = ((x - 511.5) ** 2) + ((y - 511.5) ** 2);
          if (alpha > 8 && distanceSquared > (511.5 ** 2)) pixelsOutsideCircle += 1;
        }
      }

      expect({ width: png.width, height: png.height }).toEqual({ width: 1024, height: 1024 });
      expect(bounds.minX).toBeGreaterThan(0);
      expect(bounds.minY).toBeGreaterThan(0);
      expect(bounds.maxX).toBeLessThan(png.width - 1);
      expect(bounds.maxY).toBeLessThan(png.height - 1);
      expect(bounds.minX).toBeGreaterThanOrEqual(199);
      expect(bounds.minY).toBeGreaterThanOrEqual(199);
      expect(bounds.maxX).toBeLessThanOrEqual(825);
      expect(bounds.maxY).toBeLessThanOrEqual(825);
      expect(pixelsOutsideCircle).toBe(0);
    },
  );

  test('uses the website favicon byte-for-byte as the mobile brand source', () => {
    const websiteFavicon = fs.readFileSync(
      path.resolve(projectRoot, '../Frontend/public/favicon-512.png'),
    );
    const mobileFavicon = fs.readFileSync(path.join(projectRoot, 'assets/brand-favicon.png'));

    expect(mobileFavicon.equals(websiteFavicon)).toBe(true);
  });

  test.each(['assets/icon.png', 'assets/android-legacy-icon.png'])(
    '%s uses a full-bleed brand surface without a nested favicon tile',
    (relativePath) => {
      const png = readPng(relativePath);

      expect(alphaAt(png, 0, 0)).toBe(255);
      expect(alphaAt(png, png.width - 1, 0)).toBe(255);
      expect(alphaAt(png, 0, png.height - 1)).toBe(255);
      expect(alphaAt(png, png.width - 1, png.height - 1)).toBe(255);
    },
  );

  test('adaptive foreground contains only centered white artwork on transparency', () => {
    const foreground = readPng('assets/adaptive-icon.png');
    const source = fs.readFileSync(
      path.join(projectRoot, 'assets/adaptive-icon-foreground-source.svg'),
      'utf8',
    );

    expect(alphaAt(foreground, 0, 0)).toBe(0);
    expect(source).not.toContain('<rect');
    expect(source).toContain('Approved in the Android-calibrated preview: 92% size, +3.4% horizontal, +2.5% vertical.');
    expect(source).toContain('translate(34.816 25.6)');
    expect(source).toContain('scale(0.92)');
    expect(source).toContain('translate(50 61) scale(17.5)');
  });

  test('notification icon keeps the approved white mark large and centered on transparency', () => {
    const notificationIcon = readPng('assets/notification-icon.png');
    const bounds = alphaBounds(notificationIcon);
    let coloredVisiblePixels = 0;

    for (let offset = 0; offset < notificationIcon.data.length; offset += 4) {
      const alpha = notificationIcon.data[offset + 3];
      if (
        alpha > 8
        && (
          notificationIcon.data[offset] !== 255
          || notificationIcon.data[offset + 1] !== 255
          || notificationIcon.data[offset + 2] !== 255
        )
      ) {
        coloredVisiblePixels += 1;
      }
    }

    expect({ width: notificationIcon.width, height: notificationIcon.height }).toEqual({
      width: 96,
      height: 96,
    });
    expect(bounds).toEqual({ minX: 19, minY: 18, maxX: 76, maxY: 77 });
    expect(alphaAt(notificationIcon, 0, 0)).toBe(0);
    expect(alphaAt(notificationIcon, 95, 95)).toBe(0);
    expect(coloredVisiblePixels).toBe(0);
  });

  test('adaptive background is a full-bleed version of the favicon brand gradient', () => {
    const background = readPng('assets/adaptive-icon-background.png');
    const source = fs.readFileSync(
      path.join(projectRoot, 'assets/adaptive-icon-background-source.svg'),
      'utf8',
    );

    expect(alphaAt(background, 0, 0)).toBe(255);
    expect(alphaAt(background, background.width - 1, 0)).toBe(255);
    expect(alphaAt(background, 0, background.height - 1)).toBe(255);
    expect(alphaAt(background, background.width - 1, background.height - 1)).toBe(255);
    expect(source).toContain('#14B8A6');
    expect(source).toContain('#0EA5E9');
    expect(source).toContain('#6366F1');
    expect(source).not.toContain('#ECFDF5');
  });

  test('non-adaptive icons use the visual equivalent of the Android-approved adjustment', () => {
    for (const relativePath of [
      'assets/app-icon-source.svg',
      'assets/android-legacy-icon-source.svg',
    ]) {
      const source = fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
      expect(source).toContain('138% size, +5.1% horizontal, +3.75% vertical');
      expect(source).toContain('translate(52.224 38.4)');
      expect(source).toContain('scale(1.38)');
    }
  });

  test('ships an interactive mask previewer for future icon adjustments', () => {
    const previewSource = fs.readFileSync(
      path.join(projectRoot, 'tools/launcher-icon-preview.html'),
      'utf8',
    );

    expect(previewSource).toContain('class="icon circle"');
    expect(previewSource).toContain('class="icon squircle"');
    expect(previewSource).toContain('class="icon rounded"');
    expect(previewSource).toContain('id="scale"');
    expect(previewSource).toContain('max="150"');
    expect(previewSource).toContain('--android-viewport-scale: 1.5');
    expect(previewSource).toContain('108 → 72 dp · 1.5×');
    expect(previewSource).toContain('value="92"');
    expect(previewSource).toContain('value="3.4"');
    expect(previewSource).toContain('value="2.5"');
    expect(previewSource).toContain('id="x"');
    expect(previewSource).toContain('id="y"');
    expect(previewSource).toContain('id="gridOverlay"');
    expect(previewSource).toContain('class="alignment-grid"');
    expect(previewSource).toContain('id="circularGrid"');
    expect(previewSource).toContain('class="circular-grid"');
    expect(previewSource).toContain('id="submit"');
    expect(previewSource).toContain("status: 'ready'");
  });

  test('splash art is transparent outside its centered premium badge', () => {
    const splash = readPng('assets/splash.png');
    const bounds = alphaBounds(splash);

    expect({ width: splash.width, height: splash.height }).toEqual({ width: 1024, height: 1024 });
    expect(alphaAt(splash, 0, 0)).toBe(0);
    expect(bounds).toEqual({ minX: 273, minY: 273, maxX: 806, maxY: 806 });
  });

  test('Expo uses the modern splash plugin and a distinct native release version', () => {
    const appConfig = require('../../app.json').expo;
    const splashPlugin = appConfig.plugins.find(
      (plugin) => Array.isArray(plugin) && plugin[0] === 'expo-splash-screen',
    );

    expect(appConfig.version).toBe('1.0.10');
    expect(appConfig.android.versionCode).toBe(12);
    expect(appConfig.ios.buildNumber).toBe('11');
    expect(appConfig.android.blockedPermissions).toEqual(
      expect.arrayContaining([
        'android.permission.CAMERA',
        'android.permission.READ_EXTERNAL_STORAGE',
        'android.permission.WRITE_EXTERNAL_STORAGE',
      ]),
    );
    expect(appConfig.userInterfaceStyle).toBe('automatic');
    expect(appConfig.android.adaptiveIcon.backgroundColor).toBe('#0EA5E9');
    expect(appConfig.androidStatusBar.barStyle).toBe('dark-content');
    expect(splashPlugin?.[1]).toMatchObject({
      image: './assets/splash.png',
      backgroundColor: '#F4F8FF',
      imageWidth: 200,
      resizeMode: 'contain',
    });
  });

  test('startup gates use the soft branded transition without altering the navigator loading path', () => {
    const appSource = fs.readFileSync(path.join(projectRoot, 'App.js'), 'utf8');
    const launchSource = fs.readFileSync(
      path.join(projectRoot, 'src/components/common/AppLaunchScreen.js'),
      'utf8',
    );
    const navigatorSource = fs.readFileSync(
      path.join(projectRoot, 'src/navigation/AppNavigator.js'),
      'utf8',
    );

    expect(appSource).toContain('if (showOnboarding === null) return <AppLaunchScreen />;');
    expect(appSource).toContain('if (locked === null) return <AppLaunchScreen message="Securing your space" />;');
    expect(launchSource).toContain("colors={['#F0FDFA', '#F4F8FF', '#EEF2FF']}");
    expect(launchSource).toContain("require('../../../assets/brand-favicon.png')");
    expect(launchSource).not.toMatch(/#07111F|#020617/);
    expect(navigatorSource).toMatch(/if \(isLoading\) \{\s+return null;\s+\}/);
    expect(navigatorSource).not.toContain('AppLaunchScreen');
  });
});
