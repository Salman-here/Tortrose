import React, { Suspense, lazy } from 'react'
import { Route, Routes, useNavigate, Navigate, useLocation } from 'react-router-dom'
import MainLayoutPage from '../pages/MainLayoutPage'
import Products from '../components/Products'
import ProtectedRoute from '../components/common/ProtectedRoute'
import Loader from '../components/common/Loader'
import DocsPage from '../pages/DocsPage'
import { getMainDomainUrl, isStorefrontSubdomainPath } from '../utils/subdomainHelper'

// CRITICAL (eager): home grid + layout shell are above-the-fold for the LCP.
// Everything else is code-split so the initial JS bundle stays small.

// ── Public pages
const ProductDetailPage = lazy(() => import('../pages/ProductDetailPage'))
const Profile = lazy(() => import('../components/layout/Profile'))
const ForgotPassword = lazy(() => import('../components/auth/ForgotPassword'))
const ResetPassword = lazy(() => import('../components/auth/ResetPassword'))
const Checkout = lazy(() => import('../components/layout/Checkout'))
const Unauthorized = lazy(() => import('../components/layout/Unauthorized'))
const StorePage = lazy(() => import('../pages/StorePage'))
const StoresListing = lazy(() => import('../pages/StoresListing'))
const TrustedStoresPage = lazy(() => import('../pages/TrustedStoresPage'))
const BecomeSeller = lazy(() => import('../pages/BecomeSeller'))
const TermsOfService = lazy(() => import('../pages/TermsOfService'))
const PrivacyPolicy = lazy(() => import('../pages/PrivacyPolicy'))
const AboutPage = lazy(() => import('../pages/AboutPage'))
const ContactPage = lazy(() => import('../pages/ContactPage'))
const FAQPage = lazy(() => import('../pages/FAQPage'))
const TrackOrderPage = lazy(() => import('../pages/TrackOrderPage'))

// ── Auth standalone
const Login = lazy(() => import('../components/auth/Login'))
const SignUp = lazy(() => import('../components/auth/SignUp'))
const GoogleAuthSuccess = lazy(() => import('../components/auth/GoogleAuthSuccess'))
const Success = lazy(() => import('../components/layout/Success'))
const OrderConfirmationPage = lazy(() => import('../pages/OrderConfirmationPage'))
const AIChatPage = lazy(() => import('../pages/AIChatPage'))

// ── User dashboard (auth-gated, never on first paint)
const UserDashboard = lazy(() => import('../components/layout/UserDashboard'))
const AccountOverview = lazy(() => import('../components/layout/AccountOverview'))
const UserOrdersManagement = lazy(() => import('../components/layout/UserOrdersManagement'))
const UserOrderDetail = lazy(() => import('../components/layout/UserOrderDetail'))
const OrderDetail = lazy(() => import('../components/layout/OrderDetail'))
const UserManagement = lazy(() => import('../components/layout/UserManagement'))
const UserWhatsAppSettings = lazy(() => import('../components/layout/UserWhatsAppSettings'))
const Wallet = lazy(() => import('../components/layout/Wallet'))
const PaymentMethods = lazy(() => import('../components/layout/PaymentMethods'))

// ── Admin dashboard
const AdminDashboard = lazy(() => import('../components/layout/AdminDashboard'))
const AdminAnalytics = lazy(() => import('../components/layout/AdminAnalytics'))
const AdminPayments = lazy(() => import('../components/layout/AdminPayments'))
const StoreOverview = lazy(() => import('../components/layout/StoreOverview'))
const ProductManagement = lazy(() => import('../components/layout/ProductManagement'))
const OrderManagement = lazy(() => import('../components/layout/orders'))
const TaxConfiguration = lazy(() => import('../components/layout/TaxConfiguration'))
const StoreVerifications = lazy(() => import('../pages/admin/StoreVerifications'))
const NotificationsPage = lazy(() => import('../components/layout/NotificationsPage'))
const NotificationSettings = lazy(() => import('../components/layout/NotificationSettings'))
const AdminSubdomainManagement = lazy(() => import('../components/layout/AdminSubdomainManagement'))
const ComplaintsManagement = lazy(() => import('../components/layout/ComplaintsManagement'))
const WhatsAppVerificationPanel = lazy(() => import('../components/layout/admin/WhatsAppVerificationPanel'))
const AdminBroadcastPanel = lazy(() => import('../components/layout/admin/AdminBroadcastPanel'))
const AdminAdsPanel = lazy(() => import('../components/layout/admin/AdminAdsPanel'))
const AdminAIPromptsPanel = lazy(() => import('../components/layout/admin/AdminAIPromptsPanel'))

// ── Seller dashboard
const SellerDashboard = lazy(() => import('../components/layout/SellerDashboard'))
const SellerHome = lazy(() => import('../components/layout/SellerHome'))
const SellerAnalytics = lazy(() => import('../components/layout/SellerAnalytics'))
const SellerPayments = lazy(() => import('../components/layout/SellerPayments'))
const SellerProfile = lazy(() => import('../components/layout/SellerProfile'))
const StoreSettings = lazy(() => import('../components/layout/StoreSettings'))
const ShippingConfiguration = lazy(() => import('../components/layout/ShippingConfiguration'))
const SellerSubdomainManagement = lazy(() => import('../components/layout/SellerSubdomainManagement'))
const SellerSubscription = lazy(() => import('../components/layout/SellerSubscription'))
const SellerWhatsAppSettings = lazy(() => import('../components/layout/SellerWhatsAppSettings'))
const CouponManagement = lazy(() => import('../components/layout/CouponManagement'))
const SellerAds = lazy(() => import('../components/layout/SellerAds'))

// On the main domain in production, /docs must redirect to https://docs.rozare.com.
// In local/preview environments we render the DocsPage in-place.
function DocsRouteGate() {
    const host = typeof window !== 'undefined' ? window.location.hostname : '';
    const isLocal = host === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(host);
    const isPreview = ['lovableproject.com', 'lovable.app', 'vercel.app', 'netlify.app', 'pages.dev']
        .some(d => host.endsWith(d));
    if (!isLocal && !isPreview) {
        const target = `${window.location.protocol}//docs.${host.replace(/^www\./, '')}${window.location.search}`;
        window.location.replace(target);
        return null;
    }
    return <DocsPage />;
}

const SuspenseFallback = () => (
    <div style={{ minHeight: '60vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Loader />
    </div>
)

function AppRoutes({ subdomainSlug = null }) {
    const navigate = useNavigate()
    const location = useLocation()
    const shouldLeaveSubdomain = Boolean(subdomainSlug) && !isStorefrontSubdomainPath(location.pathname)

    React.useEffect(() => {
        if (!shouldLeaveSubdomain) return;
        const targetPath = `${location.pathname}${location.search}${location.hash}`;
        window.location.replace(getMainDomainUrl(targetPath));
    }, [shouldLeaveSubdomain, location.pathname, location.search, location.hash]);

    if (shouldLeaveSubdomain) {
        return <SuspenseFallback />;
    }

    return (
        <Suspense fallback={<SuspenseFallback />}>
            <Routes>
                <Route path='/' element={<MainLayoutPage />} >
                    {/* PUBLIC ROUTES */}
                    <Route index element={subdomainSlug ? <StorePage slugOverride={subdomainSlug} /> : <Products />} />
                    <Route path='/products' element={<Products />} />
                    <Route path={'/single-product/:id'} element={<ProductDetailPage />} />
                    <Route path={'/profile'} element={<Profile />} />
                    <Route path={'/forgot-password'} element={<ForgotPassword />} />
                    <Route path={'/reset-password/:token'} element={<ResetPassword />} />
                    <Route path='/store/:slug' element={<StorePage />} />
                    <Route path='/marketplace' element={<StoresListing />} />
                    <Route path='/marketplace/trusted' element={
                        <ProtectedRoute>
                            <TrustedStoresPage />
                        </ProtectedRoute>
                    } />
                    {/* Legacy redirects */}
                    <Route path='/stores' element={<Navigate to='/marketplace' replace />} />
                    <Route path='/stores/trusted' element={<Navigate to='/marketplace/trusted' replace />} />

                    <Route path='/become-seller' element={<BecomeSeller />} />

                    {/* INFO & LEGAL PAGES */}
                    <Route path='/terms' element={<TermsOfService />} />
                    <Route path='/privacy' element={<PrivacyPolicy />} />
                    <Route path='/about' element={<AboutPage />} />
                    <Route path='/contact' element={<ContactPage />} />
                    <Route path='/faq' element={<FAQPage />} />
                    <Route path='/docs' element={<DocsRouteGate />} />
                    <Route path='/track-order' element={<TrackOrderPage />} />

                    {/* Checkout - accessible to everyone (guest & logged in) */}
                    <Route path={'/checkout'} element={<Checkout />} />

                    <Route path={'/unauthorized'} element={<Unauthorized onBack={() => { navigate(-1) }} />} />
                </Route>
                <Route path='/login' element={<Login />} />
                <Route path='/signup' element={<SignUp />} />
                <Route path='/seller-signup' element={<Navigate to='/become-seller' replace />} />
                <Route path='/auth/google/success' element={<GoogleAuthSuccess />} />
                <Route path='/orders/confirm/:token' element={<OrderConfirmationPage />} />
                <Route path='/ai-chat' element={<AIChatPage />} />

                <Route path={'/success'} element={<Success />} />

                {/* USER DASHBOARD */}
                <Route path={'/user-dashboard'} element={
                    <ProtectedRoute>
                        <UserDashboard />
                    </ProtectedRoute>}>
                    <Route path='/user-dashboard/account-overview' element={<ProtectedRoute><AccountOverview /></ProtectedRoute>} />
                    <Route path='/user-dashboard/profile' element={<ProtectedRoute><Profile /></ProtectedRoute>} />
                    <Route path='/user-dashboard/orders' element={<ProtectedRoute><UserOrdersManagement /></ProtectedRoute>} />
                    <Route path='/user-dashboard/whatsapp' element={<ProtectedRoute><UserWhatsAppSettings /></ProtectedRoute>} />
                    <Route path='/user-dashboard/wallet' element={<ProtectedRoute><Wallet /></ProtectedRoute>} />
                    <Route path='/user-dashboard/notifications' element={<ProtectedRoute><NotificationsPage /></ProtectedRoute>} />
                    <Route path='/user-dashboard/payment-methods' element={<ProtectedRoute><PaymentMethods /></ProtectedRoute>} />
                    <Route path='/user-dashboard/order/:id' element={<ProtectedRoute><OrderDetail /></ProtectedRoute>} />
                    <Route path='/user-dashboard/user-management' element={<ProtectedRoute><UserManagement /></ProtectedRoute>} />
                    <Route path='/user-dashboard/order/detail/:id' element={<ProtectedRoute><UserOrderDetail /></ProtectedRoute>} />
                </Route>

                {/* ADMIN DASHBOARD */}
                <Route path={'/admin-dashboard'} element={
                    <ProtectedRoute role={'admin'}>
                        <AdminDashboard />
                    </ProtectedRoute>}>
                    <Route path='/admin-dashboard/store-overview' element={<ProtectedRoute role={'admin'}><StoreOverview /></ProtectedRoute>} />
                    <Route path='/admin-dashboard/product-management' element={<ProtectedRoute role={'admin'}><ProductManagement /></ProtectedRoute>} />
                    <Route path='/admin-dashboard/order-management' element={<ProtectedRoute role={'admin'}><OrderManagement /></ProtectedRoute>} />
                    <Route path='/admin-dashboard/order/:id' element={<ProtectedRoute role={['admin', 'seller']}><OrderDetail /></ProtectedRoute>} />
                    <Route path='/admin-dashboard/user-management' element={<ProtectedRoute role={'admin'}><UserManagement /></ProtectedRoute>} />
                    <Route path='/admin-dashboard/tax-configuration' element={<ProtectedRoute role={'admin'}><TaxConfiguration /></ProtectedRoute>} />
                    <Route path='/admin-dashboard/store-verifications' element={<ProtectedRoute role={'admin'}><StoreVerifications /></ProtectedRoute>} />
                    <Route path='/admin-dashboard/analytics' element={<ProtectedRoute role={'admin'}><AdminAnalytics /></ProtectedRoute>} />
                    <Route path='/admin-dashboard/payments' element={<ProtectedRoute role={'admin'}><AdminPayments /></ProtectedRoute>} />
                    <Route path='/admin-dashboard/notifications' element={<ProtectedRoute role={'admin'}><NotificationsPage /></ProtectedRoute>} />
                    <Route path='/admin-dashboard/notification-settings' element={<ProtectedRoute role={'admin'}><NotificationSettings /></ProtectedRoute>} />
                    <Route path='/admin-dashboard/subdomains' element={<ProtectedRoute role={'admin'}><AdminSubdomainManagement /></ProtectedRoute>} />
                    <Route path='/admin-dashboard/complaints' element={<ProtectedRoute role={'admin'}><ComplaintsManagement /></ProtectedRoute>} />
                    <Route path='/admin-dashboard/whatsapp-verification' element={<ProtectedRoute role={'admin'}><WhatsAppVerificationPanel /></ProtectedRoute>} />
                    <Route path='/admin-dashboard/broadcast' element={<ProtectedRoute role={'admin'}><AdminBroadcastPanel /></ProtectedRoute>} />
                    <Route path='/admin-dashboard/ads' element={<ProtectedRoute role={'admin'}><AdminAdsPanel /></ProtectedRoute>} />
                    <Route path='/admin-dashboard/ai-prompts' element={<ProtectedRoute role={'admin'}><AdminAIPromptsPanel /></ProtectedRoute>} />
                </Route>

                {/* SELLER DASHBOARD */}
                <Route path={'/seller-dashboard'} element={
                    <ProtectedRoute role={'seller'}>
                        <SellerDashboard />
                    </ProtectedRoute>}>
                    <Route index element={<ProtectedRoute role={'seller'}><SellerHome /></ProtectedRoute>} />
                    <Route path='/seller-dashboard/seller-home' element={<ProtectedRoute role={'seller'}><SellerHome /></ProtectedRoute>} />
                    <Route path='/seller-dashboard/store-overview' element={<ProtectedRoute role={'seller'}><StoreOverview /></ProtectedRoute>} />
                    <Route path='/seller-dashboard/product-management' element={<ProtectedRoute role={'seller'}><ProductManagement /></ProtectedRoute>} />
                    <Route path='/seller-dashboard/order-management' element={<ProtectedRoute role={'seller'}><OrderManagement /></ProtectedRoute>} />
                    <Route path='/seller-dashboard/order/:id' element={<OrderDetail />} />
                    <Route path='/seller-dashboard/store-settings' element={<ProtectedRoute role={'seller'}><StoreSettings /></ProtectedRoute>} />
                    <Route path='/seller-dashboard/shipping-configuration' element={<ProtectedRoute role={'seller'}><ShippingConfiguration /></ProtectedRoute>} />
                    <Route path='/seller-dashboard/analytics' element={<ProtectedRoute role={'seller'}><SellerAnalytics /></ProtectedRoute>} />
                    <Route path='/seller-dashboard/payments' element={<ProtectedRoute role={'seller'}><SellerPayments /></ProtectedRoute>} />
                    <Route path='/seller-dashboard/payment-methods' element={<ProtectedRoute role={'seller'}><PaymentMethods /></ProtectedRoute>} />
                    <Route path='/seller-dashboard/notifications' element={<ProtectedRoute role={'seller'}><NotificationsPage /></ProtectedRoute>} />
                    <Route path='/seller-dashboard/notification-settings' element={<ProtectedRoute role={'seller'}><NotificationSettings /></ProtectedRoute>} />
                    <Route path='/seller-dashboard/subdomain' element={<ProtectedRoute role={'seller'}><SellerSubdomainManagement /></ProtectedRoute>} />
                    <Route path='/seller-dashboard/subscription' element={<ProtectedRoute role={'seller'}><SellerSubscription /></ProtectedRoute>} />
                    <Route path='/seller-dashboard/ads' element={<ProtectedRoute role={'seller'}><SellerAds /></ProtectedRoute>} />
                    <Route path='/seller-dashboard/coupons' element={<ProtectedRoute role={'seller'}><CouponManagement /></ProtectedRoute>} />
                    <Route path='/seller-dashboard/whatsapp-settings' element={<ProtectedRoute role={'seller'}><SellerWhatsAppSettings /></ProtectedRoute>} />
                    <Route path='/seller-dashboard/profile' element={<ProtectedRoute role={'seller'}><SellerProfile /></ProtectedRoute>} />
                </Route>
            </Routes>
        </Suspense>
    )
}

export default AppRoutes
