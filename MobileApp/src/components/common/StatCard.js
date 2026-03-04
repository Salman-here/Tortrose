/**
 * StatCard Component — Liquid Glass Design
 * Dashboard statistics display card with glass styling
 */

import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import GlassPanel from './GlassPanel';
import {
  colors,
  spacing,
  fontSize,
  fontWeight,
  borderRadius,
  glass,
  typography,
} from '../../styles/theme';

const StatCard = ({
  title,
  value,
  icon,
  iconColor = colors.primary,
  iconBgColor,
  trend,
  onPress,
  style,
  compact = false,
}) => {
  const Container = onPress ? TouchableOpacity : View;
  const containerProps = onPress ? { onPress, activeOpacity: 0.7 } : {};

  const formatValue = (val) => {
    if (typeof val === 'number') {
      if (val >= 1000000) return `${(val / 1000000).toFixed(1)}M`;
      if (val >= 1000) return `${(val / 1000).toFixed(1)}K`;
      return val.toLocaleString();
    }
    return val;
  };

  return (
    <Container {...containerProps} style={style}>
      <GlassPanel variant="card" style={[styles.container, compact && styles.containerCompact]}>
        <View style={[styles.iconContainer, { backgroundColor: iconBgColor || `${iconColor}20` }]}>  
          <Ionicons name={icon} size={compact ? 20 : 24} color={iconColor} />
        </View>
        <View style={styles.content}>
          <Text style={[styles.value, compact && styles.valueCompact]} numberOfLines={1}>
            {formatValue(value)}
          </Text>
          <Text style={[styles.title, compact && styles.titleCompact]} numberOfLines={1}>
            {title}
          </Text>
          {trend && (
            <View style={styles.trendContainer}>
              <Ionicons
                name={trend.isPositive ? 'trending-up' : 'trending-down'}
                size={14}
                color={trend.isPositive ? colors.success : colors.error}
              />
              <Text style={[styles.trendText, { color: trend.isPositive ? colors.success : colors.error }]}>
                {trend.isPositive ? '+' : ''}{trend.value}%
              </Text>
            </View>
          )}
        </View>
        {onPress && (
          <Ionicons name="chevron-forward" size={20} color="rgba(255,255,255,0.4)" style={styles.chevron} />
        )}
      </GlassPanel>
    </Container>
  );
};

export const RevenueStatCard = ({ value, trend, onPress }) => (
  <StatCard title="Revenue" value={`$${typeof value === 'number' ? value.toLocaleString() : value}`} icon="cash-outline" iconColor={colors.success} trend={trend} onPress={onPress} />
);
export const OrdersStatCard = ({ value, trend, onPress }) => (
  <StatCard title="Total Orders" value={value} icon="receipt-outline" iconColor={colors.info} trend={trend} onPress={onPress} />
);
export const ProductsStatCard = ({ value, trend, onPress }) => (
  <StatCard title="Products" value={value} icon="cube-outline" iconColor={colors.secondary} trend={trend} onPress={onPress} />
);
export const UsersStatCard = ({ value, trend, onPress }) => (
  <StatCard title="Total Users" value={value} icon="people-outline" iconColor={colors.primary} trend={trend} onPress={onPress} />
);
export const StoresStatCard = ({ value, trend, onPress }) => (
  <StatCard title="Total Stores" value={value} icon="storefront-outline" iconColor={colors.warning} trend={trend} onPress={onPress} />
);
export const PendingOrdersStatCard = ({ value, onPress }) => (
  <StatCard title="Pending Orders" value={value} icon="time-outline" iconColor={colors.warning} onPress={onPress} />
);

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.lg,
  },
  containerCompact: {
    padding: spacing.md,
    minWidth: 120,
  },
  iconContainer: {
    width: 48,
    height: 48,
    borderRadius: borderRadius.inner,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: spacing.md,
  },
  content: {
    flex: 1,
  },
  value: {
    fontSize: fontSize.xxl,
    fontWeight: fontWeight.bold,
    color: colors.text,
    marginBottom: spacing.xs,
  },
  valueCompact: {
    fontSize: fontSize.xl,
  },
  title: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
  },
  titleCompact: {
    fontSize: fontSize.xs,
  },
  trendContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing.xs,
  },
  trendText: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.medium,
    marginLeft: spacing.xs,
  },
  chevron: {
    marginLeft: spacing.sm,
  },
});

export default StatCard;
