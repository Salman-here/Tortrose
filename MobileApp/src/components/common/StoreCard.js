/**
 * StoreCard Component
 * Modern store card with trust and verification display
 * 
 * Requirements: 14.2, 15.1, 15.2
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Animated,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import VerifiedBadge from '../VerifiedBadge';
import TrustButton from '../TrustButton';
import {
  colors,
  spacing,
  fontSize,
  fontWeight,
  borderRadius,
  shadows,
  cardStyles,
  typography,
} from '../../styles/theme';

const StoreCard = ({
  store,
  index = 0,
  onPress,
  showTrustButton = true,
  showDescription = true,
  showStats = true,
  compact = false,
  style,
}) => {
  const navigation = useNavigation();
  const [imageLoading, setImageLoading] = useState(true);
  const [bannerError, setBannerError] = useState(false);
  const [logoError, setLogoError] = useState(false);
  
  // Animation values
  const scaleAnim = useRef(new Animated.Value(0.95)).current;
  const opacityAnim = useRef(new Animated.Value(0)).current;

  // Staggered entrance animation
  useEffect(() => {
    const delay = index * 80;
    const timeout = setTimeout(() => {
      Animated.parallel([
        Animated.spring(scaleAnim, {
          toValue: 1,
          friction: 8,
          tension: 40,
          useNativeDriver: true,
        }),
        Animated.timing(opacityAnim, {
          toValue: 1,
          duration: 300,
          useNativeDriver: true,
        }),
      ]).start();
    }, delay);

    return () => clearTimeout(timeout);
  }, [index]);

  if (!store) return null;

  const {
    _id,
    storeName,
    storeSlug,
    description,
    logo,
    banner,
    trustCount = 0,
    verification,
    productCount = 0,
    views = 0,
  } = store;

  const isVerified = verification?.isVerified;

  const handlePress = () => {
    if (onPress) {
      onPress(store);
    } else {
      navigation.navigate('Store', { storeSlug: storeSlug || _id });
    }
  };

  return (
    <Animated.View
      style={[
        styles.animatedContainer,
        {
          transform: [{ scale: scaleAnim }],
          opacity: opacityAnim,
        },
        style,
      ]}
    >
      <TouchableOpacity
        style={[styles.container, compact && styles.containerCompact]}
        onPress={handlePress}
        activeOpacity={0.9}
      >
        {/* Banner */}
        <View style={[styles.bannerContainer, compact && styles.bannerContainerCompact]}>
          {banner && !bannerError ? (
            <Image
              source={{ uri: banner }}
              style={styles.banner}
              contentFit="cover"
              cachePolicy="memory-disk"
              transition={200}
              onError={() => setBannerError(true)}
            />
          ) : (
            <View style={styles.bannerGradient}>
              <View style={styles.bannerOverlay} />
            </View>
          )}
          <View style={styles.bannerGradientOverlay} />
        </View>

        {/* Content */}
        <View style={[styles.content, compact && styles.contentCompact]}>
          {/* Logo */}
          <View style={[styles.logoContainer, compact && styles.logoContainerCompact]}>
            {logo && !logoError ? (
              <Image
                source={{ uri: logo }}
                style={[styles.logo, compact && styles.logoCompact]}
                contentFit="cover"
                cachePolicy="memory-disk"
                transition={150}
                onError={() => setLogoError(true)}
              />
            ) : (
              <View style={[styles.logoPlaceholder, compact && styles.logoCompact]}>
                <Ionicons 
                  name="storefront" 
                  size={compact ? 20 : 28} 
                  color={colors.white} 
                />
              </View>
            )}
          </View>

          {/* Store Name & Trust Button Row */}
          <View style={styles.headerRow}>
            <View style={styles.nameContainer}>
              <Text style={[styles.storeName, compact && styles.storeNameCompact]} numberOfLines={1}>
                {storeName}
              </Text>
              {isVerified && (
                <VerifiedBadge size={compact ? 'xs' : 'sm'} style={styles.verifiedBadge} />
              )}
            </View>
            
            {showTrustButton && !compact && (
              <View style={styles.trustButtonContainer}>
                <TrustButton
                  storeId={_id}
                  storeName={storeName}
                  initialTrustCount={trustCount}
                  compact={true}
                />
              </View>
            )}
          </View>

          {/* Trust Count */}
          <View style={styles.trustCountRow}>
            <Ionicons name="heart" size={12} color={colors.heart} />
            <Text style={styles.trustCountText}>
              {trustCount} {trustCount === 1 ? 'truster' : 'trusters'}
            </Text>
          </View>

          {/* Description */}
          {showDescription && description && !compact && (
            <Text style={styles.description} numberOfLines={2}>
              {description}
            </Text>
          )}

          {/* Stats */}
          {showStats && (
            <View style={[styles.statsRow, compact && styles.statsRowCompact]}>
              <View style={styles.stat}>
                <Ionicons name="cube-outline" size={14} color={colors.info} />
                <Text style={styles.statText}>
                  {productCount} {compact ? '' : 'items'}
                </Text>
              </View>
              {!compact && (
                <View style={styles.stat}>
                  <Ionicons name="eye-outline" size={14} color={colors.secondary} />
                  <Text style={styles.statText}>{views} views</Text>
                </View>
              )}
            </View>
          )}
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
};

// Compact horizontal store card for lists
export const CompactStoreCard = ({ store, onPress }) => (
  <StoreCard 
    store={store} 
    onPress={onPress} 
    compact={true}
    showDescription={false}
    showTrustButton={false}
  />
);

// Store list item for vertical lists
export const StoreListItem = ({ store, onPress, showTrustButton = true }) => {
  const navigation = useNavigation();
  
  if (!store) return null;

  const {
    _id,
    storeName,
    storeSlug,
    description,
    logo,
    trustCount = 0,
    verification,
    productCount = 0,
  } = store;

  const isVerified = verification?.isVerified;

  const handlePress = () => {
    if (onPress) {
      onPress(store);
    } else {
      navigation.navigate('Store', { storeSlug: storeSlug || _id });
    }
  };

  return (
    <TouchableOpacity
      style={styles.listItemContainer}
      onPress={handlePress}
      activeOpacity={0.7}
    >
      {/* Logo */}
      {logo ? (
        <Image source={{ uri: logo }} style={styles.listItemLogo} contentFit="cover" cachePolicy="memory-disk" transition={150} />
      ) : (
        <View style={[styles.listItemLogo, styles.listItemLogoPlaceholder]}>
          <Ionicons name="storefront" size={24} color={colors.white} />
        </View>
      )}

      {/* Info */}
      <View style={styles.listItemContent}>
        <View style={styles.listItemHeader}>
          <Text style={styles.listItemName} numberOfLines={1}>
            {storeName}
          </Text>
          {isVerified && <VerifiedBadge size="xs" />}
        </View>
        
        {description && (
          <Text style={styles.listItemDescription} numberOfLines={1}>
            {description}
          </Text>
        )}
        
        <View style={styles.listItemStats}>
          <Text style={styles.listItemStatText}>
            {productCount} products
          </Text>
          <Text style={styles.listItemStatDot}>•</Text>
          <Text style={styles.listItemStatText}>
            {trustCount} trusters
          </Text>
        </View>
      </View>

      {/* Trust Button or Chevron */}
      {showTrustButton ? (
        <View style={styles.listItemAction}>
          <TrustButton
            storeId={_id}
            storeName={storeName}
            initialTrustCount={trustCount}
            compact={true}
            iconOnly={true}
          />
        </View>
      ) : (
        <Ionicons name="chevron-forward" size={20} color={colors.grayLight} />
      )}
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  animatedContainer: {
    flex: 1,
  },
  container: {
    backgroundColor: colors.white,
    borderRadius: borderRadius.xl,
    ...shadows.md,
    borderWidth: 1,
    borderColor: colors.light,
    overflow: 'hidden',
  },
  containerCompact: {
    width: 160,
    marginRight: spacing.md,
  },
  // Banner
  bannerContainer: {
    height: 80,
    overflow: 'hidden',
  },
  bannerContainerCompact: {
    height: 60,
  },
  banner: {
    width: '100%',
    height: '100%',
  },
  bannerGradient: {
    width: '100%',
    height: '100%',
    backgroundColor: colors.primary,
    overflow: 'hidden',
  },
  bannerOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
  },
  bannerGradientOverlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 30,
    backgroundColor: 'transparent',
  },
  // Content
  content: {
    padding: spacing.lg,
    paddingTop: spacing.sm,
  },
  contentCompact: {
    padding: spacing.md,
    paddingTop: spacing.xs,
  },
  // Logo
  logoContainer: {
    marginTop: -40,
    marginBottom: spacing.sm,
  },
  logoContainerCompact: {
    marginTop: -30,
  },
  logo: {
    width: 64,
    height: 64,
    borderRadius: borderRadius.full,
    borderWidth: 3,
    borderColor: colors.white,
    backgroundColor: colors.lighter,
  },
  logoCompact: {
    width: 48,
    height: 48,
  },
  logoPlaceholder: {
    width: 64,
    height: 64,
    borderRadius: borderRadius.full,
    borderWidth: 3,
    borderColor: colors.white,
    backgroundColor: colors.primary,
    justifyContent: 'center',
    alignItems: 'center',
  },
  // Header
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.xs,
  },
  nameContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    marginRight: spacing.sm,
  },
  storeName: {
    ...typography.h4,
    flex: 1,
  },
  storeNameCompact: {
    fontSize: fontSize.sm,
  },
  verifiedBadge: {
    marginLeft: spacing.xs,
  },
  trustButtonContainer: {
    flexShrink: 0,
  },
  // Trust Count
  trustCountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  trustCountText: {
    ...typography.caption,
    marginLeft: spacing.xs,
  },
  // Description
  description: {
    ...typography.bodySmall,
    marginBottom: spacing.md,
    lineHeight: 18,
  },
  // Stats
  statsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.light,
    gap: spacing.lg,
  },
  statsRowCompact: {
    paddingTop: spacing.sm,
    gap: spacing.md,
  },
  stat: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  statText: {
    ...typography.bodySmall,
    color: colors.textSecondary,
    fontWeight: fontWeight.medium,
  },
  // List Item styles
  listItemContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.white,
    padding: spacing.md,
    borderRadius: borderRadius.lg,
    marginBottom: spacing.sm,
    ...shadows.sm,
    borderWidth: 1,
    borderColor: colors.light,
  },
  listItemLogo: {
    width: 50,
    height: 50,
    borderRadius: borderRadius.lg,
    marginRight: spacing.md,
  },
  listItemLogoPlaceholder: {
    backgroundColor: colors.primary,
    justifyContent: 'center',
    alignItems: 'center',
  },
  listItemContent: {
    flex: 1,
  },
  listItemHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.xs,
  },
  listItemName: {
    ...typography.bodySemibold,
    marginRight: spacing.xs,
    flex: 1,
  },
  listItemDescription: {
    ...typography.bodySmall,
    color: colors.textSecondary,
    marginBottom: spacing.xs,
  },
  listItemStats: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  listItemStatText: {
    ...typography.caption,
  },
  listItemStatDot: {
    ...typography.caption,
    marginHorizontal: spacing.xs,
  },
  listItemAction: {
    marginLeft: spacing.sm,
  },
});

export default StoreCard;
