'use strict';
const { withMainActivity } = require('expo/config-plugins');
const MARKER = '// Rozare: unlock only tablet orientation; phone orientation is unchanged.';
function applyTabletOrientation(source, language) {
  if (source.includes(MARKER)) return source;
  if (language === 'kt') {
    const anchor = 'super.onCreate(null)';
    if (!source.includes(anchor)) throw new Error('Tablet orientation: expected Kotlin activity lifecycle was not found.');
    return source.replace(anchor, `${anchor}\n    ${MARKER}\n    if (resources.configuration.smallestScreenWidthDp >= 600) {\n      requestedOrientation = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_FULL_USER\n    }`);
  }
  if (language === 'java') {
    const anchor = 'super.onCreate(null);';
    if (!source.includes(anchor)) throw new Error('Tablet orientation: expected Java activity lifecycle was not found.');
    return source.replace(anchor, `${anchor}\n    ${MARKER}\n    if (getResources().getConfiguration().smallestScreenWidthDp >= 600) {\n      setRequestedOrientation(android.content.pm.ActivityInfo.SCREEN_ORIENTATION_FULL_USER);\n    }`);
  }
  throw new Error('Tablet orientation: unsupported activity language.');
}
module.exports = config => withMainActivity(config, mod => {
  mod.modResults.contents = applyTabletOrientation(mod.modResults.contents, mod.modResults.language);
  return mod;
});
module.exports.applyTabletOrientation = applyTabletOrientation;
