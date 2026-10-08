const multer = require('multer');

const chatUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: Number(process.env.AI_CHAT_ATTACHMENT_MAX_BYTES || 15 * 1024 * 1024),
    files: 10,
    fields: 32,
    parts: 42,
    fieldSize: 1024 * 1024,
    fieldNameSize: 100,
    fieldArrayIndexLimit: 100,
  },
});

module.exports = chatUpload;
