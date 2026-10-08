// middleware/upload.js
const multer = require('multer');

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 5 * 1024 * 1024, // 5MB file size limit
        files: 1,
        fields: 32,
        parts: 33,
        fieldSize: 1024 * 1024,
        fieldNameSize: 100,
        fieldArrayIndexLimit: 100,
    },
    fileFilter: (req, file, cb) => {
        // Check if file is an image
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(Object.assign(new Error('Only image files are allowed!'), {
                status: 400, code: 'UPLOAD_FILE_TYPE_UNSUPPORTED',
            }), false);
        }
    },
});

module.exports = upload;
