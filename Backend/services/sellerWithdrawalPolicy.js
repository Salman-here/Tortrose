'use strict';

// Fixed business minimums, never recomputed from live foreign exchange.
const WITHDRAWAL_MINIMUMS = Object.freeze({ USD: 5, PKR: 2000, EUR: 5, GBP: 5 });
module.exports = { WITHDRAWAL_MINIMUMS };
