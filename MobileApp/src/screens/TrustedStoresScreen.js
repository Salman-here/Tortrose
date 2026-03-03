import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import Toast from 'react-native-toast-message';
import api from '../config/api';
import { useAuth } from '../contexts/AuthContext';
import TrustButton from '../components/TrustButton';
import VerifiedBadge from '../components/VerifiedBadge';
import { colors, spacing, fontSize, borderRadius, shadows } from '../styles/theme';

export default function TrustedStoresScreen({ navigation }) {
  const { currentUser } = useAuth();
  const [trustedStores, setTrustedStores] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchTrustedStores = useCallback(async () => {
    if (!currentUser) {
      setIsLoading(false);
      return;
    }

    try {
      const response = await api.get('/api/stores/trusted');

      if (response.data.success) {
        setTrustedStores(response.data.data.trustedStores);
      }
    } catch (error) {
      console.error('Error fetching trusted stores:', error);
      Toast.show({
        type: 'error',
        text1: 'Error',
        text2: 'Failed to load trusted stores'
      });
    } finally {
      setIsLoading(false);
    }
  }, [currentUser]);

  useEffect(() => {
    fetchTrustedStores();
  }, [fetchTrustedStores]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchTrustedStores();
    setRefreshing(false);
  }, [fetchTrustedStores]);

  const handleTrustChange = (storeId, isTrusted, trustCount) => {
    if (!isTrusted) {
      // Remove from list when untrusted
      setTrustedStores(prev => prev.filter(store => store._id !== storeId));
    }
  };

  const renderStoreCard = ({ item }) => {
    const isVerified = item.verification?.isVerified;

    return (
      <TouchableOpacity
        style={styles.storeCard}
        onPress={() => navigation.navigate('Store', { storeSlug: item.storeSlug })}
      >
        <View style={styles.storeHeader}>
          {item.logo ? (
            <Image source={{ uri: item.logo }} style={styles.storeLogo} contentFit="cover" cachePolicy="memory-disk" transition={150} />
          ) : (
            <View style={styles.storeLogoPlaceholder}>
              <Ionicons name="storefront" size={24} color={colors.textSecondary} />
            </View>
          )}
          
          <View style={styles.storeInfo}>
            <View style={styles.storeNameRow}>
              <Text style={styles.storeName} numberOfLines={1}>
                {item.storeName}
              </Text>
              {isVerified && <VerifiedBadge size="sm" />}
            </View>
            <Text style={styles.storeDescription} numberOfLines={2}>
              {item.description || 'No description available'}
            </Text>
          </View>
        </View>

        <View style={styles.storeFooter}>
          <View style={styles.trustInfo}>
            <Ionicons name="people" size={16} color={colors.textSecondary} />
            <Text style={styles.trustCount}>
              {item.trustCount} {item.trustCount === 1 ? 'truster' : 'trusters'}
            </Text>
          </View>
          
          <TrustButton
            storeId={item._id}
            storeName={item.storeName}
            initialTrustCount={item.trustCount}
            initialIsTrusted={true}
            compact
            onTrustChange={(isTrusted, count) => handleTrustChange(item._id, isTrusted, count)}
          />
        </View>
      </TouchableOpacity>
    );
  };

  const renderEmptyState = () => (
    <View style={styles.emptyContainer}>
      <Ionicons name="heart-outline" size={64} color={colors.textSecondary} />
      <Text style={styles.emptyTitle}>No Trusted Stores Yet</Text>
      <Text style={styles.emptyDescription}>
        Start exploring stores and tap the Trust button to add them to your list!
      </Text>
      <TouchableOpacity
        style={styles.exploreButton}
        onPress={() => navigation.navigate('Stores')}
      >
        <Ionicons name="storefront" size={20} color={colors.white} />
        <Text style={styles.exploreButtonText}>Explore Stores</Text>
      </TouchableOpacity>
    </View>
  );

  if (!currentUser) {
    return (
      <View style={styles.authContainer}>
        <Ionicons name="lock-closed" size={64} color={colors.textSecondary} />
        <Text style={styles.authTitle}>Login Required</Text>
        <Text style={styles.authDescription}>
          Please login to view your trusted stores
        </Text>
        <TouchableOpacity
          style={styles.loginButton}
          onPress={() => navigation.navigate('Login')}
        >
          <Text style={styles.loginButtonText}>Login</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (isLoading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={colors.primary} />
        <Text style={styles.loadingText}>Loading trusted stores...</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Ionicons name="heart" size={32} color={colors.white} />
        <Text style={styles.headerTitle}>Trusted Stores</Text>
        <Text style={styles.headerSubtitle}>
          {trustedStores.length} {trustedStores.length === 1 ? 'store' : 'stores'} you trust
        </Text>
      </View>

      {/* Store List */}
      <FlatList
        data={trustedStores}
        renderItem={renderStoreCard}
        keyExtractor={(item) => item._id}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
        ListEmptyComponent={renderEmptyState}
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
  loadingText: {
    marginTop: spacing.md,
    color: colors.textSecondary,
  },
  authContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.xl,
    backgroundColor: colors.background,
  },
  authTitle: {
    fontSize: fontSize.xl,
    fontWeight: 'bold',
    color: colors.text,
    marginTop: spacing.lg,
  },
  authDescription: {
    fontSize: fontSize.md,
    color: colors.textSecondary,
    textAlign: 'center',
    marginTop: spacing.sm,
    marginBottom: spacing.xl,
  },
  loginButton: {
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: borderRadius.md,
  },
  loginButtonText: {
    color: colors.white,
    fontSize: fontSize.md,
    fontWeight: '600',
  },
  header: {
    backgroundColor: colors.primary,
    padding: spacing.xl,
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    color: colors.white,
    marginTop: spacing.sm,
  },
  headerSubtitle: {
    fontSize: fontSize.md,
    color: 'rgba(255, 255, 255, 0.9)',
    marginTop: spacing.xs,
  },
  listContent: {
    padding: spacing.md,
    flexGrow: 1,
  },
  storeCard: {
    backgroundColor: colors.white,
    borderRadius: borderRadius.lg,
    padding: spacing.md,
    marginBottom: spacing.md,
    ...shadows.sm,
  },
  storeHeader: {
    flexDirection: 'row',
    marginBottom: spacing.md,
  },
  storeLogo: {
    width: 60,
    height: 60,
    borderRadius: borderRadius.md,
    marginRight: spacing.md,
  },
  storeLogoPlaceholder: {
    width: 60,
    height: 60,
    borderRadius: borderRadius.md,
    backgroundColor: colors.light,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: spacing.md,
  },
  storeInfo: {
    flex: 1,
  },
  storeNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  storeName: {
    fontSize: fontSize.lg,
    fontWeight: '600',
    color: colors.text,
    flex: 1,
  },
  storeDescription: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    marginTop: spacing.xs,
  },
  storeFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.light,
  },
  trustInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  trustCount: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.xl,
  },
  emptyTitle: {
    fontSize: fontSize.xl,
    fontWeight: 'bold',
    color: colors.text,
    marginTop: spacing.lg,
  },
  emptyDescription: {
    fontSize: fontSize.md,
    color: colors.textSecondary,
    textAlign: 'center',
    marginTop: spacing.sm,
    marginBottom: spacing.xl,
  },
  exploreButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: borderRadius.md,
    gap: spacing.sm,
  },
  exploreButtonText: {
    color: colors.white,
    fontSize: fontSize.md,
    fontWeight: '600',
  },
});
