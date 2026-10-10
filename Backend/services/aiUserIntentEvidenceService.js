'use strict';

// Only successful current-request audio transcription may supply a spoken
// confirmation. Image text, spreadsheets, old history and model prose cannot.
function trustedVoiceIntentText(text, processed = []) {
  if (!Array.isArray(processed) || processed.length !== 1 || processed[0]?.type !== 'audio'
    || processed[0].success !== true || typeof processed[0].transcript !== 'string'
    || !processed[0].transcript.trim()) return null;
  let caption = String(text || '').trim();
  if (/^(?:voice (?:message|note)(?: attached)?|audio (?:message|attachment)|file attached|attachment uploaded|(?:please )?(?:listen to|process|check) (?:this |the )?(?:attached )?(?:voice (?:note|message)|audio)(?: attachment)?)[.!]*$/i.test(caption)) caption = '';
  return [caption, processed[0].transcript.trim()].filter(Boolean).join('\n');
}
module.exports = { trustedVoiceIntentText };
