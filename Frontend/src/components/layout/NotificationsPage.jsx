import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
    AlertTriangle, Bell, CheckCircle, Eye, Info, Loader2,
    Package, Search, Shield, ShoppingBag, Store,
} from 'lucide-react';
import { Link, useOutletContext } from 'react-router-dom';
import axios from 'axios';
import { useAuth } from '../../contexts/AuthContext';
import { getAuthToken } from '../../utils/cookieHelper';
import {
    createNotificationRequestGuard,
    inspectNotificationInboxResponse,
    inspectNotificationReadAllResponse,
    inspectNotificationReadResponse,
    mergeNotificationStreams,
    resolveNotificationSurfaceAccount,
} from '../../utils/notificationInboxSafety';
import { formatSyntheticPaidOrderReceipt } from '../../utils/orderReceipt';

const NotificationsPage = () => {
    const { products = [], orders = [], dashboardRole } = useOutletContext() || {};
    const { currentUser } = useAuth();
    const notificationSurface = dashboardRole === 'user'
        ? 'buyer'
        : dashboardRole === 'seller' || dashboardRole === 'admin'
            ? dashboardRole
            : null;
    const isAdmin = notificationSurface === 'admin';
    const currentUserId = currentUser?.id;
    const currentUserUnderscoreId = currentUser?._id;
    const currentUserRole = currentUser?.role;
    const account = useMemo(
        () => resolveNotificationSurfaceAccount({
            id: currentUserId,
            _id: currentUserUnderscoreId,
            role: currentUserRole,
        }, notificationSurface),
        [currentUserId, currentUserUnderscoreId, currentUserRole, notificationSurface],
    );
    const accountKey = account?.key || null;
    const loadGuardRef = useRef(createNotificationRequestGuard());
    const mutationGuardRef = useRef(createNotificationRequestGuard());
    const [filter, setFilter] = useState('all');
    const [searchTerm, setSearchTerm] = useState('');
    const [stores, setStores] = useState([]);
    const [storesAccountKey, setStoresAccountKey] = useState(null);
    const [durableItems, setDurableItems] = useState([]);
    const [durableUnread, setDurableUnread] = useState(null);
    const [durableAccountKey, setDurableAccountKey] = useState(null);
    const [loadState, setLoadState] = useState({ accountKey, status: 'loading' });
    const [inboxError, setInboxError] = useState('');
    const [inboxErrorAccountKey, setInboxErrorAccountKey] = useState(null);
    const [mutationError, setMutationError] = useState('');
    const [mutationErrorAccountKey, setMutationErrorAccountKey] = useState(null);

    const visibleDurableItems = useMemo(
        () => durableAccountKey === accountKey ? durableItems : [],
        [durableAccountKey, accountKey, durableItems],
    );
    const visibleDurableUnread = durableAccountKey === accountKey ? durableUnread : null;
    const visibleStores = useMemo(
        () => storesAccountKey === accountKey ? stores : [],
        [storesAccountKey, accountKey, stores],
    );
    const visibleInboxError = inboxErrorAccountKey === accountKey ? inboxError : '';
    const visibleMutationError = mutationErrorAccountKey === accountKey ? mutationError : '';

    useEffect(() => {
        const loadGuard = loadGuardRef.current;
        const mutationGuard = mutationGuardRef.current;
        loadGuard.activate(accountKey);
        mutationGuard.activate(accountKey);
        setDurableItems([]);
        setDurableUnread(null);
        setDurableAccountKey(null);
        setStores([]);
        setStoresAccountKey(null);
        setInboxError('');
        setInboxErrorAccountKey(null);
        setMutationError('');
        setMutationErrorAccountKey(null);
        setLoadState({ accountKey, status: 'loading' });

        if (!account) {
            setInboxError('Notifications are unavailable because the active account could not be verified.');
            setInboxErrorAccountKey(accountKey);
            setLoadState({ accountKey, status: 'settled' });
            return () => {
                loadGuard.invalidate();
                mutationGuard.invalidate();
            };
        }

        const token = getAuthToken();
        const controller = new AbortController();
        const request = loadGuard.begin(account.key);

        const load = async () => {
            const inboxPromise = axios.get(`${import.meta.env.VITE_API_URL}api/notifications/me`, {
                headers: { Authorization: `Bearer ${token}` },
                signal: controller.signal,
                params: { surface: notificationSurface },
            });
            const storesPromise = isAdmin
                ? axios.get(`${import.meta.env.VITE_API_URL}api/stores/all`, {
                    headers: { Authorization: `Bearer ${token}` },
                    signal: controller.signal,
                })
                : Promise.resolve(null);

            const [inboxResult, storesResult] = await Promise.allSettled([inboxPromise, storesPromise]);
            if (!loadGuard.isCurrent(request, account.key)) return;

            if (inboxResult.status !== 'fulfilled') {
                setInboxError('Your durable notification inbox could not be loaded. Please try again.');
                setInboxErrorAccountKey(account.key);
            } else {
                const inspected = inspectNotificationInboxResponse(
                    inboxResult.value.data,
                    account,
                    { surface: notificationSurface },
                );
                if (!inspected.valid) {
                    setInboxError('Your notification inbox response could not be verified for this account.');
                    setInboxErrorAccountKey(account.key);
                } else {
                    setDurableItems(inspected.items);
                    setDurableUnread(inspected.unread);
                    setDurableAccountKey(account.key);
                }
            }

            if (isAdmin && storesResult.status === 'fulfilled') {
                const candidateStores = storesResult.value?.data?.stores;
                setStores(Array.isArray(candidateStores) ? candidateStores : []);
                setStoresAccountKey(account.key);
            }
            setLoadState({ accountKey: account.key, status: 'settled' });
        };

        load().catch(() => {
            if (!loadGuard.isCurrent(request, account.key)) return;
            setDurableItems([]);
            setDurableUnread(null);
            setDurableAccountKey(null);
            setStores([]);
            setStoresAccountKey(null);
            setInboxError('Your durable notification inbox could not be loaded. Please try again.');
            setInboxErrorAccountKey(account.key);
            setLoadState({ accountKey: account.key, status: 'settled' });
        });

        return () => {
            controller.abort();
            loadGuard.invalidate();
            mutationGuard.invalidate();
        };
    }, [account, accountKey, isAdmin, notificationSurface]);

    const notifications = useMemo(() => {
        const synthetic = [];
        const now = new Date().toISOString();
        const persistedPaidOrderIds = new Set(
            visibleDurableItems
                .filter(item => item.eventType === 'order.paid' && item.aggregateType === 'Order')
                .map(item => item.aggregateId)
                .filter(Boolean),
        );

        products.filter(product => product.stock === 0).forEach(product => {
            synthetic.push({
                id: `stock-oos-${product._id}`,
                type: 'critical', category: 'stock', title: `${product.name} is out of stock`,
                description: 'Update inventory to avoid lost sales', time: now, icon: 'package',
                eventType: 'product.out_of_stock', aggregateType: 'Product', aggregateId: String(product._id || ''),
                _stream: 'synthetic', read: false,
            });
        });
        products.filter(product => product.stock > 0 && product.stock <= 10).forEach(product => {
            synthetic.push({
                id: `stock-low-${product._id}`,
                type: 'warning', category: 'stock', title: `${product.name} running low`,
                description: `Only ${product.stock} units remaining`, time: now, icon: 'package',
                eventType: 'product.low_stock', aggregateType: 'Product', aggregateId: String(product._id || ''),
                _stream: 'synthetic', read: false,
            });
        });

        orders.filter(order => order.orderStatus === 'pending').forEach(order => {
            synthetic.push({
                id: `order-pending-${order._id}`,
                type: 'info', category: 'order', title: `New order #${order.orderId || 'N/A'}`,
                description: `${order.shippingInfo?.fullName || 'Customer'} · ${order.orderItems?.length || 0} item(s)`,
                time: order.createdAt, icon: 'order',
                linkTo: isAdmin ? `/admin-dashboard/order/${order._id}` : `/seller-dashboard/order/${order._id}`,
                eventType: 'order.pending', aggregateType: 'Order', aggregateId: String(order._id || ''),
                _stream: 'synthetic', read: false,
            });
        });
        orders.filter(order => (
            order.isPaid
            && order.orderStatus === 'confirmed'
            && !persistedPaidOrderIds.has(String(order._id))
        )).forEach(order => {
            // This fallback is permitted only for the full-order admin outlet.
            // Seller allocation receipts must come from the frozen durable event.
            const receiptAmount = formatSyntheticPaidOrderReceipt(order, dashboardRole);
            if (!receiptAmount) return;
            synthetic.push({
                id: `order-paid-${order._id}`,
                type: 'success', category: 'payment', title: `Payment received for #${order.orderId || 'N/A'}`,
                description: receiptAmount, time: order.paidAt || order.createdAt, icon: 'order',
                linkTo: `/admin-dashboard/order/${order._id}`,
                eventType: 'order.paid', aggregateType: 'Order', aggregateId: String(order._id || ''),
                _stream: 'synthetic', read: false,
            });
        });
        orders.filter(order => order.orderStatus === 'delivered').slice(0, 5).forEach(order => {
            synthetic.push({
                id: `order-delivered-${order._id}`,
                type: 'success', category: 'order', title: `Order #${order.orderId || 'N/A'} delivered`,
                description: 'Successfully completed', time: order.updatedAt || order.createdAt, icon: 'order',
                eventType: 'order.delivered', aggregateType: 'Order', aggregateId: String(order._id || ''),
                _stream: 'synthetic', read: false,
            });
        });

        if (isAdmin) {
            visibleStores.filter(store => {
                const createdAt = Date.parse(store.createdAt);
                return Number.isFinite(createdAt) && Date.now() - createdAt < 30 * 24 * 60 * 60 * 1000;
            }).forEach(store => {
                synthetic.push({
                    id: `store-new-${store._id}`,
                    type: 'info', category: 'store', title: `New store: ${store.storeName}`,
                    description: 'Created by a seller', time: store.createdAt, icon: 'store',
                    _stream: 'synthetic', read: false,
                });
            });
            visibleStores.filter(store => !store.isVerified).forEach(store => {
                synthetic.push({
                    id: `store-verify-${store._id}`,
                    type: 'warning', category: 'store', title: `${store.storeName} pending verification`,
                    description: 'Review and verify this store', time: store.createdAt, icon: 'shield',
                    linkTo: '/admin-dashboard/store-verifications', _stream: 'synthetic', read: false,
                });
            });
            visibleStores.filter(store => store.isVerified).forEach(store => {
                synthetic.push({
                    id: `store-verified-${store._id}`,
                    type: 'success', category: 'store', title: `${store.storeName} is verified`,
                    description: 'Store verification approved', time: store.updatedAt || store.createdAt,
                    icon: 'store', _stream: 'synthetic', read: false,
                });
            });
        }

        return mergeNotificationStreams({ durableItems: visibleDurableItems, analyticsItems: synthetic });
    }, [products, orders, visibleStores, visibleDurableItems, dashboardRole, isAdmin]);

    const markAsRead = async (notification) => {
        if (!account || notification._stream !== 'durable' || notification.read || !notification.inboxId) return;
        const request = mutationGuardRef.current.begin(account.key);
        setMutationError('');
        setMutationErrorAccountKey(null);
        try {
            const response = await axios.patch(
                `${import.meta.env.VITE_API_URL}api/notifications/${notification.inboxId}/read`,
                {},
                {
                    headers: { Authorization: `Bearer ${getAuthToken()}` },
                    params: { surface: notificationSurface },
                },
            );
            const inspected = inspectNotificationReadResponse(
                response.data,
                account,
                notification.inboxId,
                { surface: notificationSurface },
            );
            if (!inspected.valid) throw new Error('Unverified notification read response.');
            if (!mutationGuardRef.current.isCurrent(request, account.key)) return;
            setDurableItems(items => items.map(item => (
                item.inboxId === notification.inboxId ? inspected.item : item
            )));
            setDurableUnread(count => Number.isSafeInteger(count) ? Math.max(0, count - 1) : count);
            setDurableAccountKey(account.key);
        } catch {
            if (mutationGuardRef.current.isCurrent(request, account.key)) {
                setMutationError('This notification could not be marked as read.');
                setMutationErrorAccountKey(account.key);
            }
        }
    };

    const markAllRead = async () => {
        if (!account || !Number.isSafeInteger(visibleDurableUnread) || visibleDurableUnread === 0) return;
        const request = mutationGuardRef.current.begin(account.key);
        setMutationError('');
        setMutationErrorAccountKey(null);
        try {
            const response = await axios.post(
                `${import.meta.env.VITE_API_URL}api/notifications/read-all`,
                {},
                {
                    headers: { Authorization: `Bearer ${getAuthToken()}` },
                    params: { surface: notificationSurface },
                },
            );
            if (!inspectNotificationReadAllResponse(
                response.data,
                account,
                { surface: notificationSurface },
            ).valid) throw new Error('Unverified read-all response.');
            if (!mutationGuardRef.current.isCurrent(request, account.key)) return;
            const readAt = new Date().toISOString();
            setDurableItems(items => items.map(item => ({ ...item, read: true, readAt })));
            setDurableUnread(0);
            setDurableAccountKey(account.key);
        } catch {
            if (mutationGuardRef.current.isCurrent(request, account.key)) {
                setMutationError('Notifications could not be marked as read.');
                setMutationErrorAccountKey(account.key);
            }
        }
    };

    const categories = useMemo(() => {
        const available = new Set(notifications.map(notification => notification.category));
        return ['all', ...['stock', 'order', 'payment', 'store', 'system'].filter(category => available.has(category))];
    }, [notifications]);
    const filtered = notifications.filter(notification => {
        if (filter !== 'all' && notification.category !== filter) return false;
        if (searchTerm && !notification.title.toLowerCase().includes(searchTerm.toLowerCase())) return false;
        return true;
    });
    const unreadCount = Number.isSafeInteger(visibleDurableUnread) ? visibleDurableUnread : 0;
    const loading = loadState.accountKey !== accountKey || loadState.status === 'loading';

    const iconMap = {
        package: <Package size={16} />, order: <ShoppingBag size={16} />,
        store: <Store size={16} />, shield: <Shield size={16} />,
    };
    const typeIconMap = {
        critical: <AlertTriangle size={16} />, warning: <AlertTriangle size={16} />,
        info: <Info size={16} />, success: <CheckCircle size={16} />,
    };
    const colorMap = {
        critical: { bg: 'rgba(239,68,68,0.12)', color: 'hsl(0,72%,55%)' },
        warning: { bg: 'rgba(245,158,11,0.12)', color: 'hsl(45,80%,40%)' },
        info: { bg: 'rgba(99,102,241,0.12)', color: 'hsl(220,70%,55%)' },
        success: { bg: 'rgba(16,185,129,0.12)', color: 'hsl(150,60%,45%)' },
    };

    return (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="p-4 sm:p-6 max-w-4xl mx-auto space-y-6">
            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                <div>
                    <div className="tag-pill mb-2"><Bell size={12} /> Notifications</div>
                    <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight" style={{ color: 'hsl(var(--foreground))' }}>Notification Center</h1>
                    <p className="text-sm mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                        {unreadCount > 0
                            ? `${unreadCount} unread inbox notification${unreadCount > 1 ? 's' : ''}`
                            : 'No unread inbox notifications'}
                    </p>
                </div>
                {unreadCount > 0 && (
                    <motion.button whileTap={{ scale: 0.95 }} onClick={markAllRead}
                        className="px-4 py-2 rounded-xl text-xs font-semibold glass-inner" style={{ color: 'hsl(220,70%,55%)' }}>
                        <Eye size={14} className="inline mr-1" /> Mark all read
                    </motion.button>
                )}
            </motion.div>

            {(visibleInboxError || visibleMutationError) && (
                <div role="alert" className="glass-panel p-3 text-xs" style={{ color: 'hsl(0,72%,55%)' }}>
                    {visibleMutationError || visibleInboxError}
                </div>
            )}

            <div className="flex flex-col sm:flex-row gap-3">
                <div className="flex gap-2 flex-wrap">
                    {categories.map(category => (
                        <motion.button key={category} whileTap={{ scale: 0.95 }} onClick={() => setFilter(category)}
                            className={`px-3 py-1.5 rounded-xl text-xs font-medium capitalize transition-all ${filter === category ? 'border' : 'glass-inner'}`}
                            style={filter === category
                                ? { background: 'rgba(99,102,241,0.12)', color: 'hsl(220,70%,55%)', borderColor: 'rgba(99,102,241,0.3)' }
                                : { color: 'hsl(var(--muted-foreground))' }}>
                            {category}
                        </motion.button>
                    ))}
                </div>
                <div className="relative flex-1 max-w-xs">
                    <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'hsl(var(--muted-foreground))' }} />
                    <input value={searchTerm} onChange={event => setSearchTerm(event.target.value)}
                        className="glass-input pl-9 text-xs" placeholder="Search notifications..." />
                </div>
            </div>

            {loading ? (
                <div className="flex items-center justify-center py-16">
                    <Loader2 size={24} className="animate-spin" style={{ color: 'hsl(var(--muted-foreground))' }} />
                </div>
            ) : filtered.length === 0 ? (
                <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="glass-panel p-12 text-center">
                    <Bell size={40} style={{ color: 'hsl(var(--muted-foreground))' }} className="mx-auto mb-3 opacity-40" />
                    <p className="text-sm font-medium" style={{ color: 'hsl(var(--muted-foreground))' }}>
                        {visibleInboxError ? 'No verified notifications are available.' : 'No notifications found'}
                    </p>
                </motion.div>
            ) : (
                <div className="space-y-2">
                    <AnimatePresence>
                        {filtered.map((notification, index) => {
                            const colors = colorMap[notification.type] || colorMap.info;
                            const isRead = notification._stream === 'durable' && notification.read === true;
                            const content = (
                                <motion.div
                                    key={notification.id}
                                    initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                                    transition={{ delay: index * 0.02 }}
                                    onClick={() => markAsRead(notification)}
                                    className={`glass-panel p-4 flex items-start gap-4 cursor-pointer transition-all hover:scale-[1.005] ${isRead ? 'opacity-60' : ''}`}>
                                    <div className="p-2 rounded-xl shrink-0" style={{ background: colors.bg, color: colors.color }}>
                                        {iconMap[notification.icon] || typeIconMap[notification.type]}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2">
                                            <p className="text-sm font-semibold" style={{ color: 'hsl(var(--foreground))' }}>{notification.title}</p>
                                            {notification._stream === 'durable' && !isRead && (
                                                <div className="w-2 h-2 rounded-full shrink-0" style={{ background: 'hsl(220,70%,55%)' }} />
                                            )}
                                        </div>
                                        {notification.description && <p className="text-xs mt-0.5" style={{ color: 'hsl(var(--muted-foreground))' }}>{notification.description}</p>}
                                        <div className="flex items-center gap-2 mt-1.5">
                                            <span className="text-[10px] font-medium px-2 py-0.5 rounded-full capitalize" style={{ background: colors.bg, color: colors.color }}>
                                                {notification.category}
                                            </span>
                                            <span className="text-[10px]" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                                {new Date(notification.time).toLocaleDateString('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                                            </span>
                                        </div>
                                    </div>
                                </motion.div>
                            );
                            return notification.linkTo
                                ? <Link key={notification.id} to={notification.linkTo}>{content}</Link>
                                : <div key={notification.id}>{content}</div>;
                        })}
                    </AnimatePresence>
                </div>
            )}
        </motion.div>
    );
};

export default NotificationsPage;
