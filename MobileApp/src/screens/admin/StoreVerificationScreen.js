/**
 * StoreVerificationScreen
 * Modern admin screen for managing store verification
 * 
 * Requirements: 27.1, 27.2, 27.3, 27.4, 27.5, 27.6
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  Alert,
  TextInput,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import Toast from 'react-native-toast-message';
import api from '../../config/api';
import { useAuth } from '../../contexts/AuthContext';
import VerifiedBadge from '../../components/VerifiedBadge';
import Loader from '../../components/common/Loader';
import EmptyState from '../../components/common/EmptyState';
import { 
  colors, 
  spacing, 
  fontSize, 
  fontWeight,
  borderRadius, 
  shadows,
  typography,
} from '../../styles/theme';

// Helper function to filter stores by search query - exported for testing
export const filterStoresBySearch = (stores, searchQuery) => {
  if (!searchQuery || !searchQuery.trim()) return stores;
  const query = searchQuery.toLowerCase().trim();
  return stores.filter(store => {
    const storeName = (store.storeName || store.name || '').toLowerCase();
    return storeName.includes(query);
  });
};

// Helper function to get verification display info - exported for testing
export const getVerificationDisplayInfo = (store) => {
  const isVerified = store?.verification?.isVerified || false;
  const verifiedAt = store?.verification?.verifiedAt;
  
  return {
    isVerified,
    statusText: isVerified ? 'Verified' : 'Unverified',
    statusColor: isVerified ? colors.success : colors.error,
    statusBgColor: isVerified ? colors.successLighter : colors.errorLighter,
    verificationDate: verifiedAt ? new Date(verifiedAt).toLocaleDateString() : null,
  };
};

export default function StoreVerificationScreen({ navigation }) {
  const { currentUser } = useAuth();
  const [stores, setStores] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [processingStoreId, setProcessingStoreId] = useState(null);
  const [filter, setFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');

  // Check admin access
  useEffect(() => {
    if (currentUser && currentUser.role !== 'admin') {
      Toast.show({
        type: 'error',
        text1: 'Access Denied',
        text2: 'Only admins can access this screen'
      });
      navigation.goBack();
    }
  }, [currentUser, navigation]);

  const fetchStores = useCallback(async () => {
    if (!currentUser || currentUser.role !== 'admin') {
      setIsLoading(false);
      return;
    }

    try {
      const response = await api.get('/api/stores/admin/all');
      setStores(response.data.stores || response.data.data?.stores || []);
    } catch (error) {
      console.error('Error fetching stores:', error);
      try {
        const response = await api.get('/api/stores');
        setStores(response.data.stores || []);
      } catch (fallbackError) {
        Toast.show({
          type: 'error',
          text1: 'Error',
          text2: 'Failed to load stores'
        });
      }
    } finally {
      setIsLoading(false);
    }
  }, [currentUser]);

  useEffect(() => {
    fetchStores();
  }, [fetchStores]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchStores();
    setRefreshing(false);
  }, [fetchStores]);

  const handleVerifyStore = async (storeId, storeName, currentStatus) => {
    const action = currentStatus ? 'unverify' : 'verify';
    
    Alert.alert(
      `${action.charAt(0).toUpperCase() + action.slice(1)} Store`,
      `Are you sure you want to ${action} "${storeName}"?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: action.charAt(0).toUpperCase() + action.slice(1),
          style: currentStatus ? 'destructive' : 'default',
          onPress: () => performVerification(storeId, storeName, action)
        }
      ]
    );
  };

  const performVerification = async (storeId, storeName, action) => {
    setProcessingStoreId(storeId);

    try {
      const endpoint = action === 'verify'
        ? `/api/stores/${storeId}/verify`
        : `/api/stores/${storeId}/unverify`;

      await api.patch(endpoint, {});

      setStores(prev => prev.map(store => {
        if (store._id === storeId) {
          return {
            ...store,
            verification: {
              ...store.verification,
              isVerified: action === 'verify',
              verifiedAt: action === 'verify' ? new Date().toISOString() : null,
              verifiedBy: action === 'verify' ? currentUser._id : null
            }
          };
        }
        return store;
      }));

      Toast.show({
        type: 'success',
        text1: 'Success',
        text2: `${storeName} has been ${action === 'verify' ? 'verified' : 'unverified'}`
      });
    } catch (error) {
      console.error(`Error ${action}ing store:`, error);
      Toast.show({
        type: 'error',
        text1: 'Error',
        text2: error.response?.data?.message || `Failed to ${action} store`
      });
    } finally {
      setProcessingStoreId(null);
    }
  };

  // Filter and search stores
  const filteredStores = useMemo(() => {
    let result = stores;
    
    // Apply status filter
    if (filter === 'verified') {
      result = result.filter(s => s.verification?.isVerified);
    } else if (filter === 'unverified') {
      result = result.filter(s => !s.verification?.isVerified);
    }
    
    // Apply search filter
    result = filterStoresBySearch(result, searchQuery);
    
    return result;
  }, [stores, filter, searchQuery]);

  const verifiedCount = stores.filter(s => s.verification?.isVerified).length;
  const unverifiedCount = stores.length - verifiedCount;

  const renderStoreCard = ({ item }) => {
    const displayInfo = getVerificationDisplayInfo(item);
    const isProcessing = processingStoreId === item._id;

    return (
      <View style={styles.storeCard}>
        <View style={styles.storeHeader}>
          {item.logo ? (
            <Image source={{ uri: item.logo }} style={styles.storeLogo} contentFit="cover" cachePolicy="memory-disk" transition={150} />
          ) : (
            <View style={styles.storeLogoPlaceholder}>
              <Ionicons name="storefront" size={24} color={colors.grayLight} />
            </View>
          )}
          
          <View style={styles.storeInfo}>
            <View style={styles.storeNameRow}>
              <Text style={styles.storeName} numberOfLines={1}>
                {item.storeName || item.name}
              </Text>
              {displayInfo.isVerified && <VerifiedBadge size="sm" />}
            </View>
            {item.owner && (
              <Text style={styles.ownerText}>
                <Ionicons name="person-outline" size={12} color={colors.textSecondary} />
                {' '}{item.owner.name || item.owner.email}
              </Text>
            )}
          </View>
        </View>

        <View style={styles.storeStats}>
          <View style={styles.statItem}>
            <View style={styles.statIconContainer}>
              <Ionicons name="people-outline" size={14} color={colors.primary} />
            </View>
            <Text style={styles.statText}>{item.trustCount || 0} trusters</Text>
          </View>
          <View style={styles.statItem}>
            <View style={styles.statIconContainer}>
              <Ionicons name="cube-outline" size={14} color={colors.secondary} />
            </View>
            <Text style={styles.statText}>{item.productCount || 0} products</Text>
          </View>
        </View>

        <View style={styles.storeFooter}>
          <View style={[styles.statusBadge, { backgroundColor: displayInfo.statusBgColor }]}>
            <Ionicons 
              name={displayInfo.isVerified ? 'checkmark-circle' : 'close-circle'} 
              size={14} 
              color={displayInfo.statusColor} 
            />
            <Text style={[styles.statusText, { color: displayInfo.statusColor }]}>
              {displayInfo.statusText}
            </Text>
          </View>

          <TouchableOpacity
            style={[
              styles.actionButton,
              displayInfo.isVerified ? styles.unverifyButton : styles.verifyButton,
              isProcessing && styles.disabledButton
            ]}
            onPress={() => handleVerifyStore(item._id, item.storeName || item.name, displayInfo.isVerified)}
            disabled={isProcessing}
          >
            {isProcessing ? (
              <ActivityIndicator size="small" color={colors.white} />
            ) : (
              <>
                <Ionicons 
                  name={displayInfo.isVerified ? 'close' : 'checkmark'} 
                  size={16} 
                  color={colors.white} 
                />
                <Text style={styles.actionButtonText}>
                  {displayInfo.isVerified ? 'Unverify' : 'Verify'}
                </Text>
              </>
            )}
          </TouchableOpacity>
        </View>

        {displayInfo.verificationDate && (
          <View style={styles.verifiedDateContainer}>
            <Ionicons name="calendar-outline" size={12} color={colors.success} />
            <Text style={styles.verifiedDate}>
              Verified on {displayInfo.verificationDate}
            </Text>
          </View>
        )}
      </View>
    );
  };

  // Access denied for non-admins
  if (!currentUser || currentUser.role !== 'admin') {
    return (
      <View style={styles.accessDeniedContainer}>
        <View style={styles.accessDeniedIcon}>
          <Ionicons name="shield-outline" size={64} color={colors.error} />
        </View>
        <Text style={styles.accessDeniedTitle}>Access Denied</Text>
        <Text style={styles.accessDeniedText}>
          Only administrators can access this screen.
        </Text>
        <TouchableOpacity
          style={styles.goBackButton}
          onPress={() => navigation.goBack()}
        >
          <Text style={styles.goBackButtonText}>Go Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (isLoading) {
    return (
      <View style={styles.loadingContainer}>
        <Loader size="large" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerTop}>
          <View style={styles.headerIconContainer}>
            <Ionicons name="shield-checkmark-outline" size={24} color={colors.white} />
          </View>
          <View>
            <Text style={styles.headerTitle}>Store Verification</Text>
            <Text style={styles.headerSubtitle}>
              {stores.length} {stores.length === 1 ? 'store' : 'stores'} total
            </Text>
          </View>
        </View>
        
        {/* Stats Row */}
        <View style={styles.statsRow}>
          <View style={styles.statCard}>
            <Text style={styles.statCardValue}>{stores.length}</Text>
            <Text style={styles.statCardLabel}>Total</Text>
          </View>
          <View style={[styles.statCard, styles.verifiedStatCard]}>
            <Ionicons name="checkmark-circle" size={16} color={colors.success} />
            <Text style={[styles.statCardValue, { color: colors.successDark }]}>{verifiedCount}</Text>
            <Text style={styles.statCardLabel}>Verified</Text>
          </View>
          <View style={[styles.statCard, styles.unverifiedStatCard]}>
            <Ionicons name="time-outline" size={16} color={colors.warning} />
            <Text style={[styles.statCardValue, { color: colors.warningDark }]}>{unverifiedCount}</Text>
            <Text style={styles.statCardLabel}>Pending</Text>
          </View>
        </View>
      </View>

      {/* Search Bar */}
      <View style={styles.searchContainer}>
        <View style={styles.searchInputContainer}>
          <Ionicons name="search-outline" size={20} color={colors.grayLight} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search stores by name..."
            placeholderTextColor={colors.grayLight}
            value={searchQuery}
            onChangeText={setSearchQuery}
          />
          {searchQuery.length > 0 && (
            <TouchableOpacity onPress={() => setSearchQuery('')}>
              <Ionicons name="close-circle" size={20} color={colors.grayLight} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Filter Tabs */}
      <View style={styles.filterTabs}>
        {[
          { key: 'all', label: 'All', count: stores.length },
          { key: 'verified', label: 'Verified', count: verifiedCount },
          { key: 'unverified', label: 'Unverified', count: unverifiedCount },
        ].map((tab) => (
          <TouchableOpacity
            key={tab.key}
            style={[styles.filterTab, filter === tab.key && styles.activeFilterTab]}
            onPress={() => setFilter(tab.key)}
          >
            <Text style={[styles.filterTabText, filter === tab.key && styles.activeFilterTabText]}>
              {tab.label}
            </Text>
            <View style={[styles.filterTabBadge, filter === tab.key && styles.activeFilterTabBadge]}>
              <Text style={[styles.filterTabBadgeText, filter === tab.key && styles.activeFilterTabBadgeText]}>
                {tab.count}
              </Text>
            </View>
          </TouchableOpacity>
        ))}
      </View>

      {/* Store List */}
      <FlatList
        data={filteredStores}
        renderItem={renderStoreCard}
        keyExtractor={(item) => item._id}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl 
            refreshing={refreshing} 
            onRefresh={onRefresh}
            colors={[colors.primary]}
            tintColor={colors.primary}
          />
        }
        ListEmptyComponent={
          searchQuery ? (
            <EmptyState
              icon="search-outline"
              title="No stores found"
              subtitle={`No stores match "${searchQuery}"`}
              actionLabel="Clear Search"
              onAction={() => setSearchQuery('')}
            />
          ) : (
            <EmptyState
              icon="storefront-outline"
              title="No stores"
              subtitle={filter === 'verified' 
                ? 'No verified stores yet' 
                : filter === 'unverified' 
                  ? 'All stores are verified!' 
                  : 'No stores registered yet'}
            />
          )
        }
      />
    </View>
  );
}


const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: colors.background,
  },
  
  // Access Denied
  accessDeniedContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.xl,
    backgroundColor: colors.background,
  },
  accessDeniedIcon: {
    width: 100,
    height: 100,
    borderRadius: borderRadius.full,
    backgroundColor: colors.errorLighter,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: spacing.lg,
  },
  accessDeniedTitle: {
    ...typography.h2,
    color: colors.error,
    marginBottom: spacing.sm,
  },
  accessDeniedText: {
    ...typography.body,
    color: colors.textSecondary,
    textAlign: 'center',
    marginBottom: spacing.xl,
  },
  goBackButton: {
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.xxl,
    paddingVertical: spacing.md,
    borderRadius: borderRadius.lg,
    ...shadows.primarySm,
  },
  goBackButtonText: {
    ...typography.bodySemibold,
    color: colors.white,
  },

  // Header
  header: {
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xl,
    borderBottomLeftRadius: borderRadius.xxl,
    borderBottomRightRadius: borderRadius.xxl,
  },
  headerTop: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.lg,
  },
  headerIconContainer: {
    width: 48,
    height: 48,
    borderRadius: borderRadius.lg,
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: spacing.md,
  },
  headerTitle: {
    ...typography.h2,
    color: colors.white,
  },
  headerSubtitle: {
    ...typography.bodySmall,
    color: 'rgba(255, 255, 255, 0.8)',
    marginTop: spacing.xs,
  },
  statsRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  statCard: {
    flex: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
    borderRadius: borderRadius.lg,
    padding: spacing.md,
    alignItems: 'center',
  },
  verifiedStatCard: {
    backgroundColor: 'rgba(255, 255, 255, 0.95)',
  },
  unverifiedStatCard: {
    backgroundColor: 'rgba(255, 255, 255, 0.95)',
  },
  statCardValue: {
    ...typography.h3,
    color: colors.white,
  },
  statCardLabel: {
    ...typography.caption,
    color: 'rgba(255, 255, 255, 0.8)',
    marginTop: spacing.xs,
  },

  // Search
  searchContainer: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: colors.white,
    borderBottomWidth: 1,
    borderBottomColor: colors.light,
  },
  searchInputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.lighter,
    borderRadius: borderRadius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: colors.light,
  },
  searchInput: {
    flex: 1,
    marginLeft: spacing.sm,
    fontSize: fontSize.md,
    color: colors.text,
  },

  // Filter Tabs
  filterTabs: {
    flexDirection: 'row',
    backgroundColor: colors.white,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.light,
    gap: spacing.sm,
  },
  filterTab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: borderRadius.lg,
    backgroundColor: colors.lighter,
    gap: spacing.xs,
  },
  activeFilterTab: {
    backgroundColor: colors.primary,
  },
  filterTabText: {
    ...typography.bodySmall,
    color: colors.textSecondary,
    fontWeight: fontWeight.medium,
  },
  activeFilterTabText: {
    color: colors.white,
  },
  filterTabBadge: {
    backgroundColor: colors.light,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: borderRadius.full,
  },
  activeFilterTabBadge: {
    backgroundColor: 'rgba(255, 255, 255, 0.3)',
  },
  filterTabBadgeText: {
    ...typography.caption,
    color: colors.textSecondary,
    fontWeight: fontWeight.semibold,
  },
  activeFilterTabBadgeText: {
    color: colors.white,
  },

  // List
  listContent: {
    padding: spacing.lg,
    flexGrow: 1,
  },

  // Store Card
  storeCard: {
    backgroundColor: colors.white,
    borderRadius: borderRadius.xl,
    padding: spacing.lg,
    marginBottom: spacing.md,
    ...shadows.md,
    borderWidth: 1,
    borderColor: colors.light,
  },
  storeHeader: {
    flexDirection: 'row',
    marginBottom: spacing.md,
  },
  storeLogo: {
    width: 56,
    height: 56,
    borderRadius: borderRadius.lg,
    marginRight: spacing.md,
  },
  storeLogoPlaceholder: {
    width: 56,
    height: 56,
    borderRadius: borderRadius.lg,
    backgroundColor: colors.lighter,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: spacing.md,
  },
  storeInfo: {
    flex: 1,
    justifyContent: 'center',
  },
  storeNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  storeName: {
    ...typography.h4,
    color: colors.text,
    flex: 1,
  },
  ownerText: {
    ...typography.bodySmall,
    color: colors.textSecondary,
    marginTop: spacing.xs,
  },
  storeStats: {
    flexDirection: 'row',
    gap: spacing.lg,
    marginBottom: spacing.md,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.light,
  },
  statItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  statIconContainer: {
    width: 24,
    height: 24,
    borderRadius: borderRadius.sm,
    backgroundColor: colors.lighter,
    justifyContent: 'center',
    alignItems: 'center',
  },
  statText: {
    ...typography.bodySmall,
    color: colors.textSecondary,
  },
  storeFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.full,
    gap: spacing.xs,
  },
  statusText: {
    ...typography.bodySmall,
    fontWeight: fontWeight.semibold,
  },
  actionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.lg,
    gap: spacing.xs,
    minWidth: 100,
    justifyContent: 'center',
  },
  verifyButton: {
    backgroundColor: colors.success,
  },
  unverifyButton: {
    backgroundColor: colors.error,
  },
  disabledButton: {
    opacity: 0.6,
  },
  actionButtonText: {
    ...typography.bodySmall,
    color: colors.white,
    fontWeight: fontWeight.semibold,
  },
  verifiedDateContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing.md,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.light,
    gap: spacing.xs,
  },
  verifiedDate: {
    ...typography.caption,
    color: colors.success,
  },
});
