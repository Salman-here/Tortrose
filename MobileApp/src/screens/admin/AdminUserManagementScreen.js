/**
 * AdminUserManagementScreen - production mobile parity with web UserManagement.
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet, Alert,
  RefreshControl, TextInput, Modal, ScrollView, ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api, { API_ENDPOINTS } from '../../config/api';
import Loader from '../../components/common/Loader';
import { EmptySearch } from '../../components/common/EmptyState';
import GlassBackground from '../../components/common/GlassBackground';
import GlassPanel from '../../components/common/GlassPanel';
import { spacing, fontSize, borderRadius, fontWeight, typography } from '../../styles/theme';
import { useTheme } from '../../contexts/ThemeContext';
import { useAuth } from '../../contexts/AuthContext';

const ROLE_TABS = [
  { id: 'all', label: 'All' },
  { id: 'user', label: 'Users' },
  { id: 'seller', label: 'Sellers' },
  { id: 'admin', label: 'Admins' },
];

const STATUS_TABS = [
  { id: 'all', label: 'All status' },
  { id: 'active', label: 'Active' },
  { id: 'blocked', label: 'Blocked' },
];

const formatDate = (date) => {
  if (!date) return 'Not set';
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return 'Not set';
  return parsed.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};

const displayName = (user) => user?.username || user?.name || 'Unnamed user';
const sellerWhatsApp = (user) => user?.sellerInfo?.whatsappNumber || user?.sellerInfo?.phoneNumber || user?.whatsappInfo?.number || '';
const sellerPlan = (user) => user?.sellerSubscription?.planName || (user?.sellerSubscription?.plan ? user.sellerSubscription.plan.replace(/_/g, ' ') : 'No plan');
const sellerPlanExpiry = (user) => user?.sellerSubscription?.currentPeriodEnd || user?.sellerSubscription?.freePeriodEndDate || user?.sellerSubscription?.trialEndDate || null;
const isSellerSubscriptionBlocked = (user) => user?.role === 'seller' && (user?.sellerSubscription?.status === 'blocked' || user?.store?.isActive === false);

export const filterUsers = (users, role, searchQuery, status = 'all') => {
  if (!Array.isArray(users)) return [];
  let filtered = users;
  if (role && role !== 'all') filtered = filtered.filter(user => user.role === role);
  if (status && status !== 'all') filtered = filtered.filter(user => (user.status || 'active') === status);
  if (searchQuery?.trim()) {
    const query = searchQuery.toLowerCase().trim();
    filtered = filtered.filter(user =>
      displayName(user).toLowerCase().includes(query) ||
      (user.email || '').toLowerCase().includes(query) ||
      (sellerWhatsApp(user) || '').toLowerCase().includes(query) ||
      (user.store?.storeName || '').toLowerCase().includes(query)
    );
  }
  return filtered;
};

export default function AdminUserManagementScreen() {
  const { palette } = useTheme();
  const styles = buildStyles(palette);
  const { currentUser } = useAuth();

  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [selectedUser, setSelectedUser] = useState(null);
  const [modalVisible, setModalVisible] = useState(false);
  const [actionLoadingId, setActionLoadingId] = useState('');

  const getRoleColor = useCallback((role) => {
    switch (role) {
      case 'admin': return palette.colors.error;
      case 'seller': return palette.colors.success;
      default: return palette.colors.info;
    }
  }, [palette.colors.error, palette.colors.info, palette.colors.success]);

  const fetchUsers = useCallback(async () => {
    try {
      const res = await api.get(API_ENDPOINTS.USER.GET_ALL);
      const userData = res.data?.users || res.data || [];
      setUsers(Array.isArray(userData) ? userData : []);
    } catch (e) {
      setUsers([]);
      Alert.alert('Error', e.response?.data?.msg || 'Failed to fetch users');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { fetchUsers(); }, [fetchUsers]);

  const onRefresh = useCallback(() => { setRefreshing(true); fetchUsers(); }, [fetchUsers]);
  const handleUserPress = useCallback((user) => { setSelectedUser(user); setModalVisible(true); }, []);

  const refreshAfterAction = async () => {
    await fetchUsers();
  };

  const changeUserRole = async (user, newRole) => {
    if (!user || user.role === newRole) return;
    try {
      setActionLoadingId(user._id);
      await api.patch(`${API_ENDPOINTS.USER.ADMIN_TOGGLE}/${user._id}`, { newRole });
      Alert.alert('Success', `${displayName(user)} is now ${newRole}`);
      setModalVisible(false);
      await refreshAfterAction();
    } catch (e) {
      Alert.alert('Error', e.response?.data?.msg || 'Failed to update role');
    } finally {
      setActionLoadingId('');
    }
  };

  const toggleBlockUser = (user) => {
    if (!user) return;
    const next = user.status === 'active' ? 'block' : 'unblock';
    Alert.alert(
      `${next === 'block' ? 'Block' : 'Unblock'} user`,
      `Are you sure you want to ${next} ${displayName(user)}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: next === 'block' ? 'Block' : 'Unblock',
          style: next === 'block' ? 'destructive' : 'default',
          onPress: async () => {
            try {
              setActionLoadingId(user._id);
              await api.patch(`${API_ENDPOINTS.USER.BLOCK_TOGGLE}/${user._id}`);
              await refreshAfterAction();
            } catch (e) {
              Alert.alert('Error', e.response?.data?.msg || 'Failed to update user status');
            } finally {
              setActionLoadingId('');
            }
          },
        },
      ]
    );
  };

  const unblockSeller = (user) => {
    if (!user) return;
    Alert.alert(
      'Unblock seller store',
      `Unblock ${displayName(user)} and extend the trial by 15 days?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Unblock',
          onPress: async () => {
            try {
              setActionLoadingId(user._id);
              await api.patch(`/api/user/seller/${user._id}/unblock-subscription`, { extensionDays: 15 });
              await refreshAfterAction();
            } catch (e) {
              Alert.alert('Error', e.response?.data?.msg || 'Failed to unblock seller');
            } finally {
              setActionLoadingId('');
            }
          },
        },
      ]
    );
  };

  const deleteUser = (user) => {
    if (!user) return;
    Alert.alert(
      'Delete user',
      `Delete ${displayName(user)}? This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              setActionLoadingId(user._id);
              await api.delete(`${API_ENDPOINTS.USER.DELETE}/${user._id}`);
              setModalVisible(false);
              await refreshAfterAction();
            } catch (e) {
              Alert.alert('Error', e.response?.data?.msg || 'Failed to delete user');
            } finally {
              setActionLoadingId('');
            }
          },
        },
      ]
    );
  };

  const filteredUsers = useMemo(() => filterUsers(users, activeTab, searchQuery, statusFilter), [users, activeTab, searchQuery, statusFilter]);
  const stats = useMemo(() => ({
    total: users.length,
    active: users.filter(u => u.status === 'active').length,
    sellers: users.filter(u => u.role === 'seller').length,
    blockedSellers: users.filter(isSellerSubscriptionBlocked).length,
    admins: users.filter(u => u.role === 'admin').length,
  }), [users]);

  const statCards = [
    { label: 'Total', value: stats.total, icon: 'people-outline', color: palette.colors.primary },
    { label: 'Active', value: stats.active, icon: 'person-add-outline', color: palette.colors.success },
    { label: 'Sellers', value: stats.sellers, icon: 'storefront-outline', color: palette.colors.info },
    { label: 'Blocked', value: stats.blockedSellers, icon: 'ban-outline', color: palette.colors.error },
    { label: 'Admins', value: stats.admins, icon: 'shield-checkmark-outline', color: palette.colors.secondary },
  ];

  const renderHeader = () => (
    <View style={styles.headerContainer}>
      <GlassPanel variant="floating" style={styles.titleRow}>
        <View style={styles.titleIcon}><Ionicons name="people-outline" size={24} color="white" /></View>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>User Management</Text>
          <Text style={styles.subtitle}>Accounts, sellers, subscriptions, and store status</Text>
        </View>
      </GlassPanel>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.statsRow}>
        {statCards.map(card => (
          <GlassPanel key={card.label} variant="card" style={styles.statCard}>
            <View style={[styles.statIcon, { backgroundColor: `${card.color}18` }]}>
              <Ionicons name={card.icon} size={18} color={card.color} />
            </View>
            <Text style={styles.statValue}>{card.value}</Text>
            <Text style={styles.statLabel}>{card.label}</Text>
          </GlassPanel>
        ))}
      </ScrollView>

      <View style={styles.searchContainer}>
        <Ionicons name="search" size={20} color={palette.colors.textSecondary} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search name, email, WhatsApp, or store..."
          placeholderTextColor={palette.colors.textSecondary}
          value={searchQuery}
          onChangeText={setSearchQuery}
          returnKeyType="search"
        />
        {searchQuery.length > 0 && <TouchableOpacity onPress={() => setSearchQuery('')}><Ionicons name="close-circle" size={20} color={palette.colors.textSecondary} /></TouchableOpacity>}
      </View>

      <FlatList
        horizontal
        data={ROLE_TABS}
        keyExtractor={i => i.id}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.tabsContainer}
        renderItem={({ item }) => {
          const isActive = activeTab === item.id;
          const count = item.id === 'all' ? users.length : users.filter(u => u.role === item.id).length;
          return (
            <TouchableOpacity style={[styles.tab, isActive && styles.tabActive]} onPress={() => setActiveTab(item.id)} activeOpacity={0.7}>
              <Text style={[styles.tabText, isActive && styles.tabTextActive]}>{item.label}</Text>
              <View style={[styles.tabBadge, isActive && styles.tabBadgeActive]}>
                <Text style={[styles.tabBadgeText, isActive && styles.tabBadgeTextActive]}>{count}</Text>
              </View>
            </TouchableOpacity>
          );
        }}
      />

      <FlatList
        horizontal
        data={STATUS_TABS}
        keyExtractor={i => i.id}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.tabsContainer}
        renderItem={({ item }) => {
          const isActive = statusFilter === item.id;
          return (
            <TouchableOpacity style={[styles.statusTab, isActive && styles.statusTabActive]} onPress={() => setStatusFilter(item.id)} activeOpacity={0.7}>
              <Text style={[styles.statusTabText, isActive && styles.statusTabTextActive]}>{item.label}</Text>
            </TouchableOpacity>
          );
        }}
      />

      <Text style={styles.resultsText}>Showing <Text style={styles.resultsCount}>{filteredUsers.length}</Text> users</Text>
    </View>
  );

  const renderUser = ({ item }) => {
    const blockedSeller = isSellerSubscriptionBlocked(item);
    const isSelf = currentUser?.email === item.email || currentUser?._id === item._id;
    const actionBusy = actionLoadingId === item._id;
    return (
      <GlassPanel variant="card" style={styles.userCard}>
        <TouchableOpacity style={styles.userCardInner} onPress={() => handleUserPress(item)} activeOpacity={0.75}>
          <View style={[styles.avatar, { backgroundColor: `${getRoleColor(item.role)}25` }]}>
            <Text style={[styles.avatarText, { color: getRoleColor(item.role) }]}>{displayName(item).charAt(0).toUpperCase()}</Text>
          </View>
          <View style={styles.userInfo}>
            <View style={styles.nameLine}>
              <Text style={styles.userName} numberOfLines={1}>{displayName(item)}</Text>
              <View style={[styles.roleBadge, { backgroundColor: `${getRoleColor(item.role)}18` }]}>
                <Text style={[styles.roleText, { color: getRoleColor(item.role) }]}>{item.role}</Text>
              </View>
            </View>
            <Text style={styles.userEmail} numberOfLines={1}>{item.email || 'No email'}</Text>
            <Text style={styles.metaLine}>Joined {formatDate(item.createdAt)} - {(item.status || 'active')}</Text>

            {item.role === 'seller' && (
              <View style={styles.sellerBox}>
                <Text style={styles.sellerTitle} numberOfLines={1}>{item.store?.storeName || 'No store'}</Text>
                <Text style={styles.sellerMeta} numberOfLines={1}>WhatsApp: {sellerWhatsApp(item) || 'Not linked'}</Text>
                <Text style={styles.sellerMeta} numberOfLines={1}>Plan: {sellerPlan(item)} - Expires {formatDate(sellerPlanExpiry(item))}</Text>
                <Text style={[styles.sellerStatus, { color: blockedSeller ? palette.colors.error : palette.colors.success }]}>
                  {blockedSeller ? `Blocked ${formatDate(item.store?.blockedAt || item.sellerSubscription?.blockedAt)}` : 'Store active'}
                </Text>
              </View>
            )}
          </View>
        </TouchableOpacity>

        <View style={styles.actionRow}>
          {actionBusy ? (
            <ActivityIndicator size="small" color={palette.colors.primary} />
          ) : (
            <>
              {blockedSeller && !isSelf && (
                <TouchableOpacity style={[styles.actionBtn, { backgroundColor: `${palette.colors.success}15` }]} onPress={() => unblockSeller(item)}>
                  <Ionicons name="refresh-circle-outline" size={18} color={palette.colors.success} />
                  <Text style={[styles.actionText, { color: palette.colors.success }]}>Unblock seller</Text>
                </TouchableOpacity>
              )}
              {!isSelf && (
                <>
                  <TouchableOpacity style={[styles.iconBtn, { backgroundColor: item.status === 'active' ? `${palette.colors.error}12` : `${palette.colors.success}15` }]} onPress={() => toggleBlockUser(item)}>
                    <Ionicons name={item.status === 'active' ? 'ban-outline' : 'checkmark-circle-outline'} size={18} color={item.status === 'active' ? palette.colors.error : palette.colors.success} />
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.iconBtn, { backgroundColor: `${palette.colors.error}12` }]} onPress={() => deleteUser(item)}>
                    <Ionicons name="trash-outline" size={18} color={palette.colors.error} />
                  </TouchableOpacity>
                </>
              )}
            </>
          )}
        </View>
      </GlassPanel>
    );
  };

  if (loading) return <GlassBackground><Loader fullScreen message="Loading users..." /></GlassBackground>;

  return (
    <GlassBackground>
      <FlatList
        data={filteredUsers}
        renderItem={renderUser}
        keyExtractor={i => i._id}
        contentContainerStyle={styles.list}
        ListHeaderComponent={renderHeader}
        ListEmptyComponent={searchQuery ? <EmptySearch query={searchQuery} onClear={() => setSearchQuery('')} /> : null}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={palette.colors.primary} />}
        showsVerticalScrollIndicator={false}
      />

      <Modal visible={modalVisible} animationType="slide" transparent onRequestClose={() => setModalVisible(false)}>
        <View style={styles.modalOverlay}>
          <GlassPanel variant="strong" style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>User Details</Text>
              <TouchableOpacity onPress={() => setModalVisible(false)}><Ionicons name="close" size={24} color={palette.colors.text} /></TouchableOpacity>
            </View>
            {selectedUser && (
              <ScrollView showsVerticalScrollIndicator={false}>
                <View style={styles.modalUserInfo}>
                  <View style={[styles.modalAvatar, { backgroundColor: `${getRoleColor(selectedUser.role)}25` }]}>
                    <Text style={[styles.modalAvatarText, { color: getRoleColor(selectedUser.role) }]}>{displayName(selectedUser).charAt(0).toUpperCase()}</Text>
                  </View>
                  <Text style={styles.modalUserName}>{displayName(selectedUser)}</Text>
                  <Text style={styles.modalUserEmail}>{selectedUser.email}</Text>
                </View>

                <InfoRow label="Joined" value={formatDate(selectedUser.createdAt)} styles={styles} />
                <InfoRow label="Status" value={selectedUser.status || 'active'} styles={styles} />
                <InfoRow label="Currency" value={selectedUser.currency || 'Not set'} styles={styles} />
                {selectedUser.role === 'seller' && (
                  <>
                    <InfoRow label="WhatsApp" value={sellerWhatsApp(selectedUser) || 'Not linked'} styles={styles} />
                    <InfoRow label="Plan" value={sellerPlan(selectedUser)} styles={styles} />
                    <InfoRow label="Plan expiry" value={formatDate(sellerPlanExpiry(selectedUser))} styles={styles} />
                    <InfoRow label="Store" value={selectedUser.store?.storeName || 'No store'} styles={styles} />
                    <InfoRow label="Store slug" value={selectedUser.store?.storeSlug || 'Not set'} styles={styles} />
                  </>
                )}

                {currentUser?.email !== selectedUser.email && currentUser?._id !== selectedUser._id && (
                  <>
                    <Text style={styles.modalSectionTitle}>Change Role</Text>
                    <View style={styles.roleOptions}>
                      {['user', 'seller', 'admin'].map(role => (
                        <TouchableOpacity
                          key={role}
                          style={[styles.roleOption, selectedUser.role === role && { borderColor: getRoleColor(role), backgroundColor: `${getRoleColor(role)}15` }]}
                          onPress={() => changeUserRole(selectedUser, role)}
                          disabled={actionLoadingId === selectedUser._id || selectedUser.role === role}
                          activeOpacity={0.7}
                        >
                          <Text style={[styles.roleOptionText, selectedUser.role === role && { color: getRoleColor(role) }]}>{role.charAt(0).toUpperCase() + role.slice(1)}</Text>
                          {selectedUser.role === role && <Ionicons name="checkmark" size={18} color={getRoleColor(role)} />}
                        </TouchableOpacity>
                      ))}
                    </View>
                  </>
                )}
              </ScrollView>
            )}
          </GlassPanel>
        </View>
      </Modal>
    </GlassBackground>
  );
}

function InfoRow({ label, value, styles }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue} numberOfLines={2}>{value || 'Not set'}</Text>
    </View>
  );
}

const buildStyles = (p) => StyleSheet.create({
  headerContainer: { paddingBottom: spacing.md, marginBottom: spacing.sm },
  titleRow: { flexDirection: 'row', alignItems: 'center', margin: spacing.lg, marginBottom: spacing.md, padding: spacing.lg },
  titleIcon: { width: 44, height: 44, borderRadius: borderRadius.lg, backgroundColor: p.colors.primary, justifyContent: 'center', alignItems: 'center', marginRight: spacing.md },
  title: { ...typography.h3, color: p.colors.text },
  subtitle: { ...typography.bodySmall, color: p.colors.textSecondary },
  statsRow: { paddingHorizontal: spacing.lg, gap: spacing.sm, paddingBottom: spacing.md },
  statCard: { width: 112, padding: spacing.md },
  statIcon: { width: 34, height: 34, borderRadius: 12, alignItems: 'center', justifyContent: 'center', marginBottom: spacing.sm },
  statValue: { ...typography.h3, color: p.colors.text },
  statLabel: { ...typography.caption, color: p.colors.textSecondary },
  searchContainer: { flexDirection: 'row', alignItems: 'center', backgroundColor: p.glass.bgSubtle, borderRadius: borderRadius.xl, paddingHorizontal: spacing.md, marginHorizontal: spacing.lg, marginBottom: spacing.md, minHeight: 48, borderWidth: 1, borderColor: p.glass.borderSubtle },
  searchInput: { flex: 1, marginLeft: spacing.sm, fontSize: fontSize.md, color: p.colors.text },
  tabsContainer: { paddingHorizontal: spacing.lg, gap: spacing.sm, marginBottom: spacing.sm },
  tab: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: borderRadius.full, backgroundColor: p.glass.bgSubtle, gap: spacing.xs, borderWidth: 1, borderColor: p.glass.borderSubtle },
  tabActive: { backgroundColor: p.colors.primary, borderColor: p.colors.primary },
  tabText: { ...typography.bodySmall, fontWeight: fontWeight.medium, color: p.colors.textSecondary },
  tabTextActive: { color: 'white' },
  tabBadge: { minWidth: 20, height: 20, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.15)', justifyContent: 'center', alignItems: 'center', paddingHorizontal: spacing.xs },
  tabBadgeActive: { backgroundColor: 'rgba(255,255,255,0.3)' },
  tabBadgeText: { ...typography.caption, fontWeight: fontWeight.bold, color: p.colors.textSecondary },
  tabBadgeTextActive: { color: 'white' },
  statusTab: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: borderRadius.full, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  statusTabActive: { backgroundColor: `${p.colors.info}18`, borderColor: p.colors.info },
  statusTabText: { ...typography.bodySmall, color: p.colors.textSecondary, fontWeight: fontWeight.medium },
  statusTabTextActive: { color: p.colors.info },
  resultsText: { ...typography.bodySmall, color: p.colors.textSecondary, paddingHorizontal: spacing.lg, paddingTop: spacing.xs },
  resultsCount: { fontWeight: fontWeight.bold, color: p.colors.text },
  list: { paddingHorizontal: spacing.md, paddingBottom: 100, flexGrow: 1 },
  userCard: { marginBottom: spacing.md, padding: spacing.md },
  userCardInner: { flexDirection: 'row', alignItems: 'flex-start' },
  avatar: { width: 52, height: 52, borderRadius: 26, justifyContent: 'center', alignItems: 'center', marginRight: spacing.md },
  avatarText: { fontSize: fontSize.xl, fontWeight: fontWeight.bold },
  userInfo: { flex: 1, minWidth: 0 },
  nameLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  userName: { ...typography.bodySemibold, color: p.colors.text, marginBottom: 2, flex: 1 },
  userEmail: { ...typography.bodySmall, color: p.colors.textSecondary },
  metaLine: { ...typography.caption, color: p.colors.textLight, marginTop: 3 },
  roleBadge: { paddingHorizontal: spacing.sm, paddingVertical: 3, borderRadius: borderRadius.full },
  roleText: { ...typography.caption, fontWeight: fontWeight.bold, textTransform: 'capitalize' },
  sellerBox: { marginTop: spacing.sm, padding: spacing.sm, borderRadius: borderRadius.lg, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  sellerTitle: { ...typography.bodySmall, color: p.colors.text, fontWeight: fontWeight.bold },
  sellerMeta: { ...typography.caption, color: p.colors.textSecondary, marginTop: 2 },
  sellerStatus: { ...typography.caption, marginTop: 3, fontWeight: fontWeight.bold },
  actionRow: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: spacing.sm, marginTop: spacing.sm },
  actionBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs, borderRadius: borderRadius.full },
  actionText: { ...typography.caption, fontWeight: fontWeight.bold },
  iconBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  modalOverlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' },
  modalContent: { maxHeight: '86%', borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: spacing.lg },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.lg },
  modalTitle: { ...typography.h3, color: p.colors.text },
  modalUserInfo: { alignItems: 'center', marginBottom: spacing.lg },
  modalAvatar: { width: 70, height: 70, borderRadius: 35, justifyContent: 'center', alignItems: 'center', marginBottom: spacing.md },
  modalAvatarText: { fontSize: fontSize.xxl, fontWeight: fontWeight.bold },
  modalUserName: { ...typography.h3, color: p.colors.text },
  modalUserEmail: { ...typography.body, color: p.colors.textSecondary },
  modalSectionTitle: { ...typography.h4, color: p.colors.text, marginTop: spacing.lg, marginBottom: spacing.md },
  roleOptions: { gap: spacing.sm, marginBottom: spacing.xl },
  roleOption: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderRadius: borderRadius.xl, borderWidth: 1.5, borderColor: p.glass.borderSubtle, backgroundColor: p.glass.bgSubtle },
  roleOptionText: { ...typography.bodySemibold, color: p.colors.textSecondary },
  infoRow: { paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: p.glass.borderSubtle },
  infoLabel: { ...typography.caption, color: p.colors.textLight, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 3 },
  infoValue: { ...typography.bodySmall, color: p.colors.text },
});
