'use strict';

require('dotenv').config();

const mongoose = require('mongoose');
const Order = require('../models/Order');

const MODERN_ORDER_ID_PATTERN = /^ORD-\d{13}-[0-9A-F]{6,32}$/;
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

const malformedModernFilter = {
  orderIdVersion: 2,
  $or: [
    invalidOrderIdFilter,
    { orderId: { $type: 'string', $not: MODERN_ORDER_ID_PATTERN } },
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
    versionedOrders,
    invalidOrderIds,
    malformedModernOrders,
    allDuplicates,
    modernDuplicates,
    invalidSamples,
    malformedModernSamples,
    indexes,
  ] = await Promise.all([
    Order.countDocuments({}),
    Order.countDocuments({ orderIdVersion: 2 }),
    Order.countDocuments(invalidOrderIdFilter),
    Order.countDocuments(malformedModernFilter),
    duplicateFacet({ sampleLimit: limit }),
    duplicateFacet({ filter: { orderIdVersion: 2 }, sampleLimit: limit }),
    sampleDocuments(invalidOrderIdFilter, limit),
    sampleDocuments(malformedModernFilter, limit),
    Order.collection.indexes(),
  ]);

  const modernIndex = indexes.find(index => index.name === 'uniq_modern_order_public_id') || null;
  const lookupIndex = indexes.find(index => index.name === 'idx_order_public_id_lookup') || null;
  const readyForModernUniqueIndex = modernDuplicates.duplicateGroups === 0
    && malformedModernOrders === 0;

  return {
    generatedAt: new Date().toISOString(),
    readOnly: true,
    counts: {
      totalOrders,
      legacyUnversionedOrders: totalOrders - versionedOrders,
      modernVersionedOrders: versionedOrders,
      invalidOrderIds,
      malformedModernOrders,
    },
    duplicates: {
      all: allDuplicates,
      modernVersioned: modernDuplicates,
    },
    samples: {
      invalid: invalidSamples.map(row => ({ ...row, _id: String(row._id) })),
      malformedModern: malformedModernSamples.map(row => ({ ...row, _id: String(row._id) })),
    },
    indexes: {
      lookupPresent: !!lookupIndex,
      modernUniquePresent: !!modernIndex,
      modernUniqueDefinition: modernIndex,
    },
    readyForModernUniqueIndex,
    cutoverPlan: [
      'Keep every duplicate or malformed historical order unversioned; do not rename it automatically because emails, returns, wallet entries, and provider metadata may reference it.',
      'Deploy the partial unique index only after readyForModernUniqueIndex is true. It protects orderIdVersion=2 rows while leaving legacy evidence unchanged.',
      'Keep Mongo _id authoritative in all new provider metadata and make every legacy public-id lookup reject more than one scoped match.',
      'If legacy promotion is desired later, review duplicate groups manually, then backfill orderIdVersion=2 only for individually verified, globally unique ids with compare-and-set writes.',
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
    console.log(`Invalid ids: ${assessment.counts.invalidOrderIds}; malformed version-2 ids: ${assessment.counts.malformedModernOrders}.`);
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
  MODERN_ORDER_ID_PATTERN,
  analyzeOrderIds,
  duplicateFacet,
  parseArguments,
  run,
};
