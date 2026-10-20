import { motion } from 'framer-motion';
import {
  AlertTriangle,
  CheckCircle,
  Clock,
  Package,
  RefreshCw,
  Truck,
  XCircle,
} from 'lucide-react';
import StoreAvatar from '../common/StoreAvatar';
import { cancellationRefundPresentation } from '../../utils/orderCancellationPresentation';
import { getBuyerDeliveryHeading, getBuyerShippingPresentation, getShipmentItemLabel } from '../../utils/buyerShipmentPresentation';
import {
  getExactOrderItemUnitAmount,
  getOrderItemLineSubtotal,
  getOrderItemOptionPairs,
  getOrderSellerGroups,
} from '../../utils/orderItems';

const statusSteps = ['pending', 'confirmed', 'processing', 'shipped', 'delivered'];
const statusConfig = {
  pending: { label: 'Pending', icon: Clock, color: 'hsl(30, 90%, 50%)', bg: 'rgba(249, 115, 22, 0.12)' },
  confirmed: { label: 'Confirmed', icon: CheckCircle, color: 'hsl(200, 80%, 50%)', bg: 'rgba(14, 165, 233, 0.12)' },
  processing: { label: 'Processing', icon: RefreshCw, color: 'hsl(220, 70%, 55%)', bg: 'rgba(99, 102, 241, 0.12)' },
  shipped: { label: 'Shipped', icon: Truck, color: 'hsl(260, 60%, 55%)', bg: 'rgba(139, 92, 246, 0.12)' },
  delivered: { label: 'Delivered', icon: CheckCircle, color: 'hsl(150, 60%, 40%)', bg: 'rgba(16, 185, 129, 0.12)' },
  cancelled: { label: 'Cancelled', icon: XCircle, color: 'hsl(0, 72%, 55%)', bg: 'rgba(239, 68, 68, 0.12)' },
};

const readGroups = (order) => {
  try {
    return { groups: getOrderSellerGroups(order), error: null };
  } catch (error) {
    return { groups: [], error };
  }
};

const StatusBadge = ({ status }) => {
  const config = statusConfig[status] || statusConfig.pending;
  const Icon = config.icon;
  return (
    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold" style={{ color: config.color, background: config.bg, border: `1px solid ${config.color}22` }}>
      <Icon className="w-3.5 h-3.5" /> {config.label}
    </span>
  );
};

const SellerProgress = ({ status }) => {
  if (status === 'cancelled') {
    return <div className="rounded-xl p-3 text-sm font-semibold flex items-center gap-2" style={{ color: statusConfig.cancelled.color, background: statusConfig.cancelled.bg }}><XCircle className="w-4 h-4" /> This seller portion was cancelled</div>;
  }
  const activeIndex = Math.max(0, statusSteps.indexOf(status));
  return (
    <div className="grid grid-cols-5 gap-1.5" aria-label={`Seller shipment status: ${status}`}>
      {statusSteps.map((step, index) => {
        const active = index <= activeIndex;
        const config = statusConfig[step];
        const Icon = config.icon;
        return (
          <div key={step} className="min-w-0 text-center">
            <div className="h-1.5 rounded-full mb-2" style={{ background: active ? config.color : 'hsl(var(--muted))' }} />
            <Icon className="w-3.5 h-3.5 mx-auto" style={{ color: active ? config.color : 'hsl(var(--muted-foreground))' }} />
            <span className="hidden sm:block text-[10px] mt-1 truncate" style={{ color: active ? 'hsl(var(--foreground))' : 'hsl(var(--muted-foreground))' }}>{config.label}</span>
          </div>
        );
      })}
    </div>
  );
};

export const BuyerSellerStatusChips = ({ order }) => {
  const { groups, error } = readGroups(order);
  if (error) {
    return <span className="inline-flex items-center gap-1 text-xs" style={{ color: 'hsl(0, 72%, 55%)' }}><AlertTriangle className="w-3.5 h-3.5" /> Seller breakdown unavailable</span>;
  }
  if (!groups.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5 mt-2">
      {groups.map(group => (
        <span key={group.sellerId} className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px]" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid var(--glass-border-subtle)', color: 'hsl(var(--muted-foreground))' }}>
          <StoreAvatar logo={group.storeLogo} storeName={group.storeName} size="xs" /> <span className="max-w-[130px] truncate">{group.storeName}</span> · <span className="font-semibold capitalize">{group.status}</span>
        </span>
      ))}
    </div>
  );
};

const SellerGroup = ({ group, formatMoney, index, onCancel, currency, order }) => {
  const summary = group.summary;
  const refund = cancellationRefundPresentation(group.cancellation, currency, summary.totalAmount, order);
  const shipping = getBuyerShippingPresentation(group.shippingMethod);
  return (
    <motion.section initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.06 }} className="buyer-shipment-card rounded-2xl overflow-hidden" data-seller-id={group.sellerId}>
      <div className="p-4 sm:p-5 border-b buyer-shipment-divider">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <StoreAvatar logo={group.storeLogo} storeName={group.storeName} />
            <div className="min-w-0">
              <h3 className="text-base font-bold truncate" style={{ color: 'hsl(var(--foreground))' }}>{group.storeName}</h3>
              <p className="text-xs mt-1 buyer-shipment-secondary">{getShipmentItemLabel(group.itemCount, group.units)}</p>
            </div>
          </div>
          <StatusBadge status={group.status} />
        </div>
        <div className="mt-4"><SellerProgress status={group.status} /></div>
        {refund && <div className="buyer-shipment-panel rounded-xl p-3 mt-3 text-sm" role="status">
          <p className="font-semibold">{refund.label}</p>
          {refund.valid && refund.destination && <p className="text-xs buyer-shipment-secondary mt-1">{formatMoney(refund.amount)} → {refund.destination}</p>}
          {refund.valid && refund.deduction > 0 && <p className="text-xs buyer-shipment-secondary mt-1">Processing fee: {formatMoney(refund.deduction)}</p>}
          {refund.message && <p className="text-xs buyer-shipment-secondary mt-1">{refund.message}</p>}
        </div>}
      </div>

      <div className="p-4 sm:p-5 grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_260px] gap-5 sm:gap-6">
        <div className="min-w-0 space-y-4">
          {group.items.map((item, itemIndex) => {
            const options = getOrderItemOptionPairs(item);
            const exactUnitAmount = getExactOrderItemUnitAmount(item);
            return (
              <div key={`${group.itemIndexes[itemIndex]}:${item.productId || item.name}`} className="flex items-start gap-3 sm:gap-4">
                <div className="w-14 h-14 sm:w-16 sm:h-16 buyer-shipment-panel rounded-xl overflow-hidden shrink-0 flex items-center justify-center">
                  {item.image ? <img src={item.image} alt={item.name} className="w-full h-full object-cover" /> : <Package className="w-5 h-5" style={{ color: 'hsl(var(--muted-foreground))' }} />}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold break-words" style={{ color: 'hsl(var(--foreground))' }}>{item.name}</p>
                  {options.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {options.map(option => <span key={`${option.name}:${option.value}`} className="buyer-shipment-option px-2 py-1 rounded-md text-xs font-medium">{option.name}: {option.value}</span>)}
                    </div>
                  )}
                  <p className="text-xs mt-2 buyer-shipment-secondary">
                    {exactUnitAmount !== null ? `Qty ${item.quantity} · ${formatMoney(exactUnitAmount)} each` : `Qty ${item.quantity} · complete line price`}
                  </p>
                </div>
                <div className="shrink-0 text-right max-w-[42%]">
                  <p className="text-[11px] buyer-shipment-secondary mb-1">Item total</p>
                  <p className="text-sm font-semibold break-words">{formatMoney(getOrderItemLineSubtotal(item))}</p>
                </div>
              </div>
            );
          })}

          <div className="buyer-shipment-panel rounded-xl p-3 sm:p-4 flex items-start gap-3">
            <Truck className="w-4 h-4 mt-0.5 shrink-0 buyer-shipment-secondary" aria-hidden="true" />
            <div className="min-w-0">
              <p className="text-sm font-semibold break-words">{shipping.name}</p>
              {shipping.estimate && <p className="text-xs mt-1 buyer-shipment-secondary">{shipping.estimate}</p>}
            </div>
          </div>
        </div>

        <dl className="buyer-shipment-panel rounded-xl p-4 h-fit space-y-2.5 text-[13px] min-w-0">
          <div className="flex justify-between gap-3"><dt className="buyer-shipment-secondary">Subtotal</dt><dd className="text-right font-medium break-words min-w-0">{formatMoney(summary.subtotal)}</dd></div>
          <div className="flex justify-between gap-3"><dt className="buyer-shipment-secondary">Shipping</dt><dd className="text-right font-medium break-words min-w-0">{summary.shippingCost === 0 ? 'Free' : formatMoney(summary.shippingCost)}</dd></div>
          {summary.tax > 0 && <div className="flex justify-between gap-3"><dt className="buyer-shipment-secondary">Tax</dt><dd className="text-right font-medium break-words min-w-0">{formatMoney(summary.tax)}</dd></div>}
          {summary.couponDiscount > 0 && <div className="flex justify-between gap-3"><dt className="buyer-shipment-secondary">Discount</dt><dd className="text-right font-medium break-words min-w-0">-{formatMoney(summary.couponDiscount)}</dd></div>}
          {summary.reconciliationAdjustment !== 0 && <div className="flex justify-between gap-3"><dt className="buyer-shipment-secondary">Rounding</dt><dd className="text-right font-medium break-words min-w-0">{summary.reconciliationAdjustment > 0 ? '+' : '-'}{formatMoney(Math.abs(summary.reconciliationAdjustment))}</dd></div>}
          <div className="flex justify-between items-start gap-3 pt-3 mt-3 border-t buyer-shipment-divider"><dt className="text-sm font-bold shrink-0">Store total</dt><dd className="text-base font-extrabold buyer-shipment-total text-right break-words min-w-0">{formatMoney(summary.totalAmount)}</dd></div>
        </dl>
      </div>
      {group.canCancel === true && onCancel && <div className="px-4 sm:px-5 py-3 border-t buyer-shipment-divider">
        <button type="button" onClick={() => onCancel(group)} aria-label={`Cancel ${group.storeName} items`}
          className="buyer-shipment-cancel min-h-11 rounded-lg px-2.5 py-2 text-xs font-medium inline-flex items-center gap-2">
          <XCircle size={14} /> Cancel this store’s items
        </button>
      </div>}
    </motion.section>
  );
};

const BuyerSellerFulfillmentGroups = ({ order, formatMoney, showHeading = true, onCancel }) => {
  const { groups, error } = readGroups(order);
  if (error) {
    return (
      <div className="glass-panel p-4 flex items-start gap-3" style={{ borderColor: 'rgba(239, 68, 68, 0.25)' }}>
        <AlertTriangle className="w-5 h-5 shrink-0" style={{ color: 'hsl(0, 72%, 55%)' }} />
        <div><p className="text-sm font-semibold" style={{ color: 'hsl(var(--foreground))' }}>Seller breakdown could not be verified</p><p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>The stored totals were not rendered because they did not pass order-integrity checks. Contact support with this order ID.</p></div>
      </div>
    );
  }
  if (!groups.length) return null;
  const heading = getBuyerDeliveryHeading(groups.length);
  return (
    <div className="space-y-3">
      {showHeading && (
        <div>
          <h2 className="text-base sm:text-lg font-semibold" style={{ color: 'hsl(var(--foreground))' }}>{heading.title}</h2>
          <p className="text-sm mt-1" style={{ color: 'hsl(var(--secondary-foreground))' }}>{heading.subtitle}</p>
        </div>
      )}
      {groups.map((group, index) => <SellerGroup key={group.sellerId} group={group} formatMoney={formatMoney} index={index} currency={order.currency} order={order} onCancel={onCancel} />)}
    </div>
  );
};

export default BuyerSellerFulfillmentGroups;
