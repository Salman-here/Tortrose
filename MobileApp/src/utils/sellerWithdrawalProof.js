const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validProvider = value => typeof value === 'string'
  && value === value.trim()
  && value.length >= 2 && value.length <= 120
  && !/[\u0000-\u001F\u007F]/.test(value);
const validReference = value => typeof value === 'string'
  && /^[A-Za-z0-9][A-Za-z0-9._:/-]{3,199}$/.test(value);

// Seller DTOs deliberately expose only these two recorded public fields.
// Detailed attempts, transfer dates, evidence notes and URLs remain admin-only.
export const selectSellerWithdrawalProof = request => {
  if (!isRecord(request) || request.status !== 'paid') return null;
  const workflow = request.payoutWorkflow;
  if (!isRecord(workflow) || workflow.state !== 'paid'
    || request.payoutWorkflowVersion !== 1 || workflow.version !== 1
    || !Number.isSafeInteger(workflow.attemptCount) || workflow.attemptCount < 1 || workflow.attemptCount > 50
    || !validProvider(workflow.paidPayoutProvider) || !validReference(workflow.paidTransferReference)) return null;
  return { provider: workflow.paidPayoutProvider, transferReference: workflow.paidTransferReference };
};
