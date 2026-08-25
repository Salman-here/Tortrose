import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { CheckCircle, XCircle, Clock, Store, Loader2, Search, Mail, Phone, ShoppingBag, Eye, Heart, AlertTriangle } from 'lucide-react';
import axios from 'axios';
import { toast } from 'react-toastify';
import VerifiedBadge from '../../components/common/VerifiedBadge';
import Loader from '../../components/common/Loader';
import { getAuthToken } from "../../utils/cookieHelper";

const StoreVerifications = () => {
    const [activeTab, setActiveTab] = useState('pending');
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

    useEffect(() => { fetchPendingVerifications(); fetchVerifiedStores(); fetchUnverifiedStores(); }, []);

    useEffect(() => {
        const query = searchQuery.toLowerCase().trim();
        if (query === '') { setFilteredPending(pendingStores); setFilteredVerified(verifiedStores); setFilteredUnverified(unverifiedStores); }
        else {
            const filter = (stores) => stores.filter(s => s.storeName.toLowerCase().includes(query) || s.seller?.username.toLowerCase().includes(query) || s.seller?.email.toLowerCase().includes(query));
            setFilteredPending(filter(pendingStores)); setFilteredVerified(filter(verifiedStores)); setFilteredUnverified(filter(unverifiedStores));
        }
    }, [searchQuery, pendingStores, verifiedStores, unverifiedStores]);

    const fetchPendingVerifications = async () => {
        try { setLoading(true); const token = getAuthToken(); const res = await axios.get(`${import.meta.env.VITE_API_URL}api/stores/verification/pending`, { headers: { Authorization: `Bearer ${token}` } }); setPendingStores(res.data.stores); }
        catch (error) { console.error(error); toast.error('Failed to load pending verifications'); } finally { setLoading(false); }
    };
    const fetchVerifiedStores = async () => {
        try { const token = getAuthToken(); const res = await axios.get(`${import.meta.env.VITE_API_URL}api/stores/verification/verified`, { headers: { Authorization: `Bearer ${token}` } }); setVerifiedStores(res.data.stores); }
        catch (error) { console.error(error); }
    };
    const fetchUnverifiedStores = async () => {
        try { const token = getAuthToken(); const res = await axios.get(`${import.meta.env.VITE_API_URL}api/stores/all`, { headers: { Authorization: `Bearer ${token}` } });
            const unverified = res.data.stores.filter(s => !s.verification?.isVerified && s.verification?.status !== 'pending');
            setUnverifiedStores(unverified); setFilteredUnverified(unverified);
        } catch (error) { console.error(error); }
    };

    const handleApprove = async (storeId) => {
        try { setProcessingId(storeId); const token = getAuthToken(); await axios.put(`${import.meta.env.VITE_API_URL}api/stores/verification/${storeId}/approve`, {}, { headers: { Authorization: `Bearer ${token}` } }); toast.success('Store verified!'); fetchPendingVerifications(); fetchVerifiedStores(); }
        catch (error) { toast.error(error.response?.data?.msg || 'Failed'); } finally { setProcessingId(null); }
    };
    const handleReject = async () => {
        if (!rejectionReason.trim()) { toast.error('Please provide a reason'); return; }
        try { setProcessingId(selectedStore._id); const token = getAuthToken(); await axios.put(`${import.meta.env.VITE_API_URL}api/stores/verification/${selectedStore._id}/reject`, { rejectionReason }, { headers: { Authorization: `Bearer ${token}` } }); toast.success('Rejected'); setShowRejectModal(false); setRejectionReason(''); setSelectedStore(null); fetchPendingVerifications(); }
        catch (error) { toast.error(error.response?.data?.msg || 'Failed'); } finally { setProcessingId(null); }
    };
    const handleRemoveVerification = async () => {
        if (!removalReason.trim()) { toast.error('Please provide a reason'); return; }
        try { setProcessingId(selectedStore._id); const token = getAuthToken(); await axios.put(`${import.meta.env.VITE_API_URL}api/stores/verification/${selectedStore._id}/remove`, { reason: removalReason }, { headers: { Authorization: `Bearer ${token}` } }); toast.success('Verification removed'); setShowRemoveModal(false); setRemovalReason(''); setSelectedStore(null); fetchVerifiedStores(); fetchUnverifiedStores(); }
        catch (error) { toast.error(error.response?.data?.msg || 'Failed'); } finally { setProcessingId(null); }
    };
    const handleVerifyStore = async () => {
        try { setProcessingId(selectedStore._id); const token = getAuthToken(); await axios.put(`${import.meta.env.VITE_API_URL}api/stores/verification/${selectedStore._id}/approve`, {}, { headers: { Authorization: `Bearer ${token}` } }); toast.success('Store verified!'); setShowVerifyModal(false); setSelectedStore(null); fetchUnverifiedStores(); fetchVerifiedStores(); }
        catch (error) { toast.error(error.response?.data?.msg || 'Failed'); } finally { setProcessingId(null); }
    };

    if (loading) return <div className="flex justify-center items-center h-64"><Loader /></div>;

    const tabs = [
        { key: 'pending', label: 'Pending', icon: <Clock size={16} />, count: pendingStores.length, color: 'hsl(45, 93%, 47%)' },
        { key: 'verified', label: 'Verified', icon: <CheckCircle size={16} />, count: verifiedStores.length, color: 'hsl(150, 60%, 45%)' },
        { key: 'unverified', label: 'Unverified', icon: <XCircle size={16} />, count: unverifiedStores.length, color: 'hsl(var(--muted-foreground))' },
    ];

    const StoreCard = ({ store, actions, borderColor }) => (
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} whileHover={{ y: -4 }}
            className="glass-card p-6 md:p-8 transition-all" style={borderColor ? { borderColor, borderWidth: '1px' } : {}}>
            <div className="flex flex-col md:flex-row gap-6">
                <div className="flex-shrink-0">
                    {store.logo ? (
                        <img src={store.logo} alt={store.storeName} className="w-20 h-20 rounded-2xl object-cover" style={{ border: '3px solid var(--glass-border-strong)' }} />
                    ) : (
                        <div className="w-20 h-20 rounded-2xl flex items-center justify-center" style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(200, 80%, 50%))' }}>
                            <Store size={32} className="text-white" />
                        </div>
                    )}
                </div>
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                        <h3 className="text-xl font-bold truncate" style={{ color: 'hsl(var(--foreground))' }}>{store.storeName}</h3>
                        {store.verification?.isVerified && <VerifiedBadge size="md" />}
                    </div>
                    <p className="text-sm mb-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                        Seller: <span className="font-medium">{store.seller?.username}</span> ({store.seller?.email})
                    </p>
                    {store.verification?.appliedAt && (
                        <p className="text-xs mb-3" style={{ color: 'hsl(var(--muted-foreground))' }}>
                            {store.verification?.isVerified ? 'Verified' : 'Applied'}: {new Date(store.verification?.reviewedAt || store.verification?.appliedAt).toLocaleDateString()}
                        </p>
                    )}

                    {/* Application Message */}
                    {store.verification?.applicationMessage && (
                        <div className="glass-inner rounded-xl p-3 mb-3">
                            <p className="text-xs font-medium mb-1" style={{ color: 'hsl(var(--foreground))' }}>Application Message:</p>
                            <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>{store.verification.applicationMessage}</p>
                        </div>
                    )}

                    {/* Contact Info */}
                    {(store.verification?.contactEmail || store.verification?.contactPhone) && (
                        <div className="glass-inner rounded-xl p-3 mb-3" style={{ borderLeft: '3px solid hsl(220, 70%, 55%)' }}>
                            <p className="text-xs font-medium mb-2" style={{ color: 'hsl(var(--foreground))' }}>Contact Information:</p>
                            <div className="space-y-1">
                                {store.verification.contactEmail && (
                                    <div className="flex items-center gap-2">
                                        <Mail size={14} style={{ color: 'hsl(var(--primary))' }} />
                                        <a href={`mailto:${store.verification.contactEmail}`} className="text-xs font-medium" style={{ color: 'hsl(var(--primary))' }}>{store.verification.contactEmail}</a>
                                    </div>
                                )}
                                {store.verification.contactPhone && (
                                    <div className="flex items-center gap-2">
                                        <Phone size={14} style={{ color: 'hsl(var(--primary))' }} />
                                        <a href={`tel:${store.verification.contactPhone}`} className="text-xs font-medium" style={{ color: 'hsl(var(--primary))' }}>{store.verification.contactPhone}</a>
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    {/* Stats */}
                    <div className="flex flex-wrap gap-4 text-xs mb-4">
                        {[{ label: 'Products', value: store.productCount || 0 }, { label: 'Views', value: store.views || 0 }, { label: 'Trusters', value: store.trustCount || 0 }].map(stat => (
                            <div key={stat.label} className="flex items-center gap-1">
                                <span style={{ color: 'hsl(var(--muted-foreground))' }}>{stat.label}:</span>
                                <span className="font-semibold" style={{ color: 'hsl(var(--foreground))' }}>{stat.value}</span>
                            </div>
                        ))}
                    </div>

                    {/* Actions */}
                    <div className="flex flex-wrap gap-3">{actions}</div>
                </div>
            </div>
        </motion.div>
    );

    const EmptyState = ({ icon, title, description }) => (
        <div className="glass-panel p-8 text-center">
            <div className="glass-inner inline-flex p-4 rounded-2xl mb-3">{icon}</div>
            <h3 className="text-lg font-semibold mb-2" style={{ color: 'hsl(var(--foreground))' }}>{title}</h3>
            <p className="text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>{description}</p>
        </div>
    );

    const getFilteredList = () => {
        if (activeTab === 'pending') return filteredPending;
        if (activeTab === 'verified') return filteredVerified;
        return filteredUnverified;
    };

    return (
        <div className="p-4 md:p-6 max-w-6xl mx-auto">
            <div className="mb-6">
                <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight flex items-center gap-2" style={{ color: 'hsl(var(--foreground))' }}>
                    <CheckCircle size={28} /> Store Verifications
                </h1>
                <p className="text-sm mt-2" style={{ color: 'hsl(var(--muted-foreground))' }}>Manage store verification applications</p>
            </div>

            {/* Tabs */}
            <div className="flex gap-2 mb-6" style={{ borderBottom: '1px solid var(--glass-border)' }}>
                {tabs.map(tab => (
                    <button key={tab.key} onClick={() => setActiveTab(tab.key)}
                        className="px-4 py-3 font-medium text-sm transition-all flex items-center gap-2"
                        style={{ color: activeTab === tab.key ? 'hsl(var(--primary))' : 'hsl(var(--muted-foreground))', borderBottom: activeTab === tab.key ? '2px solid hsl(var(--primary))' : '2px solid transparent' }}>
                        {tab.icon} {tab.label} ({tab.count})
                    </button>
                ))}
            </div>

            {/* Search */}
            <div className="mb-6">
                <div className="search-input-wrapper">
                    <div className="search-input-icon"><Search size={16} /></div>
                    <input type="text" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder="Search by store name, seller name, or email..."
                        className="glass-input glass-input-search" />
                </div>
            </div>

            {/* Content */}
            {getFilteredList().length === 0 ? (
                <EmptyState
                    icon={activeTab === 'pending' ? <Clock size={40} style={{ color: 'hsl(var(--muted-foreground))' }} /> : activeTab === 'verified' ? <CheckCircle size={40} style={{ color: 'hsl(var(--muted-foreground))' }} /> : <Store size={40} style={{ color: 'hsl(var(--muted-foreground))' }} />}
                    title={activeTab === 'pending' ? 'No Pending Applications' : activeTab === 'verified' ? 'No Verified Stores' : searchQuery ? 'No stores found' : 'No unverified stores'}
                    description={activeTab === 'pending' ? 'All verification requests have been processed' : activeTab === 'verified' ? 'No stores have been verified yet' : searchQuery ? 'Try a different search term' : 'All stores are verified or pending'}
                />
            ) : (
                <div className="space-y-4">
                    {activeTab === 'pending' && filteredPending.map((store) => (
                        <StoreCard key={store._id} store={store} borderColor="hsl(45, 93%, 47%)" actions={<>
                            <motion.button whileHover={{ scale: 1.02 }} onClick={() => handleApprove(store._id)} disabled={processingId === store._id}
                                className="flex-1 md:flex-none px-5 py-2 rounded-xl text-white font-medium text-sm flex items-center justify-center gap-2 disabled:opacity-50"
                                style={{ background: 'hsl(150, 60%, 45%)' }}>
                                {processingId === store._id ? <><Loader2 className="animate-spin" size={16} /> Processing...</> : <><CheckCircle size={16} /> Approve</>}
                            </motion.button>
                            <motion.button whileHover={{ scale: 1.02 }} onClick={() => { setSelectedStore(store); setShowRejectModal(true); }} disabled={processingId === store._id}
                                className="flex-1 md:flex-none px-5 py-2 rounded-xl font-medium text-sm flex items-center justify-center gap-2 disabled:opacity-50"
                                style={{ background: 'rgba(239, 68, 68, 0.12)', color: 'hsl(0, 72%, 55%)' }}>
                                <XCircle size={16} /> Reject
                            </motion.button>
                        </>} />
                    ))}
                    {activeTab === 'verified' && filteredVerified.map((store) => (
                        <StoreCard key={store._id} store={store} borderColor="hsl(150, 60%, 45%)" actions={
                            <motion.button whileHover={{ scale: 1.02 }} onClick={() => { setSelectedStore(store); setShowRemoveModal(true); }} disabled={processingId === store._id}
                                className="px-5 py-2 rounded-xl font-medium text-sm flex items-center gap-2 disabled:opacity-50"
                                style={{ background: 'rgba(239, 68, 68, 0.12)', color: 'hsl(0, 72%, 55%)' }}>
                                <XCircle size={16} /> Remove Verification
                            </motion.button>
                        } />
                    ))}
                    {activeTab === 'unverified' && filteredUnverified.map((store) => (
                        <StoreCard key={store._id} store={store} actions={
                            !store.verification?.isVerified && (
                                <motion.button whileHover={{ scale: 1.02 }} onClick={() => { setSelectedStore(store); setShowVerifyModal(true); }} disabled={processingId === store._id}
                                    className="px-5 py-2 rounded-xl text-white font-medium text-sm flex items-center gap-2 disabled:opacity-50"
                                    style={{ background: 'hsl(150, 60%, 45%)' }}>
                                    <CheckCircle size={16} /> Verify Store
                                </motion.button>
                            )
                        } />
                    ))}
                </div>
            )}

            {/* Modals */}
            {[
                { show: showRejectModal, store: selectedStore, title: 'Reject Verification', icon: <XCircle size={22} style={{ color: 'hsl(0, 72%, 55%)' }} />, value: rejectionReason, setValue: setRejectionReason, placeholder: 'Explain why...', onConfirm: handleReject, confirmLabel: 'Reject Application', confirmStyle: { background: 'hsl(0, 72%, 55%)' }, onClose: () => { setShowRejectModal(false); setRejectionReason(''); setSelectedStore(null); } },
                { show: showRemoveModal, store: selectedStore, title: 'Remove Verification', icon: <AlertTriangle size={22} style={{ color: 'hsl(30, 90%, 50%)' }} />, value: removalReason, setValue: setRemovalReason, placeholder: 'Explain why...', onConfirm: handleRemoveVerification, confirmLabel: 'Remove Verification', confirmStyle: { background: 'hsl(0, 72%, 55%)' }, onClose: () => { setShowRemoveModal(false); setRemovalReason(''); setSelectedStore(null); } },
            ].map((modal, i) => modal.show && modal.store && (
                <div key={i} className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
                    <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="glass-panel p-6 max-w-md w-full">
                        <h3 className="text-xl font-bold mb-4 flex items-center gap-2" style={{ color: 'hsl(var(--foreground))' }}>{modal.icon} {modal.title}</h3>
                        <p className="text-sm mb-4" style={{ color: 'hsl(var(--muted-foreground))' }}>For <strong>{modal.store.storeName}</strong>. Please provide a reason:</p>
                        <textarea value={modal.value} onChange={(e) => modal.setValue(e.target.value)} rows={4} className="glass-input mb-2" placeholder={modal.placeholder} maxLength={500} />
                        <p className="text-xs mb-4" style={{ color: 'hsl(var(--muted-foreground))' }}>{modal.value.length}/500</p>
                        <div className="flex gap-4">
                            <button onClick={modal.onClose} className="flex-1 px-4 py-2 rounded-xl glass-inner font-medium" style={{ color: 'hsl(var(--foreground))' }} disabled={processingId === modal.store._id}>Cancel</button>
                            <button onClick={modal.onConfirm} disabled={processingId === modal.store._id || !modal.value.trim()}
                                className="flex-1 px-4 py-2 rounded-xl text-white font-medium disabled:opacity-50 flex items-center justify-center gap-2" style={modal.confirmStyle}>
                                {processingId === modal.store._id ? <><Loader2 className="animate-spin" size={16} /> Processing...</> : modal.confirmLabel}
                            </button>
                        </div>
                    </motion.div>
                </div>
            ))}

            {/* Verify Store Modal */}
            {showVerifyModal && selectedStore && (
                <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
                    <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="glass-panel p-6 max-w-md w-full">
                        <h3 className="text-xl font-bold mb-4 flex items-center gap-2" style={{ color: 'hsl(var(--foreground))' }}>
                            <CheckCircle size={22} style={{ color: 'hsl(150, 60%, 45%)' }} /> Verify Store
                        </h3>
                        <p className="text-sm mb-6" style={{ color: 'hsl(var(--muted-foreground))' }}>Verify <strong>{selectedStore.storeName}</strong>? This adds a verification badge.</p>
                        <div className="flex gap-4">
                            <button onClick={() => { setShowVerifyModal(false); setSelectedStore(null); }} className="flex-1 px-4 py-2 rounded-xl glass-inner font-medium" style={{ color: 'hsl(var(--foreground))' }} disabled={processingId === selectedStore._id}>Cancel</button>
                            <button onClick={handleVerifyStore} disabled={processingId === selectedStore._id}
                                className="flex-1 px-4 py-2 rounded-xl text-white font-medium disabled:opacity-50 flex items-center justify-center gap-2" style={{ background: 'hsl(150, 60%, 45%)' }}>
                                {processingId === selectedStore._id ? <><Loader2 className="animate-spin" size={16} /> Verifying...</> : 'Verify Store'}
                            </button>
                        </div>
                    </motion.div>
                </div>
            )}
        </div>
    );
};

export default StoreVerifications;
