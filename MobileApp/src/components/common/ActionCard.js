/**
 * ActionCard Component
 * Dashboard quick action navigation card
 * 
 * Requirements: 17.3, 17.4, 24.3, 24.4
 */

import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
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

const ActionCard = ({
  title,
  subtitle,
  icon,
  color = colors.primary,
  onPress,
  badge,
  disabled = false,
  style,
}) => {
  return (
    <TouchableOpacity
      style={[
        styles.container,
        { borderLeftColor: color },
        disabled && styles.containerDisabled,
        style,
      ]}
      onPress={onPress}
      activeOpacity={0.7}
      disabled={disabled}
    >
      {/* Icon */}
      <View style={[styles.iconContainer, { backgroundColor: `${color}20` }]}>
        <Ionicons name={icon} size={24} color={color} />
      </View>

      {/* Content */}
      <View style={styles.content}>
        <Text style={[styles.title, disabled && styles.titleDisabled]} numberOfLines={1}>
          {title}
        </Text>
        {subtitle && (
          <Text style={styles.subtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        )}
      </View>

      {/* Badge */}
      {badge !== undefined && badge > 0 && (
        <View style={[styles.badge, { backgroundColor: color }]}>
          <Text style={styles.badgeText}>
            {badge > 99 ? '99+' : badge}
          </Text>
        </View>
      )}

      {/* Chevron */}
      <Ionicons
        name="chevron-forward"
        size={20}
        color={disabled ? colors.grayLighter : colors.grayLight}
      />
    </TouchableOpacity>
  );
};

// Preset action cards for seller dashboard
export const StoreOverviewAction = ({ onPress, badge }) => (
  <ActionCard
    title="Store Overview"
    subtitle="View your store details"
    icon="storefront-outline"
    color={colors.primary}
    onPress={onPress}
    badge={badge}
  />
);

export const ProductManagementAction = ({ onPress, badge }) => (
  <ActionCard
    title="Product Management"
    subtitle="Manage your products"
    icon="cube-outline"
    color={colors.secondary}
    onPress={onPress}
    badge={badge}
  />
);

export const OrderManagementAction = ({ onPress, badge }) => (
  <ActionCard
    title="Order Management"
    subtitle="View and manage orders"
    icon="receipt-outline"
    color={colors.info}
    onPress={onPress}
    badge={badge}
  />
);

export const StoreSettingsAction = ({ onPress }) => (
  <ActionCard
    title="Store Settings"
    subtitle="Update store information"
    icon="settings-outline"
    color={colors.gray}
    onPress={onPress}
  />
);

export const ShippingConfigAction = ({ onPress }) => (
  <ActionCard
    title="Shipping Configuration"
    subtitle="Manage shipping methods"
    icon="car-outline"
    color={colors.warning}
    onPress={onPress}
  />
);

export const StoreAnalyticsAction = ({ onPress }) => (
  <ActionCard
    title="Store Analytics"
    subtitle="Views, sales & performance"
    icon="bar-chart-outline"
    color={colors.info}
    onPress={onPress}
  />
);

// Preset action cards for admin dashboard
export const UserManagementAction = ({ onPress, badge }) => (
  <ActionCard
    title="User Management"
    subtitle="Manage platform users"
    icon="people-outline"
    color={colors.primary}
    onPress={onPress}
    badge={badge}
  />
);

export const TaxConfigAction = ({ onPress }) => (
  <ActionCard
    title="Tax Configuration"
    subtitle="Manage tax settings"
    icon="calculator-outline"
    color={colors.success}
    onPress={onPress}
  />
);

export const StoreVerificationAction = ({ onPress, badge }) => (
  <ActionCard
    title="Store Verification"
    subtitle="Verify seller stores"
    icon="shield-checkmark-outline"
    color={colors.info}
    onPress={onPress}
    badge={badge}
  />
);

export const AdminProductsAction = ({ onPress }) => (
  <ActionCard
    title="All Products"
    subtitle="View all platform products"
    icon="grid-outline"
    color={colors.secondary}
    onPress={onPress}
  />
);

export const AdminOrdersAction = ({ onPress, badge }) => (
  <ActionCard
    title="All Orders"
    subtitle="View all platform orders"
    icon="list-outline"
    color={colors.warning}
    onPress={onPress}
    badge={badge}
  />
);

export const AdminStoresAction = ({ onPress }) => (
  <ActionCard
    title="All Stores"
    subtitle="View all seller stores"
    icon="business-outline"
    color={colors.error}
    onPress={onPress}
  />
);

const styles = StyleSheet.create({
  container: {
    ...cardStyles.action,
    borderLeftWidth: 4,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  containerDisabled: {
    opacity: 0.5,
  },
  iconContainer: {
    width: 44,
    height: 44,
    borderRadius: borderRadius.lg,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: spacing.md,
  },
  content: {
    flex: 1,
  },
  title: {
    ...typography.bodySemibold,
    marginBottom: spacing.xs,
  },
  titleDisabled: {
    color: colors.grayLight,
  },
  subtitle: {
    ...typography.bodySmall,
    color: colors.textSecondary,
  },
  badge: {
    minWidth: 24,
    height: 24,
    borderRadius: borderRadius.full,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    marginRight: spacing.sm,
  },
  badgeText: {
    color: colors.white,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
  },
});

export default ActionCard;
