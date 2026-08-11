const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const WhatsAppInboundReceipt = require('../../models/WhatsAppInboundReceipt');
const {
  processInboundMessageOnce,
} = require('../../services/whatsapp/inboundProcessingService');

let mongoServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await WhatsAppInboundReceipt.init();
}, 60000);

afterEach(async () => {
  await WhatsAppInboundReceipt.deleteMany({});
});

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
}, 60000);

describe('durable WhatsApp inbound processing receipts', () => {
  test('executes a successfully completed Evolution message only once', async () => {
    const work = jest.fn().mockResolvedValue('ok');
    const input = {
      instanceName: 'rozare-seller',
      messageId: 'WA-INBOUND-1',
      phone: '923001112222',
      work,
    };

    const first = await processInboundMessageOnce(input);
    const duplicate = await processInboundMessageOnce(input);

    expect(first).toMatchObject({ processed: true, duplicate: false, value: 'ok' });
    expect(duplicate).toMatchObject({ processed: false, duplicate: true, completed: true });
    expect(work).toHaveBeenCalledTimes(1);
  });

  test('records transient failure and lets a repeated webhook retry the same message', async () => {
    const work = jest.fn()
      .mockRejectedValueOnce(new Error('temporary transcription outage'))
      .mockResolvedValueOnce('recovered');
    const input = {
      instanceName: 'rozare-seller',
      messageId: 'WA-INBOUND-RETRY',
      phone: '923001112222',
      work,
    };

    await expect(processInboundMessageOnce(input)).rejects.toThrow('temporary transcription outage');
    await expect(processInboundMessageOnce(input)).resolves.toMatchObject({
      processed: true,
      duplicate: true,
      value: 'recovered',
    });
    expect(work).toHaveBeenCalledTimes(2);
    const receipt = await WhatsAppInboundReceipt.findOne({ messageId: 'WA-INBOUND-RETRY' }).lean();
    expect(receipt).toMatchObject({ status: 'completed', attempts: 2 });
  });

  test('rejects a concurrent duplicate while the first worker owns the lease', async () => {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const input = {
      instanceName: 'rozare-seller',
      messageId: 'WA-INBOUND-CONCURRENT',
      phone: '923001112222',
      work: jest.fn(() => pending),
    };

    const first = processInboundMessageOnce(input);
    await new Promise(resolve => setImmediate(resolve));
    await expect(processInboundMessageOnce(input)).rejects.toMatchObject({
      code: 'WHATSAPP_INBOUND_PROCESSING',
      retryable: true,
    });
    release('done');
    await expect(first).resolves.toMatchObject({ processed: true });
  });
});
