/**
 * HomeCatalogSkeleton — catalog-shaped loading state that preserves the final
 * grid rhythm, count pill and card geometry while product requests are pending.
 */
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useTheme } from '../../contexts/ThemeContext';
import { spacing, borderRadius } from '../../styles/theme';
import { ProductCardSkeleton, Skeleton } from './Skeleton';

export default function HomeCatalogSkeleton({ count = 6 }) {
  const { palette } = useTheme();
  const styles = makeStyles(palette);

  return (
    <View style={styles.wrap} accessibilityLabel="Loading products">
      <View style={styles.header}>
        <View style={styles.titleStack}>
          <Skeleton width={72} height={9} radius={5} />
          <Skeleton width={142} height={22} radius={8} />
        </View>
        <View style={styles.countPill}>
          <Skeleton width={48} height={10} radius={5} />
        </View>
      </View>

      <View style={styles.statusCard}>
        <LinearGradient
          colors={['rgba(20,184,166,0.10)', 'rgba(14,165,233,0.04)', 'rgba(99,102,241,0.10)']}
          style={StyleSheet.absoluteFill}
        />
        <View style={styles.statusIcon}><Skeleton width={20} height={20} radius={7} /></View>
        <View style={styles.statusCopy}>
          <Skeleton width="48%" height={12} radius={6} />
          <Skeleton width="72%" height={9} radius={5} />
        </View>
      </View>

      <View style={styles.grid}>
        {Array.from({ length: count }).map((_, index) => (
          <View key={index} style={styles.cardCell}>
            <ProductCardSkeleton />
          </View>
        ))}
      </View>
    </View>
  );
}

const makeStyles = (palette) => StyleSheet.create({
  wrap: { paddingBottom: spacing.lg },
  header: { minHeight: 66, paddingHorizontal: spacing.lg, paddingVertical: spacing.md, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  titleStack: { gap: 7 },
  countPill: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: borderRadius.full, backgroundColor: palette.glass.bgSubtle, borderWidth: 1, borderColor: palette.glass.borderSubtle },
  statusCard: { marginHorizontal: spacing.lg, marginBottom: spacing.md, minHeight: 58, overflow: 'hidden', flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.sm, borderRadius: borderRadius.xl, backgroundColor: palette.glass.bg, borderWidth: 1, borderColor: palette.glass.border },
  statusIcon: { width: 38, height: 38, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.colors.primarySubtle },
  statusCopy: { flex: 1, gap: 7 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: spacing.md },
  cardCell: { width: '50%', padding: 2 },
});
