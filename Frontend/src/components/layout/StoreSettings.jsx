import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Store, Upload, X, Eye, Trash2, Loader2, ExternalLink } from 'lucide-react';
import axios from 'axios';
import { toast } from 'react-toastify';
import { uploadImageToCloudinary } from '../../utils/uploadToCloudinary';
import { Link } from 'react-router-dom';
import { useCurrency } from '../../contexts/CurrencyContext';

const StoreSettings = () => {
    const { formatPrice, currency, exchangeRates, getCurrencySymbol } = useCurrency();
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [hasStore, setHasStore] = useState(false);
    const [uploadingLogo, setUploadingLogo] = useState(false);
    const [uploadingBanner, setUploadingBanner] = useState(false);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

    // Format large numbers with K, M, B suffixes
    const formatCompactPrice = (amount) => {
        const usdAmount = Number(amount) || 0;
        // Convert USD to selected currency
        const rate = exchangeRates[currency] || 1;
        const convertedAmount = usdAmount * rate;
        const symbol = getCurrencySymbol();
        
        if (convertedAmount >= 1000000000) {
            return `${symbol}${(convertedAmount / 1000000000).toFixed(1)}B`;
        }
        if (convertedAmount >= 1000000) {
            return `${symbol}${(convertedAmount / 1000000).toFixed(1)}M`;
        }
        if (convertedAmount >= 10000) {
            return `${symbol}${(convertedAmount / 1000).toFixed(1)}K`;
        }
        return formatPrice(usdAmount);
    };

    const [storeData, setStoreData] = useState({
        storeName: '',
        description: '',
        logo: '',
        banner: '',
        storeSlug: '',
        address: {
            street: '',
            city: '',
            state: '',
            country: '',
            postalCode: ''
        },
        socialLinks: {
            website: '',
            facebook: '',
            instagram: '',
            twitter: '',
            youtube: '',
            tiktok: ''
        }
    });

    const [analytics, setAnalytics] = useState({
        views: 0,
        productCount: 0,
        totalSales: 0,
        trustCount: 0
    });

    const [verification, setVerification] = useState({
        isVerified: false,
        status: 'none',
        appliedAt: null,
        rejectionReason: ''
    });

    const [showVerificationModal, setShowVerificationModal] = useState(false);
    const [applicationMessage, setApplicationMessage] = useState('');
    const [contactEmail, setContactEmail] = useState('');
    const [contactPhone, setContactPhone] = useState('');
    const [applyingVerification, setApplyingVerification] = useState(false);

    useEffect(() => {
        fetchStoreData();
        fetchAnalytics();
        fetchVerificationStatus();
    }, []);

    const fetchStoreData = async () => {
        try {
            setLoading(true);
            const token = localStorage.getItem('jwtToken');
            const res = await axios.get(`${import.meta.env.VITE_API_URL}api/stores/my-store`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            
            const defaultSocialLinks = {
                website: '',
                facebook: '',
                instagram: '',
                twitter: '',
                youtube: '',
                tiktok: ''
            };

            console.log('Fetched store data:', res.data.store);
            console.log('Social links from backend:', res.data.store.socialLinks);

            const defaultAddress = {
                street: '',
                city: '',
                state: '',
                country: '',
                postalCode: ''
            };

            setStoreData({
                storeName: res.data.store.storeName,
                description: res.data.store.description,
                logo: res.data.store.logo,
                banner: res.data.store.banner,
                storeSlug: res.data.store.storeSlug,
                address: {
                    ...defaultAddress,
                    ...(res.data.store.address || {})
                },
                socialLinks: {
                    ...defaultSocialLinks,
                    ...(res.data.store.socialLinks || {})
                }
            });
            setHasStore(true);
        } catch (error) {
            if (error.response?.status === 404) {
                setHasStore(false);
            } else {
                console.error('Error fetching store:', error);
            }
        } finally {
            setLoading(false);
        }
    };

    const fetchAnalytics = async () => {
        try {
            const token = localStorage.getItem('jwtToken');
            const res = await axios.get(`${import.meta.env.VITE_API_URL}api/stores/analytics`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            setAnalytics(res.data.analytics);
        } catch (error) {
            console.error('Error fetching analytics:', error);
        }
    };

    const fetchVerificationStatus = async () => {
        try {
            const token = localStorage.getItem('jwtToken');
            const res = await axios.get(`${import.meta.env.VITE_API_URL}api/stores/verification/status`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            setVerification(res.data.verification);
        } catch (error) {
            console.error('Error fetching verification status:', error);
        }
    };

    const handleApplyVerification = async () => {
        if (!applicationMessage.trim()) {
            toast.error('Please provide a message explaining why your store should be verified');
            return;
        }

        if (!contactEmail.trim()) {
            toast.error('Please provide your contact email');
            return;
        }

        if (!contactPhone.trim()) {
            toast.error('Please provide your contact phone number');
            return;
        }

        // Basic email validation
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(contactEmail)) {
            toast.error('Please provide a valid email address');
            return;
        }

        try {
            setApplyingVerification(true);
            const token = localStorage.getItem('jwtToken');
            await axios.post(
                `${import.meta.env.VITE_API_URL}api/stores/verification/apply`,
                { 
                    applicationMessage,
                    contactEmail: contactEmail.trim(),
                    contactPhone: contactPhone.trim()
                },
                { headers: { Authorization: `Bearer ${token}` } }
            );
            toast.success('Verification application submitted successfully!');
            setShowVerificationModal(false);
            setApplicationMessage('');
            setContactEmail('');
            setContactPhone('');
            fetchVerificationStatus();
        } catch (error) {
            toast.error(error.response?.data?.msg || 'Failed to submit verification application');
        } finally {
            setApplyingVerification(false);
        }
    };

    const handleInputChange = (e) => {
        const { name, value } = e.target;
        setStoreData(prev => ({ ...prev, [name]: value }));
    };

    const handleSocialLinkChange = (platform, value) => {
        console.log(`Updating ${platform}:`, value);
        setStoreData(prev => {
            const updated = {
                ...prev,
                socialLinks: {
                    ...prev.socialLinks,
                    [platform]: value
                }
            };
            console.log('Updated storeData:', updated);
            return updated;
        });
    };

    const handleAddressChange = (field, value) => {
        setStoreData(prev => ({
            ...prev,
            address: {
                ...prev.address,
                [field]: value
            }
        }));
    };

    const handleLogoUpload = async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        if (file.size > 5 * 1024 * 1024) {
            toast.error('Logo file size must be less than 5MB');
            return;
        }

        try {
            setUploadingLogo(true);
            const imageUrl = await uploadImageToCloudinary(file);
            setStoreData(prev => ({ ...prev, logo: imageUrl }));
            toast.success('Logo uploaded successfully');
        } catch (error) {
            toast.error('Failed to upload logo');
        } finally {
            setUploadingLogo(false);
        }
    };

    const handleBannerUpload = async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        if (file.size > 5 * 1024 * 1024) {
            toast.error('Banner file size must be less than 5MB');
            return;
        }

        try {
            setUploadingBanner(true);
            const imageUrl = await uploadImageToCloudinary(file);
            setStoreData(prev => ({ ...prev, banner: imageUrl }));
            toast.success('Banner uploaded successfully');
        } catch (error) {
            toast.error('Failed to upload banner');
        } finally {
            setUploadingBanner(false);
        }
    };

    const handleSave = async () => {
        if (!storeData.storeName || storeData.storeName.trim().length < 3) {
            toast.error('Store name must be at least 3 characters');
            return;
        }

        try {
            setSaving(true);
            const token = localStorage.getItem('jwtToken');
            const endpoint = hasStore ? 'update' : 'create';
            
            console.log('Saving store data:', storeData);
            
            const res = await axios[hasStore ? 'put' : 'post'](
                `${import.meta.env.VITE_API_URL}api/stores/${endpoint}`,
                storeData,
                { headers: { Authorization: `Bearer ${token}` } }
            );

            console.log('Save response:', res.data);

            toast.success(res.data.msg);
            setHasStore(true);
            if (!hasStore) {
                setStoreData(prev => ({ ...prev, storeSlug: res.data.store.storeSlug }));
            }
            fetchAnalytics();
        } catch (error) {
            console.error('Save error:', error);
            toast.error(error.response?.data?.msg || 'Failed to save store');
        } finally {
            setSaving(false);
        }
    };

    const handleDelete = async () => {
        try {
            const token = localStorage.getItem('jwtToken');
            await axios.delete(`${import.meta.env.VITE_API_URL}api/stores/delete`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            
            toast.success('Store deleted successfully');
            setHasStore(false);
            setStoreData({
                storeName: '',
                description: '',
                logo: '',
                banner: '',
                storeSlug: ''
            });
            setShowDeleteConfirm(false);
        } catch (error) {
            toast.error(error.response?.data?.msg || 'Failed to delete store');
        }
    };

    if (loading) {
        return (
            <div className="flex justify-center items-center h-64">
                <Loader2 className="animate-spin" size={40} />
            </div>
        );
    }

    return (
        <div className="p-4 md:p-6 max-w-4xl mx-auto">
            <div className="mb-6">
                <h1 className="text-2xl md:text-3xl font-bold text-gray-800 flex items-center gap-2">
                    <Store size={28} className="md:w-8 md:h-8" />
                    Store Settings
                </h1>
                <p className="text-sm md:text-base text-gray-600 mt-2">
                    {hasStore ? 'Manage your store configuration' : 'Create your store to establish your brand'}
                </p>
            </div>

            {/* Analytics Cards */}
            {hasStore && (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
                    <div className="bg-white p-6 rounded-2xl shadow-lg border border-gray-100 hover:shadow-xl transition-shadow">
                        <p className="text-gray-600 text-sm font-medium mb-2">Total Views</p>
                        <p className="text-3xl font-bold text-blue-600">{analytics.views}</p>
                    </div>
                    <div className="bg-white p-6 rounded-2xl shadow-lg border border-gray-100 hover:shadow-xl transition-shadow">
                        <p className="text-gray-600 text-sm font-medium mb-2">Products</p>
                        <p className="text-3xl font-bold text-green-600">{analytics.productCount}</p>
                    </div>
                    <div className="bg-white p-6 rounded-2xl shadow-lg border border-gray-100 hover:shadow-xl transition-shadow">
                        <p className="text-gray-600 text-sm font-medium mb-2">Trusters</p>
                        <p className="text-3xl font-bold text-pink-600">{analytics.trustCount || 0}</p>
                    </div>
                    <div className="bg-white p-6 rounded-2xl shadow-lg border border-gray-100 hover:shadow-xl transition-shadow">
                        <p className="text-gray-600 text-sm font-medium mb-2">Total Sales</p>
                        <p className="text-3xl font-bold text-sky-600">{formatCompactPrice(analytics.totalSales || 0)}</p>
                    </div>
                </div>
            )}

            {/* Verification Status Card */}
            {hasStore && (
                <div className="bg-white/80 backdrop-blur-sm rounded-2xl shadow-lg border border-white/60 p-6 md:p-8 mb-6">
                    <div className="flex items-center justify-between mb-4">
                        <h2 className="text-xl font-bold text-gray-800 flex items-center gap-2">
                            {verification.isVerified ? (
                                <>
                                    <svg className="w-6 h-6 text-blue-500" fill="currentColor" viewBox="0 0 24 24">
                                        <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                                    </svg>
                                    Verified Store
                                </>
                            ) : (
                                <>
                                    <svg className="w-6 h-6 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                                    </svg>
                                    Store Verification
                                </>
                            )}
                        </h2>
                        {!verification.isVerified && verification.status === 'none' && (
                            <button
                                onClick={() => setShowVerificationModal(true)}
                                className="px-4 py-2 bg-linear-to-r from-indigo-600 to-sky-500 hover:from-indigo-700 hover:to-sky-600 text-white rounded-lg transition-all text-sm font-medium"
                            >
                                Apply for Verification
                            </button>
                        )}
                    </div>

                    {verification.isVerified && (
                        <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                            <p className="text-green-800 font-medium">✓ Your store is verified!</p>
                            <p className="text-green-600 text-sm mt-1">Your store has been verified and will display a verification badge.</p>
                        </div>
                    )}

                    {verification.status === 'pending' && (
                        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                            <p className="text-yellow-800 font-medium">⏳ Verification Pending</p>
                            <p className="text-yellow-600 text-sm mt-1">Your verification application is under review. We'll notify you once it's processed.</p>
                            <p className="text-yellow-600 text-xs mt-2">Applied on: {new Date(verification.appliedAt).toLocaleDateString()}</p>
                        </div>
                    )}

                    {verification.status === 'rejected' && (
                        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                            <p className="text-red-800 font-medium">✗ Verification Rejected</p>
                            <p className="text-red-600 text-sm mt-1">Reason: {verification.rejectionReason}</p>
                            <button
                                onClick={() => setShowVerificationModal(true)}
                                className="mt-3 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-all text-sm font-medium"
                            >
                                Reapply for Verification
                            </button>
                        </div>
                    )}

                    {verification.status === 'none' && (
                        <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
                            <p className="text-gray-700 text-sm">Get your store verified to build trust with customers and stand out from the competition.</p>
                        </div>
                    )}
                </div>
            )}

            {/* Store Form */}
            <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-6 md:p-8">
                <div className="space-y-4 md:space-y-6">
                    {/* Store Name */}
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                            Store Name *
                        </label>
                        <input
                            type="text"
                            name="storeName"
                            value={storeData.storeName}
                            onChange={handleInputChange}
                            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500"
                            placeholder="Enter your store name"
                            maxLength={50}
                        />
                        <p className="text-xs text-gray-500 mt-1">
                            {storeData.storeName.length}/50 characters
                        </p>
                    </div>

                    {/* Store URL Preview */}
                    {storeData.storeSlug && (
                        <div className="bg-green-50 p-3 rounded-lg">
                            <p className="text-sm text-gray-700">
                                <span className="font-medium">Store URL:</span>{' '}
                                <span className="text-green-600">
                                    {window.location.origin}/store/{storeData.storeSlug}
                                </span>
                            </p>
                        </div>
                    )}

                    {/* Description */}
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                            Description
                        </label>
                        <textarea
                            name="description"
                            value={storeData.description}
                            onChange={handleInputChange}
                            rows={4}
                            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500"
                            placeholder="Tell customers about your store..."
                            maxLength={500}
                        />
                        <p className="text-xs text-gray-500 mt-1">
                            {storeData.description.length}/500 characters
                        </p>
                    </div>

                    {/* Store Address Section */}
                    <div className="border-t pt-6">
                        <h3 className="text-lg font-semibold text-gray-800 mb-4">Store Address (Optional)</h3>
                        <p className="text-sm text-gray-600 mb-4">Add your store's physical address to display on your store page</p>
                        
                        <div className="space-y-4">
                            {/* Street Address */}
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-2">
                                    Street Address
                                </label>
                                <input
                                    type="text"
                                    value={storeData.address.street}
                                    onChange={(e) => handleAddressChange('street', e.target.value)}
                                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500"
                                    placeholder="123 Main Street"
                                />
                            </div>

                            {/* City and State */}
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-sm font-medium text-gray-700 mb-2">
                                        City
                                    </label>
                                    <input
                                        type="text"
                                        value={storeData.address.city}
                                        onChange={(e) => handleAddressChange('city', e.target.value)}
                                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500"
                                        placeholder="New York"
                                    />
                                </div>

                                <div>
                                    <label className="block text-sm font-medium text-gray-700 mb-2">
                                        State/Province
                                    </label>
                                    <input
                                        type="text"
                                        value={storeData.address.state}
                                        onChange={(e) => handleAddressChange('state', e.target.value)}
                                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500"
                                        placeholder="NY"
                                    />
                                </div>
                            </div>

                            {/* Country and Postal Code */}
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-sm font-medium text-gray-700 mb-2">
                                        Country
                                    </label>
                                    <input
                                        type="text"
                                        value={storeData.address.country}
                                        onChange={(e) => handleAddressChange('country', e.target.value)}
                                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500"
                                        placeholder="United States"
                                    />
                                </div>

                                <div>
                                    <label className="block text-sm font-medium text-gray-700 mb-2">
                                        Postal Code
                                    </label>
                                    <input
                                        type="text"
                                        value={storeData.address.postalCode}
                                        onChange={(e) => handleAddressChange('postalCode', e.target.value)}
                                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500"
                                        placeholder="10001"
                                    />
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Logo Upload */}
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                            Store Logo
                        </label>
                        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
                            {storeData.logo && (
                                <img
                                    src={storeData.logo}
                                    alt="Store logo"
                                    className="w-24 h-24 rounded-2xl object-cover border-4 border-white shadow-lg ring-2 ring-gray-100"
                                />
                            )}
                            <div className="flex items-center gap-2">
                                <label className="cursor-pointer">
                                    <div className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition flex items-center gap-2 text-sm">
                                        {uploadingLogo ? (
                                            <>
                                                <Loader2 className="animate-spin" size={16} />
                                                <span className="hidden sm:inline">Uploading...</span>
                                            </>
                                        ) : (
                                            <>
                                                <Upload size={16} />
                                                <span className="hidden sm:inline">Upload Logo</span>
                                                <span className="sm:hidden">Upload</span>
                                            </>
                                        )}
                                    </div>
                                    <input
                                        type="file"
                                        accept="image/*"
                                        onChange={handleLogoUpload}
                                        className="hidden"
                                        disabled={uploadingLogo}
                                    />
                                </label>
                                {storeData.logo && (
                                    <button
                                        onClick={() => setStoreData(prev => ({ ...prev, logo: '' }))}
                                        className="p-2 text-red-600 hover:bg-red-50 rounded-lg"
                                    >
                                        <X size={20} />
                                    </button>
                                )}
                            </div>
                        </div>
                        <p className="text-xs text-gray-500 mt-1">Max 5MB, square image recommended</p>
                    </div>

                    {/* Banner Upload */}
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                            Store Banner
                        </label>
                        {storeData.banner && (
                            <div className="mb-3 relative">
                                <img
                                    src={storeData.banner}
                                    alt="Store banner"
                                    className="w-full h-40 object-cover rounded-2xl border-4 border-white shadow-lg ring-2 ring-gray-100"
                                />
                                <button
                                    onClick={() => setStoreData(prev => ({ ...prev, banner: '' }))}
                                    className="absolute top-2 right-2 p-2 bg-red-600 text-white rounded-lg hover:bg-red-700"
                                >
                                    <X size={20} />
                                </button>
                            </div>
                        )}
                        <label className="cursor-pointer">
                            <div className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition flex items-center gap-2 w-fit text-sm">
                                {uploadingBanner ? (
                                    <>
                                        <Loader2 className="animate-spin" size={16} />
                                        <span className="hidden sm:inline">Uploading...</span>
                                    </>
                                ) : (
                                    <>
                                        <Upload size={16} />
                                        <span className="hidden sm:inline">Upload Banner</span>
                                        <span className="sm:hidden">Upload</span>
                                    </>
                                )}
                            </div>
                            <input
                                type="file"
                                accept="image/*"
                                onChange={handleBannerUpload}
                                className="hidden"
                                disabled={uploadingBanner}
                            />
                        </label>
                        <p className="text-xs text-gray-500 mt-1">Max 5MB, wide image recommended (1200x400)</p>
                    </div>

                    {/* Social Links Section */}
                    <div className="border-t pt-6">
                        <h3 className="text-lg font-semibold text-gray-800 mb-4 flex items-center gap-2">
                            <ExternalLink size={20} />
                            Social Links & Website
                        </h3>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-2 flex items-center gap-2">
                                    <svg className="w-4 h-4 text-gray-600" fill="currentColor" viewBox="0 0 24 24">
                                        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/>
                                    </svg>
                                    Website
                                </label>
                                <input
                                    type="url"
                                    value={storeData.socialLinks.website}
                                    onChange={(e) => handleSocialLinkChange('website', e.target.value)}
                                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500"
                                    placeholder="https://yourwebsite.com"
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-2 flex items-center gap-2">
                                    <svg className="w-4 h-4 text-blue-600" fill="currentColor" viewBox="0 0 24 24">
                                        <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
                                    </svg>
                                    Facebook
                                </label>
                                <input
                                    type="url"
                                    value={storeData.socialLinks.facebook}
                                    onChange={(e) => handleSocialLinkChange('facebook', e.target.value)}
                                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500"
                                    placeholder="https://facebook.com/yourpage"
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-2 flex items-center gap-2">
                                    <svg className="w-4 h-4 text-pink-600" fill="currentColor" viewBox="0 0 24 24">
                                        <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/>
                                    </svg>
                                    Instagram
                                </label>
                                <input
                                    type="url"
                                    value={storeData.socialLinks.instagram}
                                    onChange={(e) => handleSocialLinkChange('instagram', e.target.value)}
                                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500"
                                    placeholder="https://instagram.com/yourprofile"
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-2 flex items-center gap-2">
                                    <svg className="w-4 h-4 text-black" fill="currentColor" viewBox="0 0 24 24">
                                        <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
                                    </svg>
                                    Twitter/X
                                </label>
                                <input
                                    type="url"
                                    value={storeData.socialLinks.twitter}
                                    onChange={(e) => handleSocialLinkChange('twitter', e.target.value)}
                                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500"
                                    placeholder="https://twitter.com/yourhandle"
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-2 flex items-center gap-2">
                                    <svg className="w-4 h-4 text-red-600" fill="currentColor" viewBox="0 0 24 24">
                                        <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
                                    </svg>
                                    YouTube
                                </label>
                                <input
                                    type="url"
                                    value={storeData.socialLinks.youtube}
                                    onChange={(e) => handleSocialLinkChange('youtube', e.target.value)}
                                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500"
                                    placeholder="https://youtube.com/@yourchannel"
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-2 flex items-center gap-2">
                                    <svg className="w-4 h-4 text-black" fill="currentColor" viewBox="0 0 24 24">
                                        <path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.64 2.93 2.93 0 0 1 .88.13V9.4a6.84 6.84 0 0 0-1-.05A6.33 6.33 0 0 0 5 20.1a6.34 6.34 0 0 0 10.86-4.43v-7a8.16 8.16 0 0 0 4.77 1.52v-3.4a4.85 4.85 0 0 1-1-.1z"/>
                                    </svg>
                                    TikTok
                                </label>
                                <input
                                    type="url"
                                    value={storeData.socialLinks.tiktok}
                                    onChange={(e) => handleSocialLinkChange('tiktok', e.target.value)}
                                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500"
                                    placeholder="https://tiktok.com/@yourusername"
                                />
                            </div>
                        </div>
                    </div>

                    {/* Action Buttons */}
                    <div className="flex flex-col sm:flex-row gap-3 sm:gap-4 pt-4 border-t">
                        <motion.button
                            whileHover={{ scale: 1.02 }}
                            whileTap={{ scale: 0.98 }}
                            onClick={handleSave}
                            disabled={saving || uploadingLogo || uploadingBanner}
                            className="flex-1 px-4 sm:px-6 py-3 bg-green-600 text-white rounded-xl hover:bg-green-700 shadow-lg hover:shadow-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 text-sm sm:text-base font-medium"
                        >
                            {saving ? (
                                <>
                                    <Loader2 className="animate-spin" size={20} />
                                    Saving...
                                </>
                            ) : (
                                <>{hasStore ? 'Update Store' : 'Create Store'}</>
                            )}
                        </motion.button>

                        {hasStore && storeData.storeSlug && (
                            <Link
                                to={`/store/${storeData.storeSlug}`}
                                target="_blank"
                                className="px-4 sm:px-6 py-3 bg-linear-to-r from-indigo-600 to-sky-500 hover:from-indigo-700 hover:to-sky-600 text-white rounded-xl shadow-lg hover:shadow-xl transition-all flex items-center justify-center gap-2 text-sm sm:text-base font-medium"
                            >
                                <Eye size={20} />
                                <span className="hidden sm:inline">Preview Store</span>
                                <span className="sm:hidden">Preview</span>
                            </Link>
                        )}

                        {hasStore && (
                            <button
                                onClick={() => setShowDeleteConfirm(true)}
                                className="px-4 sm:px-6 py-3 bg-red-600 text-white rounded-xl hover:bg-red-700 shadow-lg hover:shadow-xl transition-all flex items-center justify-center gap-2 text-sm sm:text-base font-medium"
                            >
                                <Trash2 size={20} />
                                <span className="hidden sm:inline">Delete</span>
                                <span className="sm:hidden">Delete</span>
                            </button>
                        )}
                    </div>
                </div>
            </div>

            {/* Delete Confirmation Modal */}
            {showDeleteConfirm && (
                <div className="fixed inset-0 bg-black/20 backdrop-blur-sm flex items-center justify-center z-50">
                    <motion.div
                        initial={{ scale: 0.9, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        className="bg-white rounded-lg p-6 max-w-md w-full mx-4"
                    >
                        <h3 className="text-xl font-bold text-gray-800 mb-4">Delete Store?</h3>
                        <p className="text-gray-600 mb-6">
                            Are you sure you want to delete your store? This action cannot be undone.
                            Your products will remain but won't be associated with a store.
                        </p>
                        <div className="flex gap-4">
                            <button
                                onClick={() => setShowDeleteConfirm(false)}
                                className="flex-1 px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleDelete}
                                className="flex-1 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700"
                            >
                                Delete Store
                            </button>
                        </div>
                    </motion.div>
                </div>
            )}

            {/* Verification Application Modal */}
            {showVerificationModal && (
                <div className="fixed inset-0 bg-black/20 backdrop-blur-sm flex items-center justify-center z-50 p-4">
                    <motion.div
                        initial={{ scale: 0.9, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        className="bg-white rounded-lg p-6 max-w-md w-full"
                    >
                        <h3 className="text-xl font-bold text-gray-800 mb-4 flex items-center gap-2">
                            <svg className="w-6 h-6 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                            </svg>
                            Apply for Store Verification
                        </h3>
                        <p className="text-gray-600 text-sm mb-4">
                            Tell us why your store should be verified. Verified stores get a badge that builds trust with customers.
                        </p>
                        
                        {/* Contact Email */}
                        <div className="mb-4">
                            <label className="block text-sm font-medium text-gray-700 mb-2">
                                Contact Email <span className="text-red-500">*</span>
                            </label>
                            <input
                                type="email"
                                value={contactEmail}
                                onChange={(e) => setContactEmail(e.target.value)}
                                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                                placeholder="your@email.com"
                                required
                            />
                        </div>

                        {/* Contact Phone */}
                        <div className="mb-4">
                            <label className="block text-sm font-medium text-gray-700 mb-2">
                                Contact Phone <span className="text-red-500">*</span>
                            </label>
                            <input
                                type="tel"
                                value={contactPhone}
                                onChange={(e) => setContactPhone(e.target.value)}
                                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                                placeholder="+1 234 567 8900"
                                required
                            />
                        </div>

                        {/* Application Message */}
                        <div className="mb-4">
                            <label className="block text-sm font-medium text-gray-700 mb-2">
                                Application Message <span className="text-red-500">*</span>
                            </label>
                            <textarea
                                value={applicationMessage}
                                onChange={(e) => setApplicationMessage(e.target.value)}
                                rows={4}
                                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                                placeholder="Explain why your store should be verified (e.g., established business, quality products, good customer service, etc.)"
                                maxLength={500}
                                required
                            />
                            <p className="text-xs text-gray-500 mt-1">
                                {applicationMessage.length}/500 characters
                            </p>
                        </div>
                        <div className="flex gap-4">
                            <button
                                onClick={() => {
                                    setShowVerificationModal(false);
                                    setApplicationMessage('');
                                    setContactEmail('');
                                    setContactPhone('');
                                }}
                                className="flex-1 px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
                                disabled={applyingVerification}
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleApplyVerification}
                                disabled={applyingVerification || !applicationMessage.trim() || !contactEmail.trim() || !contactPhone.trim()}
                                className="flex-1 px-4 py-2 bg-linear-to-r from-indigo-600 to-sky-500 hover:from-indigo-700 hover:to-sky-600 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg flex items-center justify-center gap-2 transition-colors"
                            >
                                {applyingVerification ? (
                                    <>
                                        <Loader2 className="animate-spin" size={16} />
                                        Submitting...
                                    </>
                                ) : (
                                    'Submit Application'
                                )}
                            </button>
                        </div>
                    </motion.div>
                </div>
            )}
        </div>
    );
};

export default StoreSettings;
