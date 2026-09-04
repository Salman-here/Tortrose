/**
 * AI Tool Executor
 * ──────────────────
 * Maps each tool name from the AI to a call against our own `/api/ai-actions/*`
 * backend. Each backend route re-validates the caller's role, so even if the
 * AI attempts a cross-role action, the server will reject it.
 *
 * Returns: { ok: true, ...data } or { ok: false, error: '...', msg: '...' }
 */
import axios from 'axios';
import { getAuthToken } from "../utils/cookieHelper";
import { normalizeAIRoute } from './aiRouteGuard';

const apiUrl = () => import.meta.env.VITE_API_URL;
const authHeaders = () => {
  const jwt = getAuthToken();
  return jwt ? { Authorization: `Bearer ${jwt}` } : {};
};

// ─── Helper: build query strings from args ───
const qs = (args = {}) => {
  const p = new URLSearchParams();
  Object.entries(args).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') p.append(k, String(v));
  });
  const s = p.toString();
  return s ? `?${s}` : '';
};

// ─── Thin helpers ───
const GET = async (path, args) => {
  try {
    const res = await axios.get(`${apiUrl()}api/ai-actions${path}${qs(args)}`, { headers: authHeaders() });
    return { ok: true, ...res.data };
  } catch (e) {
    return { ok: false, error: e.response?.data?.msg || e.message || 'Request failed', msg: e.response?.data?.msg };
  }
};
const POST = async (path, body) => {
  try {
    const res = await axios.post(`${apiUrl()}api/ai-actions${path}`, body, { headers: authHeaders() });
    return { ok: true, ...res.data };
  } catch (e) {
    return { ok: false, error: e.response?.data?.msg || e.message || 'Request failed', msg: e.response?.data?.msg, missingFields: e.response?.data?.missingFields };
  }
};

/**
 * Execute a tool call. Pure functions only — must not navigate; the caller
 * handles navigation by passing in `navigate` for the `navigate` tool.
 */
export async function executeAIToolCall(name, args, ctx = {}) {
  const { navigate } = ctx;
  switch (name) {
    // ─── Shared / user tools ───
    case 'search_products': {
      try {
        const url = `${apiUrl()}api/ai-actions/search-products${qs({ query: args.query, category: args.category, maxPrice: args.maxPrice, minPrice: args.minPrice, limit: 5 })}`;
        const res = await axios.get(url);
        return { ok: true, products: res.data.products || [] };
      } catch {
        return { ok: false, products: [], error: 'Could not search products' };
      }
    }
    case 'navigate': {
      const route = normalizeAIRoute(args.route);
      if (navigate) setTimeout(() => navigate(route), 400);
      return { ok: true, navigated: true, label: args.label || route, route };
    }
    case 'show_style_advice':
      return { ok: true, styleAdvice: args };
    case 'suggest_outfit':
      return { ok: true, outfitSuggestion: args };
    case 'get_subscription_catalog':
      return GET('/subscription-catalog');

    // ─── User tools ───
    case 'get_my_orders':
      return GET('/seller-orders', { status: args.status, limit: 10 }); // reuses seller-orders controller for any user
    case 'get_order_detail':
      return GET('/order-detail', { orderId: args.orderId });
    case 'cancel_order':
      return POST('/cancel-order', { orderId: args.orderId });
    case 'submit_complaint': {
      // The complaint endpoint lives under /chatbot/complaint
      try {
        const res = await axios.post(`${apiUrl()}api/chatbot/complaint`, args, { headers: authHeaders() });
        return { ok: true, ...res.data };
      } catch (e) {
        return { ok: false, error: e.response?.data?.msg || 'Could not submit complaint' };
      }
    }
    case 'get_my_complaints': {
      try {
        const res = await axios.get(`${apiUrl()}api/chatbot/my-complaints`, { headers: authHeaders() });
        return {
          ok: true,
          complaints: (res.data.complaints || []).slice(0, 10).map(c => ({
            _id: c._id, subject: c.subject, category: c.category, status: c.status, date: c.createdAt,
          })),
        };
      } catch { return { ok: false, error: 'Could not fetch complaints' }; }
    }
    case 'get_wishlist':
      return GET('/wishlist');
    case 'add_to_wishlist':
      return POST('/add-to-wishlist', { productId: args.productId });
    case 'remove_from_wishlist':
      return POST('/remove-from-wishlist', { productId: args.productId });
    case 'get_addresses':
      return GET('/addresses');
    case 'add_address':
      return POST('/add-address', { address: args.address });
    case 'update_profile':
      return POST('/update-profile', { updates: args.updates });
    case 'get_notifications':
      return GET('/notifications');
    case 'mark_notifications_read':
      return POST('/mark-notifications-read', {});
    case 'get_available_coupons':
      return GET('/available-coupons', { storeId: args.storeId, productId: args.productId });
    case 'validate_coupon':
      return POST('/validate-coupon', {
        code: args.code,
        sellerId: args.sellerId,
        productId: args.productId,
      });

    // ─── Seller tools ───
    case 'add_product':
      return POST('/add-product', { product: args });
    case 'edit_product':
      return POST('/edit-product', args);
    case 'delete_product':
      return POST('/delete-product', args);
    case 'list_my_products':
      return GET('/my-products', { search: args.search, category: args.category, limit: args.limit });
    case 'bulk_discount':
      return POST('/bulk-discount', args);
    case 'bulk_price_update':
      return POST('/bulk-price-update', args);
    case 'remove_discount':
      return POST('/remove-discount', args);
    case 'get_seller_analytics':
      return GET('/seller-analytics');
    case 'get_seller_orders':
      return GET('/seller-orders', { status: args.status, limit: args.limit });
    case 'update_order_status':
      return POST('/update-order-status', args);
    case 'get_my_store':
      return GET('/my-store');
    case 'update_store':
      return POST('/update-store', args);
    case 'get_store_analytics':
      return GET('/store-analytics');
    case 'apply_for_verification':
      return POST('/apply-verification', {});
    case 'get_shipping_methods':
      return GET('/shipping-methods');
    case 'update_shipping':
      return POST('/update-shipping', args);
    case 'create_coupon':
      return POST('/create-coupon', { coupon: args.coupon });
    case 'get_my_coupons':
      return GET('/my-coupons');
    case 'update_coupon':
      return POST('/update-coupon', args);
    case 'delete_coupon':
      return POST('/delete-coupon', args);
    case 'toggle_coupon':
      return POST('/toggle-coupon', args);
    case 'get_subscription_status':
      return GET('/subscription-status');

    // ─── Admin tools ───
    case 'get_all_users':
      return GET('/all-users', args);
    case 'delete_user':
      return POST('/delete-user', args);
    case 'block_user':
      return POST('/block-user', args);
    case 'change_user_role':
      return POST('/change-user-role', args);
    case 'get_admin_analytics':
      return GET('/admin-analytics');
    case 'get_all_orders':
      return GET('/all-orders', { status: args.status, limit: args.limit });
    case 'get_all_complaints':
      return GET('/all-complaints', { category: args.category, status: args.status });
    case 'update_complaint':
      return POST('/update-complaint', args);
    case 'get_pending_verifications':
      return GET('/pending-verifications');
    case 'approve_verification':
      return POST('/approve-verification', args);
    case 'reject_verification':
      return POST('/reject-verification', args);
    case 'remove_verification':
      return POST('/remove-verification', args);
    case 'get_all_stores':
      return GET('/all-stores', { limit: args.limit });
    case 'update_tax_config':
      return POST('/update-tax', args);
    case 'get_tax_config':
      return GET('/tax-config');
    case 'send_broadcast':
      return POST('/send-broadcast', args);
    case 'get_broadcasts':
      return GET('/broadcasts');
    case 'cancel_broadcast':
      return POST('/cancel-broadcast', args);
    case 'get_all_subscriptions':
      return GET('/all-subscriptions');
    case 'get_verified_stores':
      return GET('/verified-stores');
    case 'get_store_details':
      return GET('/store-details', { storeId: args.storeId, slug: args.slug });
    case 'search_stores':
      return GET('/search-stores', { query: args.query, limit: args.limit });

    default:
      return { ok: false, error: `Unknown tool: ${name}` };
  }
}
