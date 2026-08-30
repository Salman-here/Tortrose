import React, { useState, useEffect, useCallback } from 'react';
import { motion as Motion, AnimatePresence } from 'framer-motion';
import { toast } from 'react-toastify';
import { Search, Filter, User, UserX, UserCheck, Shield, ShieldOff, Trash2, Users, UserCog, AlertCircle, Store, CalendarDays, CreditCard, MessageCircle, Mail, Clock, Loader2 } from 'lucide-react';
import axios from 'axios';
import { useAuth } from '../../contexts/AuthContext';
import Loader from '../common/Loader';
import { getAuthToken } from "../../utils/cookieHelper";

const UserManagement = () => {
  const { currentUser } = useAuth();
  const [users, setUsers] = useState([]);
  const [allUsers, setAllUsers] = useState([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [roleFilter, setRoleFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [showBlockModal, setShowBlockModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showRoleModal, setShowRoleModal] = useState(false);
  const [showTrialModal, setShowTrialModal] = useState(false);
  const [selectedUser, setSelectedUser] = useState(null);
  const [trialAmount, setTrialAmount] = useState(15);
  const [trialUnit, setTrialUnit] = useState('days');
  const [trialMode, setTrialMode] = useState('reset');
  const [trialSaving, setTrialSaving] = useState(false);

  const serializeFilters = useCallback(() => {
    let params = new URLSearchParams();
    if (searchTerm !== '') params.append('search', searchTerm);
    if (roleFilter !== 'all') params.append('role', roleFilter);
    if (statusFilter !== 'all') params.append('status', statusFilter);
    return params.toString();
  }, [roleFilter, searchTerm, statusFilter]);

  const fetchUsers = useCallback(async () => {
    try { setLoading(true); const token = getAuthToken(); const query = serializeFilters(); const res = await axios.get(`${import.meta.env.VITE_API_URL}api/user/get?${query}`, { headers: { Authorization: `Bearer ${token}` } }); setUsers(res.data.users); }
    catch (error) { toast.error(error.response?.data.msg || 'Server error'); } finally { setLoading(false); }
  }, [serializeFilters]);

  const fetchAllUsers = useCallback(async () => {
    try { const token = getAuthToken(); const res = await axios.get(`${import.meta.env.VITE_API_URL}api/user/get`, { headers: { Authorization: `Bearer ${token}` } }); setAllUsers(res.data.users); }
    catch (error) { toast.error(error.response?.data.msg || 'Server error'); }
  }, []);

  useEffect(() => { fetchAllUsers(); }, [fetchAllUsers]);
  useEffect(() => { fetchUsers(); }, [fetchUsers]);

  const handleBlockUser = (user) => { setSelectedUser(user); setShowBlockModal(true); };
  const handleDeleteUser = (user) => { setSelectedUser(user); setShowDeleteModal(true); };
  const handleChangeRole = (user) => { setSelectedUser(user); setShowRoleModal(true); };

  const confirmBlockUser = async () => {
    try { const token = getAuthToken(); const res = await axios.patch(`${import.meta.env.VITE_API_URL}api/user/block-toggle/${selectedUser._id}`, {}, { headers: { Authorization: `Bearer ${token}` } }); toast.success(res.data?.msg || 'Updated'); fetchUsers(); fetchAllUsers(); }
    catch { toast.error('Server error'); } setShowBlockModal(false); setSelectedUser(null);
  };

  const confirmDeleteUser = async () => {
    try { const token = getAuthToken(); const res = await axios.delete(`${import.meta.env.VITE_API_URL}api/user/delete/${selectedUser._id}`, { headers: { Authorization: `Bearer ${token}` } }); toast.success(res.data?.msg || 'Deleted'); fetchUsers(); fetchAllUsers(); }
    catch { toast.error('Server error'); } setShowDeleteModal(false); setSelectedUser(null);
  };

  const confirmChangeRole = async () => {
    try { const token = getAuthToken(); const res = await axios.patch(`${import.meta.env.VITE_API_URL}api/user/admin-toggle/${selectedUser._id}`, { newRole: selectedUser.targetRole }, { headers: { Authorization: `Bearer ${token}` } }); toast.success(res.data?.msg || 'Updated'); fetchUsers(); fetchAllUsers(); }
    catch { toast.error('Server error'); } setShowRoleModal(false); setSelectedUser(null);
  };

  const handleConfigureTrial = (user) => {
    setSelectedUser(user);
    setTrialAmount(15);
    setTrialUnit('days');
    setTrialMode(user.sellerSubscription?.trialEndDate ? 'extend' : 'reset');
    setShowTrialModal(true);
  };

  const closeTrialModal = () => {
    if (trialSaving) return;
    setShowTrialModal(false);
    setSelectedUser(null);
  };

  const confirmTrialGrant = async () => {
    const amount = Number(trialAmount);
    if (!Number.isSafeInteger(amount) || amount < 1) {
      toast.error('Enter a positive whole number for the trial duration.');
      return;
    }
    try {
      setTrialSaving(true);
      const token = getAuthToken();
      const res = await axios.patch(
        `${import.meta.env.VITE_API_URL}api/user/seller/${selectedUser._id}/unblock-subscription`,
        { amount, unit: trialUnit, mode: trialMode },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      toast.success(res.data?.msg || 'Seller trial configured');
      await Promise.all([fetchUsers(), fetchAllUsers()]);
      setShowTrialModal(false);
      setSelectedUser(null);
    } catch (error) {
      toast.error(error.response?.data?.msg || 'Failed to configure seller trial');
    } finally {
      setTrialSaving(false);
    }
  };

  const formatDate = (date) => {
    if (!date) return 'Not set';
    const parsed = new Date(date);
    if (Number.isNaN(parsed.getTime())) return 'Not set';
    return parsed.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  };

  const sellerWhatsApp = (user) => user.sellerInfo?.whatsappNumber || user.sellerInfo?.phoneNumber || user.whatsappInfo?.number || '';
  const sellerPlan = (user) => {
    const subscription = user.sellerSubscription;
    if (!subscription) return 'No subscription';
    if (subscription.displayPlanName) return subscription.displayPlanName;
    if (subscription.status === 'trial' || subscription.plan === 'free_trial') return 'Rozare Free Trial';
    if (subscription.plan === 'elite') return subscription.planName || 'Rozare Elite';
    if (subscription.plan === 'starter') return 'Rozare Starter';
    return subscription.planName || 'No plan selected';
  };
  const sellerPlanPeriod = (user) => {
    const subscription = user.sellerSubscription;
    if (!subscription) return { label: '', date: null };
    if (subscription.periodLabel || subscription.periodEndDate) {
      return { label: subscription.periodLabel || 'Period ends', date: subscription.periodEndDate || null };
    }
    if (subscription.status === 'trial' || subscription.plan === 'free_trial') {
      return { label: 'Trial ends', date: subscription.trialEndDate || null };
    }
    if (subscription.status === 'free_period') {
      return { label: 'Free period ends', date: subscription.freePeriodEndDate || subscription.currentPeriodEnd || null };
    }
    return { label: subscription.status === 'active' ? 'Renews' : 'Period ends', date: subscription.currentPeriodEnd || null };
  };
  const sellerPlanStatus = (user) => {
    const subscription = user.sellerSubscription;
    if (!subscription) return '';
    if (subscription.displayStatus) return subscription.displayStatus;
    if (subscription.status === 'trial') return '15-Day Free Trial';
    if (subscription.status === 'free_period') return `${subscription.plan === 'elite' ? 45 : 30}-Day Free Period`;
    return subscription.status?.replace(/_/g, ' ') || '';
  };
  const isSellerSubscriptionBlocked = (user) => user.role === 'seller' && (user.sellerSubscription?.status === 'blocked' || user.store?.isActive === false);
  const hasProtectedPaidEntitlement = (user) => (
    user.role === 'seller'
    && user.sellerSubscription?.plan
    && user.sellerSubscription.plan !== 'free_trial'
    && ['active', 'free_period', 'past_due'].includes(user.sellerSubscription.status)
  );

  const trialPreviewDate = () => {
    const now = new Date();
    const currentEnd = selectedUser?.sellerSubscription?.trialEndDate
      ? new Date(selectedUser.sellerSubscription.trialEndDate)
      : null;
    const start = trialMode === 'extend'
      && currentEnd
      && Number.isFinite(currentEnd.getTime())
      && currentEnd > now
      ? new Date(currentEnd)
      : now;
    const preview = new Date(start);
    if (trialUnit === 'months') {
      const originalDay = preview.getUTCDate();
      preview.setUTCDate(1);
      preview.setUTCMonth(preview.getUTCMonth() + Number(trialAmount || 0));
      const lastDay = new Date(Date.UTC(preview.getUTCFullYear(), preview.getUTCMonth() + 1, 0)).getUTCDate();
      preview.setUTCDate(Math.min(originalDay, lastDay));
    } else {
      preview.setUTCDate(preview.getUTCDate() + Number(trialAmount || 0));
    }
    return Number.isFinite(preview.getTime()) ? formatDate(preview) : 'Invalid duration';
  };

  const totalUsers = allUsers.length;
  const activeUsers = allUsers.filter(u => u.status === 'active').length;
  const adminUsers = allUsers.filter(u => u.role === 'admin').length;
  const sellerUsers = allUsers.filter(u => u.role === 'seller').length;
  const blockedSellers = allUsers.filter(isSellerSubscriptionBlocked).length;

  const statsCards = [
    { label: 'Total Users', value: totalUsers, icon: <Users size={18} />, color: 'hsl(220, 70%, 55%)' },
    { label: 'Active Users', value: activeUsers, icon: <UserCheck size={18} />, color: 'hsl(150, 60%, 45%)' },
    { label: 'Sellers', value: sellerUsers, icon: <Shield size={18} />, color: 'hsl(160, 60%, 40%)' },
    { label: 'Blocked Sellers', value: blockedSellers, icon: <UserX size={18} />, color: 'hsl(0, 72%, 55%)' },
    { label: 'Admins', value: adminUsers, icon: <Shield size={18} />, color: 'hsl(200, 80%, 50%)' },
  ];

  const getRoleBadge = (role) => {
    const styles = { admin: { bg: 'rgba(99, 102, 241, 0.12)', color: 'hsl(240, 60%, 55%)' }, seller: { bg: 'rgba(16, 185, 129, 0.12)', color: 'hsl(160, 60%, 40%)' }, user: { bg: 'rgba(255,255,255,0.08)', color: 'hsl(var(--muted-foreground))' } };
    const s = styles[role] || styles.user;
    return <span className="px-2 py-0.5 text-xs font-semibold rounded-full" style={{ background: s.bg, color: s.color }}>{role}</span>;
  };

  const getStatusBadge = (status) => {
    const isActive = status === 'active';
    return <span className="px-2 py-0.5 text-xs font-semibold rounded-full" style={{ background: isActive ? 'rgba(16, 185, 129, 0.12)' : 'rgba(239, 68, 68, 0.12)', color: isActive ? 'hsl(150, 60%, 40%)' : 'hsl(0, 72%, 55%)' }}>{status}</span>;
  };

  const renderUserActions = (user) => {
    if (currentUser?.email === user.email) {
      return <span className="text-xs font-medium px-2 py-1" style={{ color: 'hsl(var(--muted-foreground))' }}>You</span>;
    }

    return (
      <>
        {user.role === 'seller' && (
          <button onClick={() => handleConfigureTrial(user)} disabled={hasProtectedPaidEntitlement(user)} className="p-2 rounded-xl transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ color: 'hsl(150, 60%, 45%)', background: 'rgba(16, 185, 129, 0.08)' }}
            title={hasProtectedPaidEntitlement(user) ? 'Paid-plan entitlement is active' : 'Configure seller trial'}>
            <CalendarDays className="w-4 h-4" />
          </button>
        )}
        <button onClick={() => handleBlockUser(user)} className="p-2 rounded-xl transition-colors"
          style={user.status === 'active' ? { color: 'hsl(0, 72%, 55%)', background: 'rgba(239, 68, 68, 0.08)' } : { color: 'hsl(150, 60%, 45%)', background: 'rgba(16, 185, 129, 0.08)' }}
          title={user.status === 'active' ? 'Block User' : 'Unblock User'}>
          {user.status === 'active' ? <UserX className="w-4 h-4" /> : <UserCheck className="w-4 h-4" />}
        </button>
        <button onClick={() => handleChangeRole(user)} className="p-2 rounded-xl transition-colors"
          style={{ color: 'hsl(220, 70%, 55%)', background: 'rgba(99, 102, 241, 0.08)' }}
          title="Change Role">
          {user.role === 'admin' ? <ShieldOff className="w-4 h-4" /> : <Shield className="w-4 h-4" />}
        </button>
        <button onClick={() => handleDeleteUser(user)} className="p-2 rounded-xl transition-colors"
          style={{ color: 'hsl(0, 72%, 55%)', background: 'rgba(239, 68, 68, 0.08)' }} title="Delete User">
          <Trash2 className="w-4 h-4" />
        </button>
      </>
    );
  };

  return (
    <div className="min-h-screen p-4 md:p-6 mt-4 md:mt-8">
      <div className="max-w-[1600px] mx-auto">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-8">
          <Motion.h1 className="text-2xl md:text-3xl font-extrabold tracking-tight flex items-center gap-2" initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }} style={{ color: 'hsl(var(--foreground))' }}>
            <UserCog className="w-7 h-7 md:w-8 md:h-8" /> User Management
          </Motion.h1>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-4 mb-8">
          {statsCards.map((card, i) => (
            <Motion.div key={i} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.1 }} whileHover={{ y: -3 }} className="glass-card p-5">
              <div className="flex justify-between items-center">
                <div>
                  <p className="text-xs font-medium mb-1" style={{ color: 'hsl(var(--muted-foreground))' }}>{card.label}</p>
                  <p className="text-2xl font-extrabold" style={{ color: 'hsl(var(--foreground))' }}>{card.value}</p>
                </div>
                <div className="glass-inner p-2.5 rounded-xl" style={{ color: card.color }}>{card.icon}</div>
              </div>
            </Motion.div>
          ))}
        </div>

        {/* Filters */}
        <Motion.div className="glass-panel p-4 sm:p-6 mb-6" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.4 }}>
          <div className="flex flex-col xl:flex-row gap-4 justify-between">
            <div className="search-input-wrapper flex-1 min-w-0 xl:max-w-xl">
              <div className="search-input-icon"><Search size={16} /></div>
              <input type="text" placeholder="Search by username or email..." className="glass-input glass-input-search" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 xl:w-auto">
              <div className="flex items-center gap-2 min-w-0">
                <Filter size={16} style={{ color: 'hsl(var(--muted-foreground))' }} />
                <select className="glass-input cursor-pointer font-medium text-sm min-w-0" value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}>
                  <option value="all">All Roles</option><option value="admin">Admin</option><option value="seller">Seller</option><option value="user">User</option>
                </select>
              </div>
              <select className="glass-input cursor-pointer font-medium text-sm min-w-0" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                <option value="all">All Status</option><option value="active">Active</option><option value="blocked">Blocked</option>
              </select>
            </div>
          </div>
        </Motion.div>

        {/* Users List */}
        <Motion.div className="space-y-3" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.5 }}>
          {loading ? (
            <div className='glass-panel flex justify-center items-center min-h-[250px]'><Loader /></div>
          ) : users.length === 0 ? (
            <div className="w-full py-12 flex flex-col justify-center items-center">
              <div className="glass-inner p-4 rounded-2xl mb-3"><AlertCircle size={32} style={{ color: 'hsl(var(--muted-foreground))' }} /></div>
              <p className="text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>No users found matching your criteria</p>
            </div>
          ) : (
            <AnimatePresence>
              {users.map((user, index) => (
                <Motion.article
                  key={user._id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.25, delay: index * 0.03 }}
                  className="glass-panel p-4 sm:p-5 overflow-hidden"
                >
                  <div className="flex flex-col xl:flex-row xl:items-start gap-4">
                    <div className="flex items-start gap-3 min-w-0 xl:w-[260px]">
                      <div className="shrink-0 h-11 w-11 rounded-2xl glass-inner flex items-center justify-center">
                        <User className="h-5 w-5" style={{ color: 'hsl(var(--primary))' }} />
                      </div>
                      <div className="min-w-0">
                        <div className="text-sm font-semibold truncate" style={{ color: 'hsl(var(--foreground))' }}>{user.username}</div>
                        <div className="text-xs flex items-center gap-1 mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                          <CalendarDays size={12} /> Joined {formatDate(user.joinedAt || user.createdAt)}
                        </div>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {getRoleBadge(user.role)}
                          {getStatusBadge(user.status)}
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-[minmax(220px,1.1fr)_minmax(210px,1fr)_minmax(220px,1fr)] gap-4 flex-1 min-w-0">
                      <div className="min-w-0">
                        <p className="text-[11px] uppercase tracking-wider font-semibold mb-1" style={{ color: 'hsl(var(--muted-foreground))' }}>Contact</p>
                        <div className="text-sm flex items-center gap-1.5 min-w-0" style={{ color: 'hsl(var(--foreground))' }}>
                          <Mail size={13} className="shrink-0" /> <span className="truncate">{user.email}</span>
                        </div>
                        {user.role === 'seller' && (
                          <div className="text-xs flex items-center gap-1.5 mt-1 min-w-0" style={{ color: 'hsl(var(--muted-foreground))' }}>
                            <MessageCircle size={13} className="shrink-0" /> <span className="truncate">{sellerWhatsApp(user) || 'No WhatsApp linked'}</span>
                          </div>
                        )}
                      </div>

                      <div className="min-w-0">
                        <p className="text-[11px] uppercase tracking-wider font-semibold mb-1" style={{ color: 'hsl(var(--muted-foreground))' }}>Seller Plan</p>
                        {user.role === 'seller' ? (
                          <>
                            <div className="text-sm font-semibold flex items-center gap-1.5 capitalize min-w-0" style={{ color: 'hsl(var(--foreground))' }}>
                              <CreditCard size={13} className="shrink-0" /> <span className="truncate">{sellerPlan(user)}</span>
                            </div>
                            {sellerPlanPeriod(user).date && (
                              <div className="text-xs flex items-center gap-1.5 mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                <Clock size={12} /> {sellerPlanPeriod(user).label} {formatDate(sellerPlanPeriod(user).date)}
                              </div>
                            )}
                            {sellerPlanStatus(user) && <div className="text-[11px] mt-1" style={{ color: isSellerSubscriptionBlocked(user) ? 'hsl(0, 72%, 55%)' : 'hsl(150, 60%, 40%)' }}>{sellerPlanStatus(user)}</div>}
                          </>
                        ) : <span className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>Not a seller</span>}
                      </div>

                      <div className="min-w-0">
                        <p className="text-[11px] uppercase tracking-wider font-semibold mb-1" style={{ color: 'hsl(var(--muted-foreground))' }}>Store</p>
                        {user.role === 'seller' ? (
                          <>
                            <div className="text-sm font-semibold flex items-center gap-1.5 min-w-0" style={{ color: 'hsl(var(--foreground))' }}>
                              <Store size={13} className="shrink-0" /> <span className="truncate">{user.store?.storeName || 'No store'}</span>
                            </div>
                            <div className="text-xs mt-1 font-mono break-all" style={{ color: 'hsl(var(--muted-foreground))' }}>{user.store?.storeSlug ? `${user.store.storeSlug}.rozare.com` : 'No subdomain'}</div>
                            <div className="text-[11px] mt-1" style={{ color: user.store?.isActive === false ? 'hsl(0, 72%, 55%)' : 'hsl(150, 60%, 40%)' }}>
                              {user.store?.isActive === false ? `Blocked ${formatDate(user.store?.blockedAt)}` : 'Store active'}
                            </div>
                          </>
                        ) : <span className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>-</span>}
                      </div>
                    </div>

                    <div className="flex xl:flex-col flex-wrap gap-2 xl:items-end xl:min-w-[48px]">
                      {renderUserActions(user)}
                    </div>
                  </div>
                </Motion.article>
              ))}
            </AnimatePresence>
          )}
        </Motion.div>
      </div>

      {/* Modals */}
      {[
        { show: showBlockModal, user: selectedUser, title: selectedUser?.status === 'active' ? 'Block User' : 'Unblock User', message: `Are you sure you want to ${selectedUser?.status === 'active' ? 'block' : 'unblock'} ${selectedUser?.username}?`, onConfirm: confirmBlockUser, confirmStyle: selectedUser?.status === 'active' ? { background: 'hsl(0, 72%, 55%)' } : { background: 'hsl(150, 60%, 45%)' }, onClose: () => setShowBlockModal(false) },
        { show: showDeleteModal, user: selectedUser, title: 'Delete User', message: `Are you sure you want to delete ${selectedUser?.username}? This cannot be undone.`, onConfirm: confirmDeleteUser, confirmStyle: { background: 'hsl(0, 72%, 55%)' }, onClose: () => setShowDeleteModal(false) },
      ].map((modal, i) => (
        <AnimatePresence key={i}>
          {modal.show && modal.user && (
            <Motion.div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4 z-50" onClick={modal.onClose} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <Motion.div className="glass-panel max-w-md w-full p-6" onClick={e => e.stopPropagation()} initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }}>
                <h3 className="text-lg font-semibold mb-4" style={{ color: 'hsl(var(--foreground))' }}>{modal.title}</h3>
                <p className="text-sm mb-6" style={{ color: 'hsl(var(--muted-foreground))' }}>{modal.message}</p>
                <div className="flex justify-end space-x-3">
                  <button onClick={modal.onClose} className="px-4 py-2 rounded-xl glass-inner font-medium" style={{ color: 'hsl(var(--foreground))' }}>Cancel</button>
                  <button onClick={modal.onConfirm} className="px-4 py-2 rounded-xl text-white font-medium" style={modal.confirmStyle}>Confirm</button>
                </div>
              </Motion.div>
            </Motion.div>
          )}
        </AnimatePresence>
      ))}

      {/* Role Modal */}
      <AnimatePresence>
        {showRoleModal && selectedUser && (
          <Motion.div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4 z-50" onClick={() => setShowRoleModal(false)} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <Motion.div className="glass-panel max-w-md w-full p-6" onClick={e => e.stopPropagation()} initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }}>
              <h3 className="text-lg font-semibold mb-4" style={{ color: 'hsl(var(--foreground))' }}>Change User Role</h3>
              <p className="text-sm mb-2" style={{ color: 'hsl(var(--muted-foreground))' }}>Current role: <span className="font-semibold">{selectedUser.role}</span></p>
              <p className="text-sm mb-6" style={{ color: 'hsl(var(--muted-foreground))' }}>Change {selectedUser.username}'s role to:</p>
              <div className="space-y-2 mb-6">
                {[
                  { role: 'user', label: 'User', icon: <User size={16} />, style: { background: 'rgba(255,255,255,0.05)', color: 'hsl(var(--foreground))' } },
                  { role: 'seller', label: 'Seller', icon: <Store size={16} />, style: { background: 'rgba(16, 185, 129, 0.08)', color: 'hsl(150, 60%, 40%)' } },
                  { role: 'admin', label: 'Admin', icon: <Shield size={16} />, style: { background: 'rgba(99, 102, 241, 0.08)', color: 'hsl(220, 70%, 55%)' } },
                ].map(r => (
                  <button key={r.role} onClick={() => { selectedUser.targetRole = r.role; confirmChangeRole(); }} disabled={selectedUser.role === r.role}
                    className="w-full px-4 py-3 rounded-xl text-left flex items-center gap-3 transition-all disabled:opacity-40 disabled:cursor-not-allowed font-medium text-sm"
                    style={selectedUser.role === r.role ? { background: 'rgba(255,255,255,0.03)', color: 'hsl(var(--muted-foreground))' } : r.style}>
                    {r.icon} {r.label} {selectedUser.role === r.role && '(Current)'}
                  </button>
                ))}
              </div>
              <div className="flex justify-end">
                <button onClick={() => setShowRoleModal(false)} className="px-6 py-2 rounded-xl glass-inner font-medium" style={{ color: 'hsl(var(--foreground))' }}>Cancel</button>
              </div>
            </Motion.div>
          </Motion.div>
        )}
      </AnimatePresence>

      {/* Seller Trial Modal */}
      <AnimatePresence>
        {showTrialModal && selectedUser && (
          <Motion.div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4 z-50" onClick={closeTrialModal} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <Motion.div className="glass-panel max-w-lg w-full p-6" onClick={e => e.stopPropagation()} initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }}>
              <div className="flex items-start gap-3 mb-5">
                <div className="glass-inner p-2.5 rounded-xl"><CalendarDays className="w-5 h-5" style={{ color: 'hsl(var(--primary))' }} /></div>
                <div>
                  <h3 className="text-lg font-semibold" style={{ color: 'hsl(var(--foreground))' }}>Configure seller trial</h3>
                  <p className="text-sm mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                    {selectedUser.username} · {selectedUser.store?.storeName || 'No store created'}
                  </p>
                </div>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'hsl(var(--muted-foreground))' }}>Duration</label>
                  <div className="grid grid-cols-[1fr_140px] gap-3 mt-2">
                    <input type="number" min="1" max={trialUnit === 'months' ? '120' : '3650'} step="1" value={trialAmount} onChange={e => setTrialAmount(e.target.value)} className="glass-input" aria-label="Trial duration" />
                    <select value={trialUnit} onChange={e => setTrialUnit(e.target.value)} className="glass-input cursor-pointer" aria-label="Trial duration unit">
                      <option value="days">Days</option>
                      <option value="months">Months</option>
                    </select>
                  </div>
                  <p className="text-xs mt-1.5" style={{ color: 'hsl(var(--muted-foreground))' }}>Months use calendar dates, so one month is not forced to 30 days.</p>
                </div>

                <div>
                  <label className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'hsl(var(--muted-foreground))' }}>How to apply it</label>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2">
                    {[
                      { value: 'reset', title: 'Reset from today', detail: 'Start the selected duration now.' },
                      { value: 'extend', title: 'Extend current trial', detail: 'Add time after a future trial end; otherwise start now.' },
                    ].map(option => (
                      <button key={option.value} type="button" onClick={() => setTrialMode(option.value)} className="p-3 rounded-xl text-left transition-colors" style={trialMode === option.value ? { background: 'rgba(99, 102, 241, 0.12)', border: '1px solid rgba(99, 102, 241, 0.3)' } : { background: 'rgba(255,255,255,0.03)', border: '1px solid var(--glass-border)' }}>
                        <span className="text-sm font-semibold block" style={{ color: 'hsl(var(--foreground))' }}>{option.title}</span>
                        <span className="text-xs block mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>{option.detail}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="glass-inner rounded-xl p-3 text-sm flex items-center justify-between gap-3">
                  <span style={{ color: 'hsl(var(--muted-foreground))' }}>New trial end</span>
                  <span className="font-semibold" style={{ color: 'hsl(var(--foreground))' }}>{trialPreviewDate()}</span>
                </div>
                <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>
                  Saving reactivates the seller and store, clears expired-trial blocks, and grants a Rozare Free Trial. An active paid-plan entitlement must be ended first.
                </p>
              </div>

              <div className="flex justify-end gap-3 mt-6">
                <button onClick={closeTrialModal} disabled={trialSaving} className="px-4 py-2 rounded-xl glass-inner font-medium disabled:opacity-50" style={{ color: 'hsl(var(--foreground))' }}>Cancel</button>
                <button onClick={confirmTrialGrant} disabled={trialSaving} className="px-4 py-2 rounded-xl text-white font-medium flex items-center gap-2 disabled:opacity-50" style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))' }}>
                  {trialSaving && <Loader2 className="w-4 h-4 animate-spin" />} Apply trial
                </button>
              </div>
            </Motion.div>
          </Motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default UserManagement;
