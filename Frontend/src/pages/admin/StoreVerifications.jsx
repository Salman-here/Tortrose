import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { CheckCircle, XCircle, Clock, Store, Loader2, Search } from 'lucide-react';
import axios from 'axios';
import { toast } from 'react-toastify';
import VerifiedBadge from '../../components/common/VerifiedBadge';

const StoreVerifications = () => {
    const [activeTab, setActiveTab] = useState('pending'); // 'pending', 'verified', or 'unverified'
    const [pendingStores, setPendingStores] = useState([]);
    const [verifiedStores, setVerifiedStores] = useState([]);
    const [unverifiedStores, setUnverifiedStores] = useState([]);
    const [filteredPending, setFilteredPending] = useState([]);
    const [filteredVerified, setFilteredVerified] = useState([]);
    const [filteredUnverified, setFilteredUnverified] = useState([]);
    const [searchQuery, setSearchQuery] = useState('');
    const [loading, setLoading] = useState(true);
    const [processingId, setProcessingId] = useState(null);
    const [showRejectModal, setShowRejectModal] = useState(false);
    const [showRemoveModal, setShowRemoveModal] = useState(false);
    const [showVerifyModal, setShowVerifyModal] = useState(false);
    const [selectedStore, setSelectedStore] = useState(null);
    const [rejectionReason, setRejectionReason] = useState('');
    const [removalReason, setRemovalReason] = useState('');

    useEffect(() => {
        fetchPendingVerifications();
        fetchVerifiedStores();
        fetchUnverifiedStores();
    }, []);

    useEffect(() => {
        const query = searchQuery.toLowerCase().trim();
        
        if (query === '') {
            setFilteredPending(pendingStores);
            setFilteredVerified(verifiedStores);
            setFilteredUnverified(unverifiedStores);
        } else {
            setFilteredPending(pendingStores.filter(store =>
                store.storeName.toLowerCase().includes(query) ||
                store.seller?.username.toLowerCase().includes(query) ||
                store.seller?.email.toLowerCase().includes(query)
            ));
            
            setFilteredVerified(verifiedStores.filter(store =>
                store.storeName.toLowerCase().includes(query) ||
                store.seller?.username.toLowerCase().includes(query) ||
                store.seller?.email.toLowerCase().includes(query)
            ));
            
            setFilteredUnverified(unverifiedStores.filter(store =>
                store.storeName.toLowerCase().includes(query) ||
                store.seller?.username.toLowerCase().includes(query) ||
                store.seller?.email.toLowerCase().includes(query)
            ));
        }
    }, [searchQuery, pendingStores, verifiedStores, unverifiedStores]);

    const fetchPendingVerifications = async () => {
        try {
            setLoading(true);
            const token = localStorage.getItem('jwtToken');
            const res = await axios.get(
                `${import.meta.env.VITE_API_URL}api/stores/verification/pending`,
                { headers: { Authorization: `Bearer ${token}` } }
            );
            setPendingStores(res.data.stores);
        } catch (error) {
            console.error('Error fetching pending verifications:', error);
            toast.error('Failed to load pending verifications');
        } finally {
            setLoading(false);
        }
    };

    const fetchVerifiedStores = async () => {
        try {
            const token = localStorage.getItem('jwtToken');
            const res = await axios.get(
                `${import.meta.env.VITE_API_URL}api/stores/verification/verified`,
                { headers: { Authorization: `Bearer ${token}` } }
            );
            setVerifiedStores(res.data.stores);
        } catch (error) {
            console.error('Error fetching verified stores:', error);
            toast.error('Failed to load verified stores');
        }
    };

    const fetchUnverifiedStores = async () => {
        try {
            const token = localStorage.getItem('jwtToken');
            const res = await axios.get(
                `${import.meta.env.VITE_API_URL}api/stores/all`,
                { headers: { Authorization: `Bearer ${token}` } }
            );
            // Filter to show only unverified stores (not verified and not pending)
            const unverified = res.data.stores.filter(store => 
                !store.verification?.isVerified && 
                store.verification?.status !== 'pending'
            );
            setUnverifiedStores(unverified);
            setFilteredUnverified(unverified);
        } catch (error) {
            console.error('Error fetching unverified stores:', error);
            toast.error('Failed to load stores');
        }
    };

    const handleApprove = async (storeId) => {
        try {
            setProcessingId(storeId);
            const token = localStorage.getItem('jwtToken');
            await axios.put(
                `${import.meta.env.VITE_API_URL}api/stores/verification/${storeId}/approve`,
                {},
                { headers: { Authorization: `Bearer ${token}` } }
            );
            toast.success('Store verification approved!');
            fetchPendingVerifications();
            fetchVerifiedStores();
        } catch (error) {
            toast.error(error.response?.data?.msg || 'Failed to approve verification');
        } finally {
            setProcessingId(null);
        }
    };

    const handleReject = async () => {
        if (!rejectionReason.trim()) {
            toast.error('Please provide a reason for rejection');
            return;
        }

        try {
            setProcessingId(selectedStore._id);
            const token = localStorage.getItem('jwtToken');
            await axios.put(
                `${import.meta.env.VITE_API_URL}api/stores/verification/${selectedStore._id}/reject`,
                { rejectionReason },
                { headers: { Authorization: `Bearer ${token}` } }
            );
            toast.success('Store verification rejected');
            setShowRejectModal(false);
            setRejectionReason('');
            setSelectedStore(null);
            fetchPendingVerifications();
        } catch (error) {
            toast.error(error.response?.data?.msg || 'Failed to reject verification');
        } finally {
            setProcessingId(null);
        }
    };

    const handleRemoveVerification = async () => {
        if (!removalReason.trim()) {
            toast.error('Please provide a reason for removing verification');
            return;
        }

        try {
            setProcessingId(selectedStore._id);
            const token = localStorage.getItem('jwtToken');
            await axios.put(
                `${import.meta.env.VITE_API_URL}api/stores/verification/${selectedStore._id}/remove`,
                { reason: removalReason },
                { headers: { Authorization: `Bearer ${token}` } }
            );
            toast.success('Store verification removed');
            setShowRemoveModal(false);
            setRemovalReason('');
            setSelectedStore(null);
            fetchVerifiedStores();
            fetchUnverifiedStores();
        } catch (error) {
            toast.error(error.response?.data?.msg || 'Failed to remove verification');
        } finally {
            setProcessingId(null);
        }
    };

    const handleVerifyStore = async () => {
        try {
            setProcessingId(selectedStore._id);
            const token = localStorage.getItem('jwtToken');
            await axios.put(
                `${import.meta.env.VITE_API_URL}api/stores/verification/${selectedStore._id}/approve`,
                {},
                { headers: { Authorization: `Bearer ${token}` } }
            );
            toast.success('Store verified successfully!');
            setShowVerifyModal(false);
            setSelectedStore(null);
            fetchUnverifiedStores();
            fetchVerifiedStores();
        } catch (error) {
            toast.error(error.response?.data?.msg || 'Failed to verify store');
        } finally {
            setProcessingId(null);
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
        <div className="p-4 md:p-6 max-w-6xl mx-auto">
            <div className="mb-6">
                <h1 className="text-2xl md:text-3xl font-bold text-gray-800 flex items-center gap-2">
                    <CheckCircle size={28} className="md:w-8 md:h-8" />
                    Store Verifications
                </h1>
                <p className="text-sm md:text-base text-gray-600 mt-2">
                    Manage store verification applications and verified stores
                </p>
            </div>

            {/* Tabs */}
            <div className="flex gap-2 mb-6 border-b border-gray-200">
                <button
                    onClick={() => setActiveTab('pending')}
                    className={`px-6 py-3 font-medium transition-colors ${
                        activeTab === 'pending'
                            ? 'text-blue-600 border-b-2 border-blue-600'
                            : 'text-gray-600 hover:text-gray-800'
                    }`}
                >
                    <div className="flex items-center gap-2">
                        <Clock size={18} />
                        Pending ({pendingStores.length})
                    </div>
                </button>
                <button
                    onClick={() => setActiveTab('verified')}
                    className={`px-6 py-3 font-medium transition-colors ${
                        activeTab === 'verified'
                            ? 'text-blue-600 border-b-2 border-blue-600'
                            : 'text-gray-600 hover:text-gray-800'
                    }`}
                >
                    <div className="flex items-center gap-2">
                        <CheckCircle size={18} />
                        Verified ({verifiedStores.length})
                    </div>
                </button>
                <button
                    onClick={() => setActiveTab('unverified')}
                    className={`px-6 py-3 font-medium transition-colors ${
                        activeTab === 'unverified'
                            ? 'text-blue-600 border-b-2 border-blue-600'
                            : 'text-gray-600 hover:text-gray-800'
                    }`}
                >
                    <div className="flex items-center gap-2">
                        <XCircle size={18} />
                        Unverified ({unverifiedStores.length})
                    </div>
                </button>
            </div>

            {/* Search Bar - Show on all tabs */}
            <div className="mb-6">
                <div className="relative">
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400" size={20} />
                    <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Search by store name, seller name, or email..."
                        className="w-full pl-10 pr-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    />
                </div>
            </div>

            {/* Pending Applications Tab */}
            {activeTab === 'pending' && (filteredPending.length === 0 ? (
                <div className="bg-white rounded-lg shadow-sm border p-8 text-center">
                    <CheckCircle className="mx-auto text-gray-300 mb-4" size={64} />
                    <h3 className="text-lg font-semibold text-gray-700 mb-2">No Pending Applications</h3>
                    <p className="text-gray-500">All verification requests have been processed</p>
                </div>
            ) : (
                <div className="space-y-4">
                    {filteredPending.map((store, idx) => (
                        <motion.div
                            key={store._id}
                            initial={{ opacity: 0, y: 20 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ duration: 0.3, delay: idx * 0.1 }}
                            whileHover={{ y: -4, transition: { duration: 0.2 } }}
                            className="bg-white rounded-2xl shadow-lg hover:shadow-2xl transition-all border border-gray-100 p-6 md:p-8"
                        >
                            <div className="flex flex-col md:flex-row gap-6">
                                {/* Store Logo */}
                                <div className="flex-shrink-0">
                                    {store.logo ? (
                                        <img
                                            src={store.logo}
                                            alt={store.storeName}
                                            className="w-24 h-24 rounded-2xl object-cover border-4 border-white shadow-lg ring-2 ring-blue-100"
                                        />
                                    ) : (
                                        <div className="w-24 h-24 rounded-2xl bg-linear-to-br from-indigo-500 to-sky-400 flex items-center justify-center shadow-lg ring-2 ring-indigo-100">
                                            <Store size={36} className="text-white" />
                                        </div>
                                    )}
                                </div>

                                {/* Store Info */}
                                <div className="flex-1">
                                    <h3 className="text-2xl font-bold text-gray-900 mb-2">{store.storeName}</h3>
                                    <p className="text-sm text-gray-600 mb-2">
                                        Seller: <span className="font-medium">{store.seller?.username}</span> ({store.seller?.email})
                                    </p>
                                    <p className="text-sm text-gray-500 mb-4">
                                        Applied: {new Date(store.verification.appliedAt).toLocaleDateString()} at{' '}
                                        {new Date(store.verification.appliedAt).toLocaleTimeString()}
                                    </p>

                                    {/* Application Message */}
                                    {store.verification.applicationMessage && (
                                        <div className="bg-gray-50 rounded-lg p-3 mb-4">
                                            <p className="text-sm font-medium text-gray-700 mb-1">Application Message:</p>
                                            <p className="text-sm text-gray-600">{store.verification.applicationMessage}</p>
                                        </div>
                                    )}

                                    {/* Contact Information */}
                                    {(store.verification.contactEmail || store.verification.contactPhone) && (
                                        <div className="bg-blue-50 rounded-lg p-3 mb-4 border border-blue-200">
                                            <p className="text-sm font-medium text-gray-700 mb-2">Contact Information:</p>
                                            <div className="space-y-1">
                                                {store.verification.contactEmail && (
                                                    <div className="flex items-center gap-2">
                                                        <svg className="w-4 h-4 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                                                        </svg>
                                                        <a href={`mailto:${store.verification.contactEmail}`} className="text-sm text-blue-600 hover:underline">
                                                            {store.verification.contactEmail}
                                                        </a>
                                                    </div>
                                                )}
                                                {store.verification.contactPhone && (
                                                    <div className="flex items-center gap-2">
                                                        <svg className="w-4 h-4 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                                                        </svg>
                                                        <a href={`tel:${store.verification.contactPhone}`} className="text-sm text-blue-600 hover:underline">
                                                            {store.verification.contactPhone}
                                                        </a>
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    )}

                                    {/* Store Stats */}
                                    <div className="flex flex-wrap gap-4 text-sm mb-4">
                                        <div className="flex items-center gap-1">
                                            <span className="text-gray-500">Products:</span>
                                            <span className="font-medium text-gray-700">{store.productCount || 0}</span>
                                        </div>
                                        <div className="flex items-center gap-1">
                                            <span className="text-gray-500">Views:</span>
                                            <span className="font-medium text-gray-700">{store.views || 0}</span>
                                        </div>
                                        <div className="flex items-center gap-1">
                                            <span className="text-gray-500">Trusters:</span>
                                            <span className="font-medium text-gray-700">{store.trustCount || 0}</span>
                                        </div>
                                    </div>

                                    {/* Action Buttons */}
                                    <div className="flex gap-3">
                                        <button
                                            onClick={() => handleApprove(store._id)}
                                            disabled={processingId === store._id}
                                            className="flex-1 md:flex-none px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 font-medium"
                                        >
                                            {processingId === store._id ? (
                                                <>
                                                    <Loader2 className="animate-spin" size={16} />
                                                    Processing...
                                                </>
                                            ) : (
                                                <>
                                                    <CheckCircle size={18} />
                                                    Approve
                                                </>
                                            )}
                                        </button>
                                        <button
                                            onClick={() => {
                                                setSelectedStore(store);
                                                setShowRejectModal(true);
                                            }}
                                            disabled={processingId === store._id}
                                            className="flex-1 md:flex-none px-6 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 font-medium"
                                        >
                                            <XCircle size={18} />
                                            Reject
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </motion.div>
                    ))}
                </div>
            ))}

            {/* Verified Stores Tab */}
            {activeTab === 'verified' && (filteredVerified.length === 0 ? (
                <div className="bg-white rounded-lg shadow-sm border p-8 text-center">
                    <CheckCircle className="mx-auto text-gray-300 mb-4" size={64} />
                    <h3 className="text-lg font-semibold text-gray-700 mb-2">No Verified Stores</h3>
                    <p className="text-gray-500">No stores have been verified yet</p>
                </div>
            ) : (
                <div className="space-y-4">
                    {filteredVerified.map((store, idx) => (
                        <motion.div
                            key={store._id}
                            initial={{ opacity: 0, y: 20 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ duration: 0.3, delay: idx * 0.1 }}
                            whileHover={{ y: -4, transition: { duration: 0.2 } }}
                            className="bg-linear-to-br from-green-50 to-emerald-50 rounded-2xl shadow-lg hover:shadow-2xl transition-all border border-green-200 p-6 md:p-8"
                        >
                            <div className="flex flex-col md:flex-row gap-6">
                                {/* Store Logo */}
                                <div className="flex-shrink-0">
                                    {store.logo ? (
                                        <img
                                            src={store.logo}
                                            alt={store.storeName}
                                            className="w-24 h-24 rounded-2xl object-cover border-4 border-white shadow-lg ring-2 ring-green-200"
                                        />
                                    ) : (
                                        <div className="w-24 h-24 rounded-2xl bg-linear-to-br from-green-500 to-emerald-500 flex items-center justify-center shadow-lg ring-2 ring-green-200">
                                            <Store size={36} className="text-white" />
                                        </div>
                                    )}
                                </div>

                                {/* Store Info */}
                                <div className="flex-1">
                                    <div className="flex items-center gap-2 mb-2">
                                        <h3 className="text-2xl font-bold text-gray-900">{store.storeName}</h3>
                                        <CheckCircle size={24} className="text-green-600 fill-green-500" />
                                    </div>
                                    <p className="text-sm text-gray-600 mb-2">
                                        Seller: <span className="font-medium">{store.seller?.username}</span> ({store.seller?.email})
                                    </p>
                                    <p className="text-sm text-gray-500 mb-4">
                                        Verified: {new Date(store.verification.reviewedAt).toLocaleDateString()} at{' '}
                                        {new Date(store.verification.reviewedAt).toLocaleTimeString()}
                                    </p>

                                    {/* Store Stats */}
                                    <div className="flex flex-wrap gap-4 text-sm mb-4">
                                        <div className="flex items-center gap-1">
                                            <span className="text-gray-500">Products:</span>
                                            <span className="font-medium text-gray-700">{store.productCount || 0}</span>
                                        </div>
                                        <div className="flex items-center gap-1">
                                            <span className="text-gray-500">Views:</span>
                                            <span className="font-medium text-gray-700">{store.views || 0}</span>
                                        </div>
                                        <div className="flex items-center gap-1">
                                            <span className="text-gray-500">Trusters:</span>
                                            <span className="font-medium text-gray-700">{store.trustCount || 0}</span>
                                        </div>
                                    </div>

                                    {/* Action Button */}
                                    <button
                                        onClick={() => {
                                            setSelectedStore(store);
                                            setShowRemoveModal(true);
                                        }}
                                        disabled={processingId === store._id}
                                        className="px-6 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 font-medium"
                                    >
                                        <XCircle size={18} />
                                        Remove Verification
                                    </button>
                                </div>
                            </div>
                        </motion.div>
                    ))}
                </div>
            ))}

            {/* Reject Modal */}
            {showRejectModal && selectedStore && (
                <div className="fixed inset-0 bg-black/20 backdrop-blur-sm flex items-center justify-center z-50 p-4">
                    <motion.div
                        initial={{ scale: 0.9, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        className="bg-white rounded-lg p-6 max-w-md w-full"
                    >
                        <h3 className="text-xl font-bold text-gray-800 mb-4 flex items-center gap-2">
                            <XCircle className="text-red-500" size={24} />
                            Reject Verification
                        </h3>
                        <p className="text-gray-600 text-sm mb-4">
                            You are about to reject the verification application for <strong>{selectedStore.storeName}</strong>.
                            Please provide a reason:
                        </p>
                        <textarea
                            value={rejectionReason}
                            onChange={(e) => setRejectionReason(e.target.value)}
                            rows={4}
                            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-500 mb-4"
                            placeholder="Explain why the verification is being rejected..."
                            maxLength={500}
                        />
                        <p className="text-xs text-gray-500 mb-4">
                            {rejectionReason.length}/500 characters
                        </p>
                        <div className="flex gap-4">
                            <button
                                onClick={() => {
                                    setShowRejectModal(false);
                                    setRejectionReason('');
                                    setSelectedStore(null);
                                }}
                                className="flex-1 px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
                                disabled={processingId === selectedStore._id}
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleReject}
                                disabled={processingId === selectedStore._id || !rejectionReason.trim()}
                                className="flex-1 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                            >
                                {processingId === selectedStore._id ? (
                                    <>
                                        <Loader2 className="animate-spin" size={16} />
                                        Rejecting...
                                    </>
                                ) : (
                                    'Reject Application'
                                )}
                            </button>
                        </div>
                    </motion.div>
                </div>
            )}

            {/* Unverified Stores Tab */}
            {activeTab === 'unverified' && (filteredUnverified.length === 0 ? (
                <div className="bg-white rounded-lg shadow-sm border p-8 text-center">
                    <Store className="mx-auto text-gray-300 mb-4" size={64} />
                    <h3 className="text-lg font-semibold text-gray-700 mb-2">
                        {searchQuery ? 'No stores found' : 'No unverified stores'}
                    </h3>
                    <p className="text-gray-500">
                        {searchQuery ? 'Try a different search term' : 'All stores are either verified or pending verification'}
                    </p>
                </div>
            ) : (
                <div className="space-y-4">
                    {filteredUnverified.map((store, idx) => (
                        <motion.div
                            key={store._id}
                            initial={{ opacity: 0, y: 20 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ duration: 0.3, delay: idx * 0.05 }}
                            whileHover={{ y: -4, transition: { duration: 0.2 } }}
                            className="bg-white rounded-2xl shadow-lg hover:shadow-2xl transition-all border border-gray-100 p-6 md:p-8"
                        >
                            <div className="flex flex-col md:flex-row gap-6">
                                {/* Store Logo */}
                                <div className="flex-shrink-0">
                                    {store.logo ? (
                                        <img
                                            src={store.logo}
                                            alt={store.storeName}
                                            className="w-24 h-24 rounded-2xl object-cover border-4 border-white shadow-lg ring-2 ring-gray-100"
                                        />
                                    ) : (
                                        <div className="w-24 h-24 rounded-2xl bg-linear-to-br from-indigo-500 to-sky-400 flex items-center justify-center shadow-lg ring-2 ring-indigo-100">
                                            <Store size={36} className="text-white" />
                                        </div>
                                    )}
                                </div>

                                {/* Store Info */}
                                <div className="flex-1">
                                    <div className="flex items-center gap-2 mb-2">
                                        <h3 className="text-2xl font-bold text-gray-900">{store.storeName}</h3>
                                        {store.verification?.isVerified && (
                                            <VerifiedBadge size="md" />
                                        )}
                                    </div>
                                    <p className="text-sm text-gray-600 mb-2">
                                        Seller: <span className="font-medium">{store.seller?.username}</span> ({store.seller?.email})
                                    </p>

                                    {/* Verification Status */}
                                    <div className="mb-3">
                                        {store.verification?.isVerified ? (
                                            <span className="inline-flex items-center gap-1 px-3 py-1 bg-green-100 text-green-700 rounded-full text-sm font-medium">
                                                <CheckCircle size={14} />
                                                Verified
                                            </span>
                                        ) : (
                                            <span className="inline-flex items-center gap-1 px-3 py-1 bg-gray-100 text-gray-700 rounded-full text-sm font-medium">
                                                <XCircle size={14} />
                                                Not Verified
                                            </span>
                                        )}
                                    </div>

                                    {/* Store Stats */}
                                    <div className="flex flex-wrap gap-4 text-sm mb-4">
                                        <div className="flex items-center gap-1">
                                            <span className="text-gray-500">Products:</span>
                                            <span className="font-medium text-gray-700">{store.productCount || 0}</span>
                                        </div>
                                        <div className="flex items-center gap-1">
                                            <span className="text-gray-500">Views:</span>
                                            <span className="font-medium text-gray-700">{store.views || 0}</span>
                                        </div>
                                        <div className="flex items-center gap-1">
                                            <span className="text-gray-500">Trusters:</span>
                                            <span className="font-medium text-gray-700">{store.trustCount || 0}</span>
                                        </div>
                                    </div>

                                    {/* Action Button */}
                                    {!store.verification?.isVerified && (
                                        <button
                                            onClick={() => {
                                                setSelectedStore(store);
                                                setShowVerifyModal(true);
                                            }}
                                            disabled={processingId === store._id}
                                            className="px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 font-medium"
                                        >
                                            <CheckCircle size={18} />
                                            Verify Store
                                        </button>
                                    )}
                                </div>
                            </div>
                        </motion.div>
                    ))}
                </div>
            ))}

            {/* Remove Verification Modal */}
            {showRemoveModal && selectedStore && (
                <div className="fixed inset-0 bg-black/20 backdrop-blur-sm flex items-center justify-center z-50 p-4">
                    <motion.div
                        initial={{ scale: 0.9, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        className="bg-white rounded-lg p-6 max-w-md w-full"
                    >
                        <h3 className="text-xl font-bold text-gray-800 mb-4 flex items-center gap-2">
                            <XCircle className="text-red-500" size={24} />
                            Remove Verification
                        </h3>
                        <p className="text-gray-600 text-sm mb-4">
                            You are about to remove verification from <strong>{selectedStore.storeName}</strong>.
                            Please provide a reason:
                        </p>
                        <textarea
                            value={removalReason}
                            onChange={(e) => setRemovalReason(e.target.value)}
                            rows={4}
                            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-500 mb-4"
                            placeholder="Explain why the verification is being removed..."
                            maxLength={500}
                        />
                        <p className="text-xs text-gray-500 mb-4">
                            {removalReason.length}/500 characters
                        </p>
                        <div className="flex gap-4">
                            <button
                                onClick={() => {
                                    setShowRemoveModal(false);
                                    setRemovalReason('');
                                    setSelectedStore(null);
                                }}
                                className="flex-1 px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
                                disabled={processingId === selectedStore._id}
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleRemoveVerification}
                                disabled={processingId === selectedStore._id || !removalReason.trim()}
                                className="flex-1 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                            >
                                {processingId === selectedStore._id ? (
                                    <>
                                        <Loader2 className="animate-spin" size={16} />
                                        Removing...
                                    </>
                                ) : (
                                    'Remove Verification'
                                )}
                            </button>
                        </div>
                    </motion.div>
                </div>
            )}

            {/* Verify Store Modal */}
            {showVerifyModal && selectedStore && (
                <div className="fixed inset-0 bg-black/20 backdrop-blur-sm flex items-center justify-center z-50 p-4">
                    <motion.div
                        initial={{ scale: 0.9, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        className="bg-white rounded-lg p-6 max-w-md w-full"
                    >
                        <h3 className="text-xl font-bold text-gray-800 mb-4 flex items-center gap-2">
                            <CheckCircle className="text-green-500" size={24} />
                            Verify Store
                        </h3>
                        <p className="text-gray-600 text-sm mb-6">
                            Are you sure you want to verify <strong>{selectedStore.storeName}</strong>?
                            This will add a verification badge to the store.
                        </p>
                        <div className="flex gap-4">
                            <button
                                onClick={() => {
                                    setShowVerifyModal(false);
                                    setSelectedStore(null);
                                }}
                                className="flex-1 px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
                                disabled={processingId === selectedStore._id}
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleVerifyStore}
                                disabled={processingId === selectedStore._id}
                                className="flex-1 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                            >
                                {processingId === selectedStore._id ? (
                                    <>
                                        <Loader2 className="animate-spin" size={16} />
                                        Verifying...
                                    </>
                                ) : (
                                    'Verify Store'
                                )}
                            </button>
                        </div>
                    </motion.div>
                </div>
            )}
        </div>
    );
};

export default StoreVerifications;
