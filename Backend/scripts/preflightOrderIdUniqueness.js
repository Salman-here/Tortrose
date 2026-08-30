'use strict';

require('dotenv').config();

const mongoose = require('mongoose');
const Order = require('../models/Order');

const LONG_ORDER_ID_PATTERN = /^ORD-\d{13}-[0-9A-F]{6,32}$/;
const SHORT_ORDER_ID_PATTERN = /^ORD-\d{13}$/;
const MODERN_ORDER_ID_PATTERN = LONG_ORDER_ID_PATTERN;
const DEFAULT_SAMPLE_LIMIT = 20;
const MAX_SAMPLE_LIMIT = 100;

const boundedSampleLimit = value => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_SAMPLE_LIMIT) {
    throw new Error(`--sample-limit must be a whole number between 1 and ${MAX_SAMPLE_LIMIT}.`);
  }
  return parsed;
};

const parseArguments = (argv = []) => {
  if (argv.some(argument => argument === '--write' || argument.startsWith('--write='))) {
    const error = new Error('This preflight is intentionally read-only and does not accept --write.');
    error.code = 'ORDER_ID_PREFLIGHT_READ_ONLY';
    throw error;
  }
  const sampleArgument = argv.find(argument => argument.startsWith('--sample-limit='));
  return {
    json: argv.includes('--json'),
    sampleLimit: sampleArgument
      ? boundedSampleLimit(sampleArgument.slice('--sample-limit='.length))
      : DEFAULT_SAMPLE_LIMIT,
  };
};

const duplicateFacet = async ({ filter = {}, sampleLimit }) => {
  const [result = {}] = await Order.aggregate([
    { $match: { ...filter, orderId: { $type: 'string' } } },
    {
      $group: {
        _id: '$orderId',
        count: { $sum: 1 },
        firstMongoId: { $min: '$_id' },
        lastMongoId: { $max: '$_id' },
      },
    },
    { $match: { count: { $gt: 1 } } },
    { $sort: { count: -1, _id: 1 } },
    {
      $facet: {
        summary: [
          {
            $group: {
              _id: null,
              duplicateGroups: { $sum: 1 },
              affectedOrders: { $sum: '$count' },
            },
          },
        ],
        samples: [{ $limit: sampleLimit }],
      },
    },
  ]).allowDiskUse(true);

  const summary = result.summary?.[0] || {};
  return {
    duplicateGroups: Number(summary.duplicateGroups || 0),
    affectedOrders: Number(summary.affectedOrders || 0),
    samples: (result.samples || []).map(row => ({
      orderId: row._id,
      count: row.count,
      firstMongoId: String(row.firstMongoId || ''),
      lastMongoId: String(row.lastMongoId || ''),
    })),
  };
};

const invalidOrderIdFilter = {
  $or: [
    { orderId: { $exists: false } },
    { orderId: null },
    { orderId: { $not: { $type: 'string' } } },
    { orderId: '' },
    { orderId: /^\s+$/ },
  ],
};

const malformedLongFilter = {
  orderIdVersion: 2,
  $or: [
    invalidOrderIdFilter,
    { orderId: { $type: 'string', $not: LONG_ORDER_ID_PATTERN } },
  ],
};

const malformedShortFilter = {
  orderIdVersion: 3,
  $or: [
    invalidOrderIdFilter,
    { orderId: { $type: 'string', $not: SHORT_ORDER_ID_PATTERN } },
  ],
};

const sampleDocuments = async (filter, sampleLimit) => Order.find(filter)
  .sort({ _id: 1 })
  .select('_id orderId orderIdVersion user paymentMethod createdAt')
  .limit(sampleLimit)
  .lean();

async function analyzeOrderIds({ sampleLimit = DEFAULT_SAMPLE_LIMIT } = {}) {
  const limit = boundedSampleLimit(sampleLimit);
  const [
    totalOrders,
    longVersionedOrders,
    shortVersionedOrders,
    invalidOrderIds,
    malformedLongOrders,
    malformedShortOrders,
    allDuplicates,
    longDuplicates,
    shortDuplicates,
    invalidSamples,
    malformedLongSamples,
    malformedShortSamples,
    indexes,
  ] = await Promise.all([
    Order.countDocuments({}),
    Order.countDocuments({ orderIdVersion: 2 }),
    Order.countDocuments({ orderIdVersion: 3 }),
    Order.countDocuments(invalidOrderIdFilter),
    Order.countDocuments(malformedLongFilter),
    Order.countDocuments(malformedShortFilter),
    duplicateFacet({ sampleLimit: limit }),
    duplicateFacet({ filter: { orderIdVersion: 2 }, sampleLimit: limit }),
    duplicateFacet({ filter: { orderIdVersion: 3 }, sampleLimit: limit }),
    sampleDocuments(invalidOrderIdFilter, limit),
    sampleDocuments(malformedLongFilter, limit),
    sampleDocuments(malformedShortFilter, limit),
    Order.collection.indexes(),
  ]);

  const longIndex = indexes.find(index => index.name === 'uniq_modern_order_public_id') || null;
  const shortIndex = indexes.find(index => index.name === 'uniq_short_order_public_id') || null;
  const lookupIndex = indexes.find(index => index.name === 'idx_order_public_id_lookup') || null;
  const readyForModernUniqueIndex = longDuplicates.duplicateGroups === 0
    && shortDuplicates.duplicateGroups === 0
    && malformedLongOrders === 0
    && malformedShortOrders === 0;
  const versionedOrders = longVersionedOrders + shortVersionedOrders;

  return {
    generatedAt: new Date().toISOString(),
    readOnly: true,
    counts: {
      totalOrders,
      legacyUnversionedOrders: totalOrders - versionedOrders,
      modernVersionedOrders: versionedOrders,
      longVersionedOrders,
      shortVersionedOrders,
      invalidOrderIds,
      malformedModernOrders: malformedLongOrders + malformedShortOrders,
      malformedLongOrders,
      malformedShortOrders,
    },
    duplicates: {
      all: allDuplicates,
      modernVersioned: {
        duplicateGroups: longDuplicates.duplicateGroups + shortDuplicates.duplicateGroups,
        affectedOrders: longDuplicates.affectedOrders + shortDuplicates.affectedOrders,
        samples: [...longDuplicates.samples, ...shortDuplicates.samples].slice(0, limit),
      },
      longVersioned: longDuplicates,
      shortVersioned: shortDuplicates,
    },
    samples: {
      invalid: invalidSamples.map(row => ({ ...row, _id: String(row._id) })),
      malformedModern: [...malformedLongSamples, ...malformedShortSamples]
        .slice(0, limit)
        .map(row => ({ ...row, _id: String(row._id) })),
      malformedLong: malformedLongSamples.map(row => ({ ...row, _id: String(row._id) })),
      malformedShort: malformedShortSamples.map(row => ({ ...row, _id: String(row._id) })),
    },
    indexes: {
      lookupPresent: !!lookupIndex,
      modernUniquePresent: !!longIndex && !!shortIndex,
      modernUniqueDefinition: longIndex,
      longUniquePresent: !!longIndex,
      longUniqueDefinition: longIndex,
      shortUniquePresent: !!shortIndex,
      shortUniqueDefinition: shortIndex,
    },
    readyForModernUniqueIndex,
    cutoverPlan: [
      'Keep every duplicate or malformed historical order unversioned; do not rename it automatically because emails, returns, wallet entries, and provider metadata may reference it.',
      'Deploy the partial unique indexes only after readyForModernUniqueIndex is true. They protect version-2 long ids and version-3 short ids while leaving legacy evidence unchanged.',
      'Keep Mongo _id authoritative in all new provider metadata and make every legacy public-id lookup reject more than one scoped match.',
      'If legacy promotion is desired later, review duplicate groups manually. Do not rename historical ids automatically; version 3 is reserved for newly allocated compact ids.',
    ],
  };
}

async function run(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required.');
  // Keep the audit genuinely read-only; schema indexes are inspected below,
  // never auto-created by this process.
  await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, autoCreate: false });
  const assessment = await analyzeOrderIds(options);
  if (options.json) {
    console.log(JSON.stringify(assessment, null, 2));
  } else {
    console.log(`Read-only order-id preflight: ${assessment.counts.totalOrders} total order(s).`);
    console.log(`Legacy duplicate groups: ${assessment.duplicates.all.duplicateGroups}; modern duplicate groups: ${assessment.duplicates.modernVersioned.duplicateGroups}.`);
    console.log(`Invalid ids: ${assessment.counts.invalidOrderIds}; malformed version-2 ids: ${assessment.counts.malformedLongOrders}; malformed version-3 ids: ${assessment.counts.malformedShortOrders}.`);
    console.log(`Modern partial unique index ready: ${assessment.readyForModernUniqueIndex ? 'YES' : 'NO'}.`);
    if (assessment.duplicates.all.samples.length) {
      console.log('Duplicate samples:');
      assessment.duplicates.all.samples.forEach(sample => console.log(JSON.stringify(sample)));
    }
  }
  if (!assessment.readyForModernUniqueIndex) process.exitCode = 2;
  return assessment;
}

if (require.main === module) {
  run()
    .catch(error => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await mongoose.disconnect().catch(() => {});
    });
}

module.exports = {
  LONG_ORDER_ID_PATTERN,
  MODERN_ORDER_ID_PATTERN,
  SHORT_ORDER_ID_PATTERN,
  analyzeOrderIds,
  duplicateFacet,
  parseArguments,
  run,
};
