'use strict';
const express = require('express');
const request = require('supertest');
const multer = require('multer');
const version = require('multer/package.json').version.split('.').map(Number);
// Never run adversarial parser fixtures against the old vulnerable dependency.
if (version[0] < 2 || version[0] === 2 && version[1] < 4) throw new Error('Install the patched Multer lock before running upload-security tests.');
const imageUpload = require('../../middleware/upload');
const chatUpload = require('../../middleware/chatUpload');
const uploadErrors = require('../../middleware/multipartUploadErrors');
const app = express();
app.post('/image', imageUpload.single('profileImage'), (req, res) => res.json({
  size: req.file?.size, mime: req.file?.mimetype, caption: req.body.caption,
}));
app.post('/chat', chatUpload.array('attachments', 10), (req, res) => res.json({
  files: req.files.length, message: req.body.message,
}));
app.get('/health', (_req, res) => res.json({ ok: true }));
app.use(uploadErrors);
app.use((_error, _req, res, _next) => res.status(500).json({ code: 'UNEXPECTED_TEST_ERROR' }));
const image = (call, name = 'profileImage', bytes = Buffer.from('test image bytes')) =>
  call.attach(name, bytes, { filename: 'qa.png', contentType: 'image/png' });

test('normal image uploads retain their file bytes, MIME and simple text fields', async () => {
  const res = await image(request(app).post('/image').field('caption', 'QA avatar')).expect(200);
  expect(res.body).toEqual({ size: 16, mime: 'image/png', caption: 'QA avatar' });
});

test('normal chat multi-attachments retain their existing contract without invoking AI', async () => {
  const res = await request(app).post('/chat').field('message', 'Read these test attachments')
    .attach('attachments', Buffer.from('document'), { filename: 'qa.txt', contentType: 'text/plain' })
    .attach('attachments', Buffer.from('audio'), { filename: 'qa.mp3', contentType: 'audio/mpeg' }).expect(200);
  expect(res.body).toEqual({ files: 2, message: 'Read these test attachments' });
});

test('a rejected image MIME produces a safe client error rather than an internal failure', async () => {
  const res = await request(app).post('/image').attach('profileImage', Buffer.from('not an image'),
    { filename: 'qa.txt', contentType: 'text/plain' }).expect(400);
  expect(res.body).toEqual({ code: 'UPLOAD_FILE_TYPE_UNSUPPORTED', msg: 'Only image files are allowed!' });
});

test('the existing five-MB image limit is preserved and reported as 413', async () => {
  const res = await image(request(app).post('/image'), 'profileImage', Buffer.alloc(5 * 1024 * 1024 + 1)).expect(413);
  expect(res.body.code).toBe('LIMIT_FILE_SIZE');
  await request(app).get('/health').expect(200, { ok: true });
});

test('image and chat file-count limits are bounded', async () => {
  const res = await image(image(request(app).post('/image'))).expect(400);
  expect(['LIMIT_FILE_COUNT', 'LIMIT_UNEXPECTED_FILE']).toContain(res.body.code);
  let call = request(app).post('/chat');
  for (let index = 0; index < 11; index++) call = call.attach('attachments', Buffer.from('x'), { filename: `qa-${index}.txt` });
  expect((await call.expect(400)).body.code).toBe('LIMIT_FILE_COUNT');
});

test('excessive text fields and overlong names fail without reflecting their contents', async () => {
  let call = request(app).post('/image');
  for (let index = 0; index < 33; index++) call = call.field(`field${index}`, 'value');
  expect((await call.expect(400)).body.code).toBe('LIMIT_FIELD_COUNT');
  const name = '<script>private-field</script>' + 'x'.repeat(100);
  const res = await request(app).post('/chat').field(name, 'private-value').expect(400);
  expect(JSON.stringify(res.body)).not.toMatch(/script|private-field|private-value/);
});

test('oversized bracket-array indices are rejected before unbounded allocation and later requests work', async () => {
  const res = await request(app).post('/chat')
    .field('items[1000000]', 'value').field('items[extra]', 'value');
  expect([400, 413]).toContain(res.status);
  expect(res.body.code).not.toBe('UNEXPECTED_TEST_ERROR');
  await request(app).get('/health').expect(200, { ok: true });
  await request(app).post('/chat').field('message', 'Parser remains usable').expect(200, { files: 0, message: 'Parser remains usable' });
});

test('missing multipart boundaries produce a controlled 400 and no parser detail leak', async () => {
  const res = await request(app).post('/chat').set('Content-Type', 'multipart/form-data').send('incomplete').expect(400);
  expect(res.body.code).toBe('UPLOAD_MULTIPART_INVALID');
  expect(res.body.msg).not.toMatch(/Boundary not found/);
});

test('unknown internal errors are delegated and headers already sent are not overwritten', () => {
  const next = jest.fn(), error = new Error('Internal operation failed');
  uploadErrors(error, { is: () => false }, { headersSent: false }, next);
  expect(next).toHaveBeenCalledWith(error);
  const fieldError = new multer.MulterError('LIMIT_FIELD_KEY', '<private-field>');
  uploadErrors(fieldError, {}, { headersSent: true }, next);
  expect(next).toHaveBeenLastCalledWith(fieldError);
});
