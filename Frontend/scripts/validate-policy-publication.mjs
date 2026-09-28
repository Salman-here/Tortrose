import { readFileSync } from 'node:fs';
const config = JSON.parse(readFileSync(new URL('../../MobileApp/src/content/commercePolicyConfig.json', import.meta.url), 'utf8'));
const missing = ['registeredAddress', 'jurisdictionCity', 'supportPhone'].filter(key => !String(config[key] || '').trim());
if (config.sameOperatingAddress !== true && !String(config.operatingAddress || '').trim()) missing.push('operatingAddress or confirmation that it is the same');
for (const key of ['complaintAcknowledgementBusinessDays', 'complaintResolutionTargetBusinessDays', 'approvedRefundInitiationBusinessDays']) {
  if (!Number.isInteger(config[key]) || config[key] < 1) missing.push(key);
}
if (config.publicationApproved !== true || missing.length) {
  console.error('Policy publication blocked: merchant confirmation required.', missing.join(', '));
  process.exitCode = 1;
} else console.log('Merchant policy details and timelines are confirmed.');
