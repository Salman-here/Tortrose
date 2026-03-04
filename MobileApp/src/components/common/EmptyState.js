/**
 * EmptyState Component — Liquid Glass Design
 */

import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import GlassPanel from './GlassPanel';
import { colors, spacing, fontSize, fontWeight, borderRadius } from '../../styles/theme';

const EmptyState = ({ icon = 'cube-outline', iconSize = 64, iconColor = colors.primaryLight, title, subtitle, actionLabel, onAction, secondaryActionLabel, onSecondaryAction, style, compact = false }) => {
  return (
    <View style={[styles.container, compact && styles.containerCompact, style]}>
      <GlassPanel variant="panel" style={styles.glassWrap}>
        <View style={[styles.iconContainer, compact && styles.iconContainerCompact]}>
          <Ionicons name={icon} size={compact ? 48 : iconSize} color={iconColor} />
        </View>
        {title && <Text style={[styles.title, compact && styles.titleCompact]}>{title}</Text>}
        {subtitle && <Text style={[styles.subtitle, compact && styles.subtitleCompact]}>{subtitle}</Text>}
        {(actionLabel || secondaryActionLabel) && (
          <View style={styles.actionsContainer}>
            {actionLabel && onAction && (
              <TouchableOpacity style={styles.actionButton} onPress={onAction} activeOpacity={0.8}>
                <Text style={styles.actionButtonText}>{actionLabel}</Text>
              </TouchableOpacity>
            )}
            {secondaryActionLabel && onSecondaryAction && (
              <TouchableOpacity style={styles.secondaryButton} onPress={onSecondaryAction} activeOpacity={0.8}>
                <Text style={styles.secondaryButtonText}>{secondaryActionLabel}</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
      </GlassPanel>
    </View>
  );
};

export const EmptyCart = ({ onBrowse, onAction }) => <EmptyState icon="cart-outline" title="Your cart is empty" subtitle="Looks like you haven't added any items to your cart yet" actionLabel="Browse Products" onAction={onBrowse || onAction} />;
export const EmptyWishlist = ({ onBrowse }) => <EmptyState icon="heart-outline" title="Your wishlist is empty" subtitle="Save items you love by tapping the heart icon" actionLabel="Discover Products" onAction={onBrowse} />;
export const EmptyOrders = ({ onBrowse }) => <EmptyState icon="receipt-outline" title="No orders yet" subtitle="When you place an order, it will appear here" actionLabel="Start Shopping" onAction={onBrowse} />;
export const EmptyProducts = ({ onAdd }) => <EmptyState icon="cube-outline" title="No products yet" subtitle="Add your first product to start selling" actionLabel={onAdd ? "Add Product" : undefined} onAction={onAdd} />;
export const EmptyStores = ({ onRefresh }) => <EmptyState icon="storefront-outline" title="No stores found" subtitle="Try adjusting your search or check back later" actionLabel="Refresh" onAction={onRefresh} />;
export const EmptySearch = ({ query, onClear }) => <EmptyState icon="search-outline" title="No results found" subtitle={query ? `We couldn't find anything for "${query}"` : 'Try a different search term'} actionLabel="Clear Search" onAction={onClear} />;
export const EmptyNotifications = () => <EmptyState icon="notifications-outline" title="No notifications" subtitle="You're all caught up!" />;
export const ErrorState = ({ message, onRetry }) => <EmptyState icon="alert-circle-outline" iconColor={colors.error} title="Something went wrong" subtitle={message || "We couldn't load the content. Please try again."} actionLabel="Try Again" onAction={onRetry} />;
export const OfflineState = ({ onRetry }) => <EmptyState icon="cloud-offline-outline" iconColor={colors.warning} title="You're offline" subtitle="Please check your internet connection and try again" actionLabel="Retry" onAction={onRetry} />;
export const LoginRequired = ({ onLogin, onBrowse, onAction }) => <EmptyState icon="person-outline" title="Login Required" subtitle="Please sign in to access this feature" actionLabel="Sign In" onAction={onLogin || onAction} secondaryActionLabel="Continue Browsing" onSecondaryAction={onBrowse} />;

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: spacing.xl, paddingVertical: spacing.xxl },
  containerCompact: { paddingVertical: spacing.xl },
  glassWrap: { padding: spacing.xxl, alignItems: 'center', width: '100%' },
  iconContainer: { width: 100, height: 100, borderRadius: 50, backgroundColor: 'rgba(255,255,255,0.1)', justifyContent: 'center', alignItems: 'center', marginBottom: spacing.xl },
  iconContainerCompact: { width: 72, height: 72, borderRadius: 36, marginBottom: spacing.md },
  title: { fontSize: fontSize.xxl, fontWeight: fontWeight.bold, color: colors.text, textAlign: 'center', marginBottom: spacing.sm },
  titleCompact: { fontSize: fontSize.lg },
  subtitle: { fontSize: fontSize.md, color: colors.textSecondary, textAlign: 'center', maxWidth: 280, lineHeight: 22 },
  subtitleCompact: { fontSize: fontSize.sm, maxWidth: 240 },
  actionsContainer: { marginTop: spacing.xl, alignItems: 'center', gap: spacing.md },
  actionButton: { backgroundColor: colors.primary, paddingHorizontal: spacing.xxl, paddingVertical: spacing.md, borderRadius: borderRadius.xl, minWidth: 160, alignItems: 'center' },
  actionButtonText: { color: colors.white, fontSize: fontSize.md, fontWeight: fontWeight.bold },
  secondaryButton: { borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.25)', paddingHorizontal: spacing.xxl, paddingVertical: spacing.md, borderRadius: borderRadius.xl, minWidth: 160, alignItems: 'center' },
  secondaryButtonText: { color: colors.primary, fontSize: fontSize.md, fontWeight: fontWeight.semibold },
});

export default EmptyState;
