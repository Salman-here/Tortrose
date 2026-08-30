import { motion } from 'framer-motion';
import {
  AlertTriangle,
  CheckCircle,
  Clock,
  Package,
  RefreshCw,
  Store,
  Truck,
  XCircle,
} from 'lucide-react';
import {
  getOrderItemLineSubtotal,
  getOrderItemOptionPairs,
  getOrderSellerGroups,
  hasExactOrderItemUnitEquation,
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
          <Store className="w-3 h-3" /> <span className="max-w-[130px] truncate">{group.storeName}</span> · <span className="font-semibold capitalize">{group.status}</span>
        </span>
      ))}
    </div>
  );
};

const SellerGroup = ({ group, formatMoney, index }) => {
  const summary = group.summary;
  return (
    <motion.section initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.06 }} className="glass-inner rounded-2xl overflow-hidden" data-seller-id={group.sellerId}>
      <div className="p-4 sm:p-5" style={{ borderBottom: '1px solid var(--glass-border-subtle)' }}>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ background: 'rgba(99, 102, 241, 0.10)' }}><Store className="w-5 h-5" style={{ color: 'hsl(var(--primary))' }} /></div>
            <div className="min-w-0">
              <h3 className="text-base font-bold truncate" style={{ color: 'hsl(var(--foreground))' }}>{group.storeName}</h3>
              <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>{group.itemCount} product line{group.itemCount === 1 ? '' : 's'} · {group.units} unit{group.units === 1 ? '' : 's'}</p>
            </div>
          </div>
          <StatusBadge status={group.status} />
        </div>
        <div className="mt-4"><SellerProgress status={group.status} /></div>
      </div>

      <div className="p-4 sm:p-5 grid grid-cols-1 xl:grid-cols-[1fr_230px] gap-5">
        <div className="space-y-3">
          {group.items.map((item, itemIndex) => {
            const options = getOrderItemOptionPairs(item);
            return (
              <div key={`${group.itemIndexes[itemIndex]}:${item.productId || item.name}`} className="flex items-start gap-3">
                <div className="w-14 h-14 rounded-xl overflow-hidden shrink-0 flex items-center justify-center" style={{ background: 'rgba(255,255,255,0.04)' }}>
                  {item.image ? <img src={item.image} alt={item.name} className="w-full h-full object-cover" /> : <Package className="w-5 h-5" style={{ color: 'hsl(var(--muted-foreground))' }} />}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold break-words" style={{ color: 'hsl(var(--foreground))' }}>{item.name}</p>
                  {options.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {options.map(option => <span key={`${option.name}:${option.value}`} className="px-2 py-0.5 rounded-full text-[10px] font-semibold" style={{ background: 'rgba(99, 102, 241, 0.12)', color: 'hsl(220, 70%, 55%)' }}>{option.name}: {option.value}</span>)}
                    </div>
                  )}
                  <p className="text-xs mt-1.5" style={{ color: 'hsl(var(--muted-foreground))' }}>
                    {hasExactOrderItemUnitEquation(item) ? `${item.quantity} × ${formatMoney(item.price)}` : `${item.quantity} unit${item.quantity === 1 ? '' : 's'} · complete line price`}
                  </p>
                </div>
                <span className="text-sm font-bold shrink-0" style={{ color: 'hsl(var(--foreground))' }}>{formatMoney(getOrderItemLineSubtotal(item))}</span>
              </div>
            );
          })}

          <div className="rounded-xl p-3 text-xs flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2" style={{ background: 'rgba(255,255,255,0.035)', color: 'hsl(var(--muted-foreground))' }}>
            <span className="font-semibold" style={{ color: 'hsl(var(--foreground))' }}>
              {group.shippingMethod?.name || 'Shipping details unavailable for this legacy order'}
            </span>
            {group.shippingMethod && (
              <span>{group.shippingMethod.estimatedDays ? `${group.shippingMethod.estimatedDays} day${group.shippingMethod.estimatedDays === 1 ? '' : 's'} · ` : ''}{group.shippingMethod.price === 0 ? 'Free shipping' : formatMoney(group.shippingMethod.price)}</span>
            )}
          </div>
        </div>

        <div className="rounded-xl p-3 h-fit space-y-2 text-xs" style={{ background: 'rgba(255,255,255,0.035)' }}>
          <div className="flex justify-between gap-3"><span style={{ color: 'hsl(var(--muted-foreground))' }}>Products</span><span>{formatMoney(summary.subtotal)}</span></div>
          <div className="flex justify-between gap-3"><span style={{ color: 'hsl(var(--muted-foreground))' }}>Shipping</span><span>{summary.shippingCost === 0 ? 'Free' : formatMoney(summary.shippingCost)}</span></div>
          {summary.tax > 0 && <div className="flex justify-between gap-3"><span style={{ color: 'hsl(var(--muted-foreground))' }}>Tax</span><span>{formatMoney(summary.tax)}</span></div>}
          {summary.couponDiscount > 0 && <div className="flex justify-between gap-3" style={{ color: 'hsl(150, 60%, 40%)' }}><span>Discount</span><span>-{formatMoney(summary.couponDiscount)}</span></div>}
          {summary.reconciliationAdjustment !== 0 && <div className="flex justify-between gap-3"><span style={{ color: 'hsl(var(--muted-foreground))' }}>Rounding</span><span>{summary.reconciliationAdjustment > 0 ? '+' : '-'}{formatMoney(Math.abs(summary.reconciliationAdjustment))}</span></div>}
          <div className="flex justify-between gap-3 pt-2 text-sm font-extrabold" style={{ borderTop: '1px solid var(--glass-border-subtle)', color: 'hsl(var(--foreground))' }}><span>Seller total</span><span>{formatMoney(summary.totalAmount)}</span></div>
        </div>
      </div>
    </motion.section>
  );
};

const BuyerSellerFulfillmentGroups = ({ order, formatMoney, showHeading = true }) => {
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
  return (
    <div className="space-y-3">
      {showHeading && (
        <div>
          <h2 className="text-base sm:text-lg font-semibold" style={{ color: 'hsl(var(--foreground))' }}>Seller shipments</h2>
          <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>This is one order split into {groups.length} seller shipment{groups.length === 1 ? '' : 's'}. Each store controls only its own status, shipping, and products.</p>
        </div>
      )}
      {groups.map((group, index) => <SellerGroup key={group.sellerId} group={group} formatMoney={formatMoney} index={index} />)}
    </div>
  );
};

export default BuyerSellerFulfillmentGroups;
