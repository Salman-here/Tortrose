import React from 'react'
import { BrowserRouter, Route, Routes, useNavigate } from 'react-router-dom'
import Login from '../components/auth/Login'
import SignUp from '../components/auth/SignUp'
import MainLayoutPage from '../pages/MainLayoutPage'
import Products from '../components/Products'
import ProductDetailPage from '../pages/ProductDetailPage'
import Profile from '../components/layout/Profile'
import ForgotPassword from '../components/auth/ForgotPassword'
import ResetPassword from '../components/auth/ResetPassword'
import Checkout from '../components/layout/Checkout'
import AdminDashboard from '../components/layout/AdminDashboard'
import SellerDashboard from '../components/layout/SellerDashboard'
import ProtectedRoute from '../components/common/ProtectedRoute'
import Unauthorized from '../components/layout/Unauthorized'
import OrderManagement from '../components/layout/orders'
import StoreOverview from '../components/layout/StoreOverview'
import ProductManagement from '../components/layout/ProductManagement'
import OrderDetail from '../components/layout/OrderDetail'
import UserManagement from '../components/layout/UserManagement'
import UserDashboard from '../components/layout/UserDashboard'
import TaxConfiguration from '../components/layout/TaxConfiguration'
import ShippingConfiguration from '../components/layout/ShippingConfiguration'
import AccountOverview from '../components/layout/AccountOverview'
import UserProfile from '../components/layout/Profile'
import UserOrdersManagement from '../components/layout/UserOrdersManagement'
import UserOrderDetail from '../components/layout/UserOrderDetail'
import Success from '../components/layout/Success'
import GoogleAuthSuccess from '../components/auth/GoogleAuthSuccess'
import StoreSettings from '../components/layout/StoreSettings'
import StorePage from '../pages/StorePage'
import StoresListing from '../pages/StoresListing'
import { ToastContainer } from 'react-toastify'

function AppRoutes() {
    const navigate = useNavigate()

    return (
        <>
            <Routes>
                <Route path='/' element={<MainLayoutPage />} >
                    {/* PUBLIC ROUTES */}
                    <Route index element={<Products />} />
                    <Route path={'/single-product/:id'} element={<ProductDetailPage />} />
                    <Route path={'/profile'} element={<Profile />} />
                    <Route path={'/forgot-password'} element={<ForgotPassword />} />
                    <Route path={'/reset-password/:token'} element={<ResetPassword />} />
                    <Route path='/store/:slug' element={<StorePage />} />
                    <Route path='/stores' element={<StoresListing />} />


                    {/* PROTECTED ROUTES - Checkout requires login */}
                    <Route path={'/checkout'} element={
                        <ProtectedRoute >
                            <Checkout />
                        </ProtectedRoute>} />




                    <Route path={'/unauthorized'} element={<Unauthorized onBack={() => { navigate(-1) }} />} />
                </Route>
                <Route path='/login' element={<Login />} />
                <Route path='/signup' element={<SignUp />} />
                <Route path='/auth/google/success' element={<GoogleAuthSuccess />} />

                <Route path={'/success'} element={
                    <ProtectedRoute >
                        <Success />
                    </ProtectedRoute>} />

                {/* USER DASHBOARD */}
                <Route path={'/user-dashboard'} element={
                    <ProtectedRoute>
                        <UserDashboard />
                    </ProtectedRoute>}>

                    <Route path='/user-dashboard/account-overview' element={
                        <ProtectedRoute>
                            <AccountOverview />
                        </ProtectedRoute>
                    } />
                    <Route path='/user-dashboard/profile' element={
                        <ProtectedRoute>
                            <UserProfile />
                        </ProtectedRoute>
                    } />
                    <Route path='/user-dashboard/orders' element={
                        <ProtectedRoute>
                            <UserOrdersManagement />
                        </ProtectedRoute>
                    } />
                    <Route path='/user-dashboard/order/:id' element={
                        <ProtectedRoute>
                            <OrderDetail />
                        </ProtectedRoute>
                    } />
                    <Route path='/user-dashboard/user-management' element={
                        <ProtectedRoute>
                            <UserManagement />
                        </ProtectedRoute>
                    } />
                    <Route path='/user-dashboard/order/detail/:id' element={
                        <ProtectedRoute>
                            <UserOrderDetail />
                        </ProtectedRoute>
                    } />
                </Route>



                {/* ADMIN DASHBOARD */}
                <Route path={'/admin-dashboard'} element={
                    <ProtectedRoute role={'admin'}>
                        <AdminDashboard />
                    </ProtectedRoute>}>

                    <Route path='/admin-dashboard/store-overview' element={
                        <ProtectedRoute role={'admin'}>
                            <StoreOverview />
                        </ProtectedRoute>
                    } />
                    <Route path='/admin-dashboard/product-management' element={
                        <ProtectedRoute role={'admin'}>
                            <ProductManagement />
                        </ProtectedRoute>
                    } />
                    <Route path='/admin-dashboard/order-management' element={
                        <ProtectedRoute role={'admin'}>
                            <OrderManagement />
                        </ProtectedRoute>
                    } />
                    <Route path='/admin-dashboard/order/:id' element={
                        <ProtectedRoute role={['admin', 'seller']}>
                            <OrderDetail />
                        </ProtectedRoute>
                    } />
                    <Route path='/admin-dashboard/user-management' element={
                        <ProtectedRoute role={'admin'}>
                            <UserManagement />
                        </ProtectedRoute>
                    } />
                    <Route path='/admin-dashboard/tax-configuration' element={
                        <ProtectedRoute role={'admin'}>
                            <TaxConfiguration />
                        </ProtectedRoute>
                    } />
                </Route>

                {/* SELLER DASHBOARD */}
                <Route path={'/seller-dashboard'} element={
                    <ProtectedRoute role={'seller'}>
                        <SellerDashboard />
                    </ProtectedRoute>}>

                    <Route path='/seller-dashboard/store-overview' element={
                        <ProtectedRoute role={'seller'}>
                            <StoreOverview />
                        </ProtectedRoute>
                    } />
                    <Route path='/seller-dashboard/product-management' element={
                        <ProtectedRoute role={'seller'}>
                            <ProductManagement />
                        </ProtectedRoute>
                    } />
                    <Route path='/seller-dashboard/order-management' element={
                        <ProtectedRoute role={'seller'}>
                            <OrderManagement />
                        </ProtectedRoute>
                    } />
                    <Route path='/seller-dashboard/order/:id' element={<OrderDetail />} />
                    <Route path='/seller-dashboard/store-settings' element={
                        <ProtectedRoute role={'seller'}>
                            <StoreSettings />
                        </ProtectedRoute>
                    } />
                    <Route path='/seller-dashboard/shipping-configuration' element={
                        <ProtectedRoute role={'seller'}>
                            <ShippingConfiguration />
                        </ProtectedRoute>
                    } />
                </Route>
            </Routes>
        </>
    )
}

export default AppRoutes

// Fuzzy search → helps users find products faster & smarter (handles typos).

// Fly-to-cart animation → makes adding to cart fun & delightful.

// Smart recommender → shows similar products to encourage more sales.

// Stripe Checkout → adds a real, working payment flow (in test mode).

// AI description generator → modern AI wow factor for your admin panel.