/**
 * ActionCard Component — Liquid Glass Design (themed)
 */

import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import GlassPanel from './GlassPanel';
import { useTheme } from '../../contexts/ThemeContext';
import { spacing, fontSize, fontWeight, borderRadius } from '../../styles/theme';

const ActionCard = ({ title, subtitle, icon, color, onPress, badge, disabled = false, style }) => {
  const { palette } = useTheme();
  const colors = palette.colors;
  const styles = makeStyles(palette);
  const accentColor = color || colors.primary;
  const chevronColor = disabled ? colors.textLight : colors.textSecondary;
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.7} disabled={disabled} style={style}>
      <GlassPanel variant="card" style={[styles.container, disabled && styles.containerDisabled]}>
        <View style={[styles.accentBar, { backgroundColor: accentColor }]} />
        <View style={[styles.iconContainer, { backgroundColor: `${accentColor}20` }]}>
          <Ionicons name={icon} size={24} color={accentColor} />
        </View>
        <View style={styles.content}>
          <Text style={[styles.title, disabled && styles.titleDisabled]} numberOfLines={1}>{title}</Text>
          {subtitle && <Text style={styles.subtitle} numberOfLines={2}>{subtitle}</Text>}
        </View>
        {badge !== undefined && badge > 0 && (
          <View style={[styles.badge, { backgroundColor: accentColor }]}>
            <Text style={styles.badgeText}>{badge > 99 ? '99+' : badge}</Text>
          </View>
        )}
        <Ionicons name="chevron-forward" size={20} color={chevronColor} />
      </GlassPanel>
    </TouchableOpacity>
  );
};

// Use static colors for hardcoded role-card variants — they read fine on either palette
import { colors as staticColors } from '../../styles/theme';
export const StoreOverviewAction = ({ onPress, badge }) => <ActionCard title="Store Overview" subtitle="View your store details" icon="storefront-outline" color={staticColors.primary} onPress={onPress} badge={badge} />;
export const ProductManagementAction = ({ onPress, badge }) => <ActionCard title="Product Management" subtitle="Manage your products" icon="cube-outline" color={staticColors.secondary} onPress={onPress} badge={badge} />;
export const OrderManagementAction = ({ onPress, badge }) => <ActionCard title="Order Management" subtitle="View and manage orders" icon="receipt-outline" color={staticColors.info} onPress={onPress} badge={badge} />;
export const StoreSettingsAction = ({ onPress }) => <ActionCard title="Store Settings" subtitle="Update store information" icon="settings-outline" color={staticColors.gray} onPress={onPress} />;
export const ShippingConfigAction = ({ onPress }) => <ActionCard title="Shipping Configuration" subtitle="Manage shipping methods" icon="car-outline" color={staticColors.warning} onPress={onPress} />;
export const StoreAnalyticsAction = ({ onPress }) => <ActionCard title="Store Analytics" subtitle="Views, sales & performance" icon="bar-chart-outline" color={staticColors.info} onPress={onPress} />;

const makeStyles = (palette) => { const colors = palette.colors; return StyleSheet.create({
  container: { flexDirection: 'row', alignItems: 'center', padding: spacing.md, marginBottom: spacing.sm, overflow: 'hidden' },
  containerDisabled: { opacity: 0.5 },
  accentBar: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, borderTopLeftRadius: 22, borderBottomLeftRadius: 22 },
  iconContainer: { width: 40, height: 40, borderRadius: borderRadius.lg, justifyContent: 'center', alignItems: 'center', marginRight: spacing.md },
  content: { flex: 1 },
  title: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.text, marginBottom: spacing.xs },
  titleDisabled: { color: colors.textLight },
  subtitle: { fontSize: fontSize.sm, color: colors.textSecondary },
  badge: { minWidth: 24, height: 24, borderRadius: 12, justifyContent: 'center', alignItems: 'center', paddingHorizontal: spacing.sm, marginRight: spacing.sm },
  badgeText: { color: '#ffffff', fontSize: fontSize.xs, fontWeight: fontWeight.bold },
}); };

export default ActionCard;
