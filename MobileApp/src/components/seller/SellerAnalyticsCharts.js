import React, { useId, useMemo, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, TouchableOpacity, useWindowDimensions, View } from 'react-native';
import Svg, { Circle, Defs, Line, LinearGradient, Path, Rect, Stop } from 'react-native-svg';
import { Ionicons } from '@expo/vector-icons';
import GlassPanel from '../common/GlassPanel';
import { useTheme } from '../../contexts/ThemeContext';
import { useCurrency } from '../../contexts/CurrencyContext';
import { borderRadius, fontSize, fontWeight, spacing } from '../../styles/theme';
import {
  analyticsDayLabel, buildAnalyticsPlot, categoryBarPercent, nearestAnalyticsDay, sortSellerStatuses,
} from '../../utils/sellerAnalyticsPresentation';

const CATEGORY_COLORS = ['#6366f1', '#10b981', '#0ea5e9', '#8b5cf6', '#f97316', '#ec4899'];
const statusColor = (name, palette) => ({
  pending: palette.colors.warning, confirmed: palette.colors.secondary,
  processing: palette.colors.info, shipped: palette.colors.primary,
  delivered: palette.colors.success, cancelled: palette.colors.error,
}[name] || palette.colors.textSecondary);

const ChartHeader = ({ title, subtitle, icon, color, styles }) => (
  <View style={styles.header}>
    <View style={styles.headerCopy}>
      <Text style={styles.title} accessibilityRole="header">{title}</Text>
      <Text style={styles.subtitle}>{subtitle}</Text>
    </View>
    <View style={[styles.icon, { backgroundColor: `${color}18` }]}>
      <Ionicons name={icon} size={20} color={color} />
    </View>
  </View>
);

export function SellerDailyChart({ rows, field, currency, title, subtitle, kind = 'area' }) {
  const { palette } = useTheme();
  const { formatAmount } = useCurrency();
  const { width: screenWidth } = useWindowDimensions();
  const styles = useMemo(() => buildStyles(palette), [palette]);
  const [width, setWidth] = useState(Math.max(120, Math.min(screenWidth, 680) - 64));
  const [selectedIndex, setSelectedIndex] = useState(rows.length - 1);
  const gradientId = `sellerTrend${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const plot = useMemo(() => buildAnalyticsPlot(rows, field, width), [rows, field, width]);
  const selected = plot.points[Math.max(0, Math.min(selectedIndex, plot.points.length - 1))];
  const color = field === 'revenue' ? palette.colors.success : palette.colors.primary;
  const displayValue = value => field === 'revenue' ? formatAmount(value, { targetCurrency: currency, showCode: true }) : `${value} ${value === 1 ? 'order' : 'orders'}`;
  const moveSelection = delta => setSelectedIndex(index => Math.max(0, Math.min(rows.length - 1, index + delta)));
  const barWidth = Math.max(1, Math.min(18, (plot.usableWidth / Math.max(1, rows.length)) * 0.6));

  return (
    <GlassPanel variant="card" style={styles.section}>
      <ChartHeader title={title} subtitle={subtitle} color={color} styles={styles}
        icon={field === 'revenue' ? 'trending-up-outline' : 'bar-chart-outline'} />
      <View style={styles.axisSummary}>
        <Text style={styles.axisText}>0</Text>
        <Text style={styles.axisText}>{field === 'revenue' ? `${currency} · ${rows.length} days` : `${rows.length} days`}</Text>
        <Text style={styles.axisText}>{field === 'revenue' ? formatAmount(Math.max(...rows.map(row => row[field]), 0), { targetCurrency: currency }) : Math.max(...rows.map(row => row[field]), 0)}</Text>
      </View>
      <Pressable onLayout={event => setWidth(Math.max(1, event.nativeEvent.layout.width))}
        onPress={event => setSelectedIndex(nearestAnalyticsDay(event.nativeEvent.locationX, width, rows.length))}
        accessibilityRole="adjustable" accessibilityLabel={`${title}, ${rows.length} daily values`}
        accessibilityHint="Tap the chart or use the previous and next day buttons to inspect exact daily values."
        accessibilityValue={{ min: 0, max: Math.max(0, rows.length - 1), now: selected?.index || 0,
          text: selected ? `${analyticsDayLabel(selected.date, true)}, ${displayValue(selected.value)}` : 'No daily values' }}
        accessibilityActions={[{ name: 'increment', label: 'Next day' }, { name: 'decrement', label: 'Previous day' }]}
        onAccessibilityAction={event => moveSelection(event.nativeEvent.actionName === 'increment' ? 1 : -1)}>
        <Svg width="100%" height={160} viewBox={`0 0 ${width} 160`} accessible={false}>
          <Defs><LinearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={color} stopOpacity={0.3} /><Stop offset="1" stopColor={color} stopOpacity={0.015} />
          </LinearGradient></Defs>
          {[0, 1, 2, 3].map(index => <Line key={index} x1={plot.inset} x2={width - plot.inset}
            y1={12 + index * (plot.baseline - 12) / 3} y2={12 + index * (plot.baseline - 12) / 3}
            stroke={palette.colors.textSecondary} strokeOpacity={0.15} strokeDasharray="3 5" />)}
          {kind === 'area' ? <>
            <Path d={plot.areaPath} fill={`url(#${gradientId})`} />
            <Path d={plot.linePath} stroke={color} strokeWidth={2.5} fill="none" strokeLinejoin="round" />
          </> : plot.points.filter(point => point.value > 0).map(point => <Rect key={point.date}
            x={point.x - barWidth / 2} y={point.y} width={barWidth} height={plot.baseline - point.y}
            rx={Math.min(4, barWidth / 2)} fill={color} fillOpacity={point.index === selected?.index ? 1 : 0.65} />)}
          {selected && <>
            <Line x1={selected.x} x2={selected.x} y1={12} y2={plot.baseline} stroke={color} strokeOpacity={0.45} strokeDasharray="3 4" />
            <Circle cx={selected.x} cy={selected.y} r={4.5} fill={color} stroke={palette.colors.surface} strokeWidth={2} />
          </>}
        </Svg>
      </Pressable>
      <View style={styles.dateAxis}>{plot.ticks.map(index => <Text key={rows[index].date} style={styles.axisText}>{analyticsDayLabel(rows[index].date)}</Text>)}</View>
      {selected && <View style={styles.selection}>
        <TouchableOpacity style={styles.dayButton} onPress={() => moveSelection(-1)} disabled={selected.index === 0}
          accessibilityRole="button" accessibilityLabel={`${title}: previous day`} accessibilityState={{ disabled: selected.index === 0 }}>
          <Ionicons name="chevron-back" size={19} color={selected.index === 0 ? palette.colors.textLight : color} />
        </TouchableOpacity>
        <View style={styles.selectionCopy} accessibilityLiveRegion="polite">
          <Text style={styles.selectionDate}>{analyticsDayLabel(selected.date, true)} · UTC</Text>
          <Text style={[styles.selectionValue, { color }]}>{displayValue(selected.value)}</Text>
        </View>
        <TouchableOpacity style={styles.dayButton} onPress={() => moveSelection(1)} disabled={selected.index === rows.length - 1}
          accessibilityRole="button" accessibilityLabel={`${title}: next day`} accessibilityState={{ disabled: selected.index === rows.length - 1 }}>
          <Ionicons name="chevron-forward" size={19} color={selected.index === rows.length - 1 ? palette.colors.textLight : color} />
        </TouchableOpacity>
      </View>}
      <Text style={styles.hint}>{rows.every(row => row[field] === 0)
        ? field === 'revenue' ? 'No recognized revenue in this period.' : 'No orders in this period.'
        : 'Tap the chart to inspect a day.'}</Text>
    </GlassPanel>
  );
}

const ProductThumbnail = ({ uri, styles, palette }) => {
  const [failed, setFailed] = useState(false);
  return typeof uri === 'string' && /^https:\/\//.test(uri) && !failed
    ? <Image source={{ uri }} style={styles.thumbnail} onError={() => setFailed(true)} accessible={false} />
    : <View style={styles.thumbnailFallback}><Ionicons name="cube-outline" size={21} color={palette.colors.primary} /></View>;
};

export default function SellerAnalyticsCharts({ analytics, days }) {
  const { palette } = useTheme();
  const { formatAmount } = useCurrency();
  const styles = useMemo(() => buildStyles(palette), [palette]);
  const statuses = sortSellerStatuses(analytics.statusBreakdown).filter(row => row.value > 0);
  const total = statuses.reduce((sum, row) => sum + row.value, 0);
  const circumference = 2 * Math.PI * 58;
  let offset = 0;
  const products = analytics.topProducts.slice(0, 6);

  return <>
    <SellerDailyChart key={`revenue-${days}`} rows={analytics.revenueByDay} field="revenue" currency={analytics.currency}
      title="Revenue Trend" subtitle={`Daily revenue over the last ${days} days`} />
    <SellerDailyChart key={`orders-${days}`} rows={analytics.revenueByDay} field="orders" currency={analytics.currency}
      title="Order Volume" subtitle="Daily orders received" kind="bars" />
    <GlassPanel variant="card" style={styles.section}>
      <ChartHeader title="Order Status" subtitle="Breakdown by current status" icon="pie-chart-outline" color={palette.colors.primary} styles={styles} />
      <View style={styles.donutFrame} accessibilityLabel={`${total} orders by current status`}>
        <Svg width={156} height={156} viewBox="0 0 156 156" accessible={false}>
          <Circle cx={78} cy={78} r={58} fill="none" stroke={palette.colors.textSecondary} strokeOpacity={0.1} strokeWidth={16} />
          {statuses.map(row => {
            const length = row.value / total * circumference;
            const currentOffset = offset; offset += length;
            return <Circle key={row.name} cx={78} cy={78} r={58} fill="none" stroke={statusColor(row.name, palette)} strokeWidth={16}
              strokeDasharray={`${length} ${circumference - length}`} strokeDashoffset={-currentOffset} rotation={-90} origin="78, 78" />;
          })}
        </Svg>
        <View style={styles.donutCenter} pointerEvents="none"><Text style={styles.donutTotal}>{total}</Text><Text style={styles.subtitle}>Orders</Text></View>
      </View>
      {statuses.length ? <View style={styles.legend}>{statuses.map(row => <View key={row.name} style={styles.legendRow}>
        <View style={[styles.dot, { backgroundColor: statusColor(row.name, palette) }]} />
        <Text style={styles.legendName}>{row.name.replace(/_/g, ' ')}</Text><Text style={styles.legendValue}>{row.value}</Text>
      </View>)}</View> : <Text style={styles.empty}>No orders in this period.</Text>}
    </GlassPanel>
    <GlassPanel variant="card" style={styles.section}>
      <ChartHeader title="Top Products" subtitle="By revenue generated" icon="star-outline" color={palette.colors.secondary} styles={styles} />
      {products.length ? products.map((product, index) => <View key={`${product.productId || product.name}-${index}`} style={[styles.productRow, index === products.length - 1 && styles.lastRow]}>
        <Text style={styles.rank}>#{index + 1}</Text>
        <ProductThumbnail key={product.image || 'no-image'} uri={product.image} styles={styles} palette={palette} />
        <View style={styles.productCopy}><Text style={styles.productName} numberOfLines={2}>{product.name}</Text>
          <Text style={styles.productMeta}>{product.sold} {product.sold === 1 ? 'unit' : 'units'} sold</Text>
          <Text style={styles.productRevenue}>{formatAmount(product.revenue, { targetCurrency: analytics.currency, showCode: true })}</Text>
        </View>
      </View>) : <Text style={styles.empty}>No sales data yet.</Text>}
    </GlassPanel>
    <GlassPanel variant="card" style={styles.section}>
      <ChartHeader title="Category Breakdown" subtitle="Products by category" icon="layers-outline" color={palette.colors.secondary} styles={styles} />
      {analytics.categoryBreakdown.length ? analytics.categoryBreakdown.map((category, index) => <View key={category.name} style={styles.category}>
        <View style={styles.categoryHeading}><Text style={styles.categoryName}>{category.name}</Text>
          <Text style={styles.productMeta}>{category.count} {category.count === 1 ? 'product' : 'products'}</Text></View>
        <View style={styles.categoryTrack}><View style={[styles.categoryBar, { width: `${categoryBarPercent(category, analytics.categoryBreakdown)}%`, backgroundColor: CATEGORY_COLORS[index % CATEGORY_COLORS.length] }]} /></View>
      </View>) : <Text style={styles.empty}>No products yet.</Text>}
    </GlassPanel>
  </>;
}

const buildStyles = palette => StyleSheet.create({
  section: { marginHorizontal: spacing.lg, marginTop: spacing.lg, padding: spacing.lg, borderRadius: borderRadius.xxl },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md, marginBottom: spacing.lg },
  headerCopy: { flex: 1 },
  title: { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: palette.colors.text },
  subtitle: { fontSize: fontSize.sm, lineHeight: 18, color: palette.colors.textSecondary, marginTop: 3 },
  icon: { width: 40, height: 40, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  axisSummary: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm, marginBottom: spacing.sm },
  axisText: { color: palette.colors.textSecondary, fontSize: 10, lineHeight: 15 },
  dateAxis: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 },
  selection: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.sm, marginTop: spacing.md, borderRadius: borderRadius.lg, backgroundColor: palette.glass.bgSubtle },
  dayButton: { width: 44, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  selectionCopy: { flex: 1, alignItems: 'center' },
  selectionDate: { fontSize: 11, lineHeight: 17, color: palette.colors.textSecondary },
  selectionValue: { fontSize: fontSize.md, lineHeight: 22, fontWeight: fontWeight.bold, fontVariant: ['tabular-nums'], textAlign: 'center' },
  hint: { fontSize: 10, lineHeight: 16, color: palette.colors.textSecondary, textAlign: 'center', marginTop: spacing.sm },
  donutFrame: { width: 156, height: 156, alignSelf: 'center', marginBottom: spacing.lg },
  donutCenter: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  donutTotal: { fontSize: 28, fontWeight: fontWeight.extrabold, color: palette.colors.text, fontVariant: ['tabular-nums'] },
  legend: { gap: spacing.md },
  legendRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  dot: { width: 8, height: 8, borderRadius: 4 },
  legendName: { flex: 1, textTransform: 'capitalize', color: palette.colors.textSecondary, fontSize: fontSize.sm },
  legendValue: { fontSize: fontSize.sm, color: palette.colors.text, fontWeight: fontWeight.bold, fontVariant: ['tabular-nums'] },
  empty: { color: palette.colors.textSecondary, fontSize: fontSize.sm, lineHeight: 20, textAlign: 'center', paddingVertical: spacing.xl },
  productRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.md, borderBottomWidth: 1, borderBottomColor: palette.colors.border },
  lastRow: { borderBottomWidth: 0, paddingBottom: 0 },
  rank: { width: 24, fontSize: 11, fontWeight: fontWeight.bold, color: palette.colors.textSecondary },
  thumbnail: { width: 44, height: 44, borderRadius: 12, backgroundColor: palette.glass.bgSubtle },
  thumbnailFallback: { width: 44, height: 44, borderRadius: 12, backgroundColor: palette.colors.primarySubtle, alignItems: 'center', justifyContent: 'center' },
  productCopy: { flex: 1, minWidth: 0 },
  productName: { fontSize: fontSize.sm, lineHeight: 19, fontWeight: fontWeight.semibold, color: palette.colors.text },
  productMeta: { fontSize: 11, lineHeight: 17, color: palette.colors.textSecondary, marginTop: 3 },
  productRevenue: { fontSize: fontSize.sm, lineHeight: 19, color: palette.colors.success, fontWeight: fontWeight.bold, marginTop: 3, fontVariant: ['tabular-nums'] },
  category: { marginTop: spacing.sm, marginBottom: spacing.md },
  categoryHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm, marginBottom: spacing.sm },
  categoryName: { flex: 1, fontSize: fontSize.sm, lineHeight: 18, color: palette.colors.text, textTransform: 'capitalize' },
  categoryTrack: { height: 7, borderRadius: 4, backgroundColor: palette.glass.bgSubtle, overflow: 'hidden' },
  categoryBar: { height: 7, borderRadius: 4 },
});
