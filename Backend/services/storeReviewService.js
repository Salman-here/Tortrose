'use strict';

const mongoose = require('mongoose');
const StoreReview = require('../models/StoreReview');

const emptyStoreReviewSummary = () => ({
  average: 0,
  count: 0,
  distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
});

const normalizeStoreIds = (storeIds) => [...new Set((storeIds || [])
  .map((value) => value?._id || value)
  .filter((value) => mongoose.Types.ObjectId.isValid(value))
  .map((value) => String(value)))]
  .map((value) => new mongoose.Types.ObjectId(value));

const getStoreReviewSummaries = async (storeIds) => {
  const ids = normalizeStoreIds(storeIds);
  const summaries = {};
  ids.forEach((id) => { summaries[id.toString()] = emptyStoreReviewSummary(); });
  if (ids.length === 0) return summaries;

  const rows = await StoreReview.aggregate([
    { $match: { store: { $in: ids }, isVerifiedPurchase: true } },
    {
      $group: {
        _id: { store: '$store', rating: '$rating' },
        count: { $sum: 1 },
      },
    },
  ]);

  rows.forEach((row) => {
    const storeId = String(row._id.store);
    const rating = Number(row._id.rating);
    const count = Number(row.count) || 0;
    const summary = summaries[storeId] || emptyStoreReviewSummary();
    summary.distribution[rating] = count;
    summary.count += count;
    summary.average += rating * count;
    summaries[storeId] = summary;
  });

  Object.values(summaries).forEach((summary) => {
    summary.average = summary.count > 0
      ? Math.round((summary.average / summary.count) * 10) / 10
      : 0;
  });

  return summaries;
};

const getStoreReviewSummary = async (storeId) => {
  const summaries = await getStoreReviewSummaries([storeId]);
  return summaries[String(storeId)] || emptyStoreReviewSummary();
};

const attachStoreReviewSummaries = async (stores) => {
  const items = stores || [];
  const summaries = await getStoreReviewSummaries(items.map((store) => store?._id));
  return items.map((store) => {
    const plainStore = store?.toObject ? store.toObject() : store;
    const summary = summaries[String(plainStore?._id)] || emptyStoreReviewSummary();
    return {
      ...plainStore,
      ratingAverage: summary.average,
      ratingCount: summary.count,
    };
  });
};

module.exports = {
  attachStoreReviewSummaries,
  emptyStoreReviewSummary,
  getStoreReviewSummaries,
  getStoreReviewSummary,
};
