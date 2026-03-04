/**
 * AdminUserManagementScreen — Liquid Glass
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet, Alert,
  RefreshControl, TextInput, Modal,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../../config/api';
import Loader from '../../components/common/Loader';
import { EmptySearch } from '../../components/common/EmptyState';
import GlassBackground from '../../components/common/GlassBackground';
import GlassPanel from '../../components/common/GlassPanel';
import {
  colors, spacing, fontSize, borderRadius, fontWeight, typography, glass,
} from '../../styles/theme';

const ROLE_TABS = [
  { id: 'all', label: 'All' }, { id: 'user', label: 'Users' },
  { id: 'seller', label: 'Sellers' }, { id: 'admin', label: 'Admins' },
];

export const filterUsers = (users, role, searchQuery) => {
  if (!Array.isArray(users)) return [];
  let filtered = users;
  if (role && role !== 'all') filtered = filtered.filter(user => user.role === role);
  if (searchQuery?.trim()) {
    const query = searchQuery.toLowerCase().trim();
    filtered = filtered.filter(user => user.name?.toLowerCase().includes(query) || user.email?.toLowerCase().includes(query));
  }
  return filtered;
};

const getRoleColor = (role) => {
  switch (role) { case 'admin': return colors.error; case 'seller': return colors.success; default: return colors.info; }
};

export default function AdminUserManagementScreen({ navigation }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState('all');
  const [selectedUser, setSelectedUser] = useState(null);
  const [modalVisible, setModalVisible] = useState(false);

  useEffect(() => { fetchUsers(); }, []);

  const fetchUsers = async () => {
    try {
      const res = await api.get('/api/user/get');
      const userData = res.data?.users || res.data || [];
      setUsers(Array.isArray(userData) ? userData : []);
    } catch (e) { setUsers([]); Alert.alert('Error', 'Failed to fetch users'); }
    finally { setLoading(false); setRefreshing(false); }
  };

  const onRefresh = useCallback(() => { setRefreshing(true); fetchUsers(); }, []);
  const handleUserPress = useCallback((user) => { setSelectedUser(user); setModalVisible(true); }, []);

  const updateUserRole = async (newRole) => {
    if (!selectedUser) return;
    try {
      await api.patch(`/api/user/update-role/${selectedUser._id}`, { role: newRole });
      setUsers(prev => prev.map(u => u._id === selectedUser._id ? { ...u, role: newRole } : u));
      Alert.alert('Success', 'User role updated');
      setModalVisible(false);
    } catch (e) { Alert.alert('Error', 'Failed to update role'); }
  };

  const filteredUsers = filterUsers(users || [], activeTab, searchQuery);
  const roleCounts = (users || []).reduce((acc, u) => { acc[u.role] = (acc[u.role] || 0) + 1; return acc; }, {});

  const renderHeader = useCallback(() => (
    <View style={styles.headerContainer}>
      <GlassPanel variant="floating" style={styles.titleRow}>
        <View style={styles.titleIcon}><Ionicons name="people-outline" size={24} color="white" /></View>
        <View>
          <Text style={styles.title}>User Management</Text>
          <Text style={styles.subtitle}>{users.length} total users</Text>
        </View>
      </GlassPanel>

      <View style={styles.searchContainer}>
        <Ionicons name="search" size={20} color={colors.textSecondary} />
        <TextInput style={styles.searchInput} placeholder="Search by name or email..." placeholderTextColor={colors.textSecondary}
          value={searchQuery} onChangeText={setSearchQuery} returnKeyType="search" />
        {searchQuery.length > 0 && <TouchableOpacity onPress={() => setSearchQuery('')}><Ionicons name="close-circle" size={20} color={colors.textSecondary} /></TouchableOpacity>}
      </View>

      <FlatList horizontal data={ROLE_TABS} keyExtractor={i => i.id} showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.tabsContainer}
        renderItem={({ item }) => {
          const isActive = activeTab === item.id;
          const count = item.id === 'all' ? users.length : (roleCounts[item.id] || 0);
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
      <Text style={styles.resultsText}>Showing <Text style={styles.resultsCount}>{filteredUsers.length}</Text> users</Text>
    </View>
  ), [users.length, searchQuery, activeTab, roleCounts, filteredUsers.length]);

  const renderUser = useCallback(({ item }) => (
    <GlassPanel variant="card" style={styles.userCard}>
      <TouchableOpacity style={styles.userCardInner} onPress={() => handleUserPress(item)} activeOpacity={0.7}>
        <View style={[styles.avatar, { backgroundColor: getRoleColor(item.role) + '25' }]}>
          <Text style={[styles.avatarText, { color: getRoleColor(item.role) }]}>{item.name?.charAt(0)?.toUpperCase() || 'U'}</Text>
        </View>
        <View style={styles.userInfo}>
          <Text style={styles.userName} numberOfLines={1}>{item.name}</Text>
          <Text style={styles.userEmail} numberOfLines={1}>{item.email}</Text>
        </View>
        <View style={[styles.roleBadge, { backgroundColor: getRoleColor(item.role) }]}>
          <Text style={styles.roleText}>{item.role}</Text>
        </View>
      </TouchableOpacity>
    </GlassPanel>
  ), [handleUserPress]);

  if (loading) return <GlassBackground><Loader fullScreen message="Loading users..." /></GlassBackground>;

  return (
    <GlassBackground>
      <FlatList data={filteredUsers} renderItem={renderUser} keyExtractor={i => i._id}
        contentContainerStyle={styles.list} ListHeaderComponent={renderHeader}
        ListEmptyComponent={searchQuery ? <EmptySearch query={searchQuery} onClear={() => setSearchQuery('')} /> : null}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
        showsVerticalScrollIndicator={false} />

      <Modal visible={modalVisible} animationType="slide" transparent onRequestClose={() => setModalVisible(false)}>
        <View style={styles.modalOverlay}>
          <GlassPanel variant="strong" style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>User Details</Text>
              <TouchableOpacity onPress={() => setModalVisible(false)}><Ionicons name="close" size={24} color={colors.text} /></TouchableOpacity>
            </View>
            {selectedUser && (
              <>
                <View style={styles.modalUserInfo}>
                  <View style={[styles.modalAvatar, { backgroundColor: getRoleColor(selectedUser.role) + '25' }]}>
                    <Text style={[styles.modalAvatarText, { color: getRoleColor(selectedUser.role) }]}>{selectedUser.name?.charAt(0)?.toUpperCase() || 'U'}</Text>
                  </View>
                  <Text style={styles.modalUserName}>{selectedUser.name}</Text>
                  <Text style={styles.modalUserEmail}>{selectedUser.email}</Text>
                </View>
                <Text style={styles.modalSectionTitle}>Change Role</Text>
                <View style={styles.roleOptions}>
                  {['user', 'seller', 'admin'].map(role => (
                    <TouchableOpacity key={role} style={[styles.roleOption, selectedUser.role === role && { borderColor: getRoleColor(role), backgroundColor: getRoleColor(role) + '15' }]}
                      onPress={() => updateUserRole(role)} activeOpacity={0.7}>
                      <Text style={[styles.roleOptionText, selectedUser.role === role && { color: getRoleColor(role) }]}>{role.charAt(0).toUpperCase() + role.slice(1)}</Text>
                      {selectedUser.role === role && <Ionicons name="checkmark" size={18} color={getRoleColor(role)} />}
                    </TouchableOpacity>
                  ))}
                </View>
              </>
            )}
          </GlassPanel>
        </View>
      </Modal>
    </GlassBackground>
  );
}

const styles = StyleSheet.create({
  headerContainer: { paddingBottom: spacing.md, marginBottom: spacing.sm },
  titleRow: { flexDirection: 'row', alignItems: 'center', margin: spacing.lg, marginBottom: spacing.md, padding: spacing.lg },
  titleIcon: { width: 44, height: 44, borderRadius: borderRadius.lg, backgroundColor: colors.primary, justifyContent: 'center', alignItems: 'center', marginRight: spacing.md },
  title: { ...typography.h3, color: colors.text },
  subtitle: { ...typography.bodySmall, color: colors.textSecondary },
  searchContainer: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: borderRadius.xl, paddingHorizontal: spacing.md, marginHorizontal: spacing.lg, marginBottom: spacing.md, height: 44, borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)' },
  searchInput: { flex: 1, marginLeft: spacing.sm, fontSize: fontSize.md, color: colors.text },
  tabsContainer: { paddingHorizontal: spacing.lg, gap: spacing.sm, marginBottom: spacing.md },
  tab: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: borderRadius.full, backgroundColor: 'rgba(255,255,255,0.08)', gap: spacing.xs },
  tabActive: { backgroundColor: colors.primary },
  tabText: { ...typography.bodySmall, fontWeight: fontWeight.medium, color: colors.textSecondary },
  tabTextActive: { color: 'white' },
  tabBadge: { minWidth: 20, height: 20, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.15)', justifyContent: 'center', alignItems: 'center', paddingHorizontal: spacing.xs },
  tabBadgeActive: { backgroundColor: 'rgba(255,255,255,0.3)' },
  tabBadgeText: { ...typography.caption, fontWeight: fontWeight.bold, color: colors.textSecondary },
  tabBadgeTextActive: { color: 'white' },
  resultsText: { ...typography.bodySmall, color: colors.textSecondary, paddingHorizontal: spacing.lg },
  resultsCount: { fontWeight: fontWeight.bold, color: colors.text },
  list: { paddingHorizontal: spacing.md, paddingBottom: 100, flexGrow: 1 },
  userCard: { marginBottom: spacing.sm },
  userCardInner: { flexDirection: 'row', alignItems: 'center', padding: spacing.md },
  avatar: { width: 50, height: 50, borderRadius: 25, justifyContent: 'center', alignItems: 'center', marginRight: spacing.md },
  avatarText: { fontSize: fontSize.xl, fontWeight: fontWeight.bold },
  userInfo: { flex: 1 },
  userName: { ...typography.bodySemibold, color: colors.text, marginBottom: 2 },
  userEmail: { ...typography.bodySmall, color: colors.textSecondary },
  roleBadge: { paddingHorizontal: spacing.md, paddingVertical: spacing.xs, borderRadius: borderRadius.full },
  roleText: { ...typography.caption, color: 'white', fontWeight: fontWeight.bold, textTransform: 'capitalize' },
  modalOverlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' },
  modalContent: { borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: spacing.lg },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.lg },
  modalTitle: { ...typography.h3, color: colors.text },
  modalUserInfo: { alignItems: 'center', marginBottom: spacing.xl },
  modalAvatar: { width: 70, height: 70, borderRadius: 35, justifyContent: 'center', alignItems: 'center', marginBottom: spacing.md },
  modalAvatarText: { fontSize: fontSize.xxl, fontWeight: fontWeight.bold },
  modalUserName: { ...typography.h3, color: colors.text },
  modalUserEmail: { ...typography.body, color: colors.textSecondary },
  modalSectionTitle: { ...typography.h4, color: colors.text, marginBottom: spacing.md },
  roleOptions: { gap: spacing.sm, marginBottom: spacing.xl },
  roleOption: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderRadius: borderRadius.xl, borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.15)' },
  roleOptionText: { ...typography.bodySemibold, color: colors.textSecondary },
});
