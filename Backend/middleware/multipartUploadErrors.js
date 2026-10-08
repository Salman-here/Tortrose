'use strict';
const multer = require('multer');
const messages = Object.freeze({
  LIMIT_PART_COUNT: 'This upload contains too many parts.',
  LIMIT_FILE_SIZE: 'An attachment exceeds the allowed file size.',
  LIMIT_FILE_COUNT: 'This upload contains too many files.',
  LIMIT_FIELD_KEY: 'An upload field name is too long or invalid.',
  LIMIT_FIELD_VALUE: 'An upload field is too large or invalid.',
  LIMIT_FIELD_COUNT: 'This upload contains too many fields.',
  LIMIT_UNEXPECTED_FILE: 'This file field is not accepted by this upload.',
  UPLOAD_FILE_TYPE_UNSUPPORTED: 'Only image files are allowed!',
});
const malformed = new Set(['Multipart: Boundary not found', 'Unexpected end of form',
  'Malformed part header', 'Unexpected end of file']);

module.exports = function multipartUploadErrors(error, req, res, next) {
  if (res.headersSent) return next(error);
  const isMulterError = error instanceof multer.MulterError;
  const knownType = error?.code === 'UPLOAD_FILE_TYPE_UNSUPPORTED';
  const isMalformed = req.is?.('multipart/form-data') && malformed.has(error?.message);
  if (!isMulterError && !knownType && !isMalformed) return next(error);
  const code = Object.hasOwn(messages, error.code) ? error.code : 'UPLOAD_MULTIPART_INVALID';
  // Never echo attacker-controlled field names, filenames or parser messages.
  return res.status(code === 'LIMIT_FILE_SIZE' || code === 'LIMIT_FIELD_VALUE' ? 413 : 400)
    .json({ code, msg: messages[code] || 'The multipart upload is malformed or exceeds its limits.' });
};
