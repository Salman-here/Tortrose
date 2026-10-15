import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, LayoutAnimation, Platform, UIManager } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import GlassBackground from '../components/common/GlassBackground';
import GlassPanel from '../components/common/GlassPanel';
import PremiumBackHeader from '../components/common/PremiumBackHeader';
import { spacing, fontSize, fontWeight, borderRadius } from '../styles/theme';
import { useTheme } from '../contexts/ThemeContext';
import { commerceFaqCategories } from '../content/commerceHelpContent';

if (Platform.OS === 'android' && !globalThis.nativeFabricUIManager && UIManager.setLayoutAnimationEnabledExperimental) UIManager.setLayoutAnimationEnabledExperimental(true);

function FAQItem({ item, styles, palette, navigation }) {
  const [open, setOpen] = useState(false);
  const toggle = () => { LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut); setOpen(value => !value); };
  return <View style={styles.faqItem}>
    <TouchableOpacity accessibilityRole="button" accessibilityLabel={item.q} accessibilityState={{ expanded: open }} style={styles.faqHeader} onPress={toggle} activeOpacity={0.7}>
      <Text style={styles.faqQuestion}>{item.q}</Text><Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={16} color={palette.colors.textSecondary} />
    </TouchableOpacity>
    {open && <View><Text style={styles.faqAnswer}>{item.a}</Text><View style={styles.answerLinks}>{item.links.map(link => <TouchableOpacity key={link.path} accessibilityRole="link" onPress={() => navigation.navigate(link.screen)} style={styles.answerLink}><Text style={styles.link}>{link.label}</Text></TouchableOpacity>)}</View></View>}
  </View>;
}
export default function FAQScreen({ navigation }) {
  const { palette } = useTheme();
  const styles = buildStyles(palette);
  return <GlassBackground><SafeAreaView style={styles.container} edges={Platform.OS === 'android' ? [] : ['top']}>
    <PremiumBackHeader title="FAQ" subtitle="Help Centre" icon="help-circle-outline" onBack={() => navigation.goBack()} rightIcon="chatbubble-ellipses-outline" rightLabel="Help" style={styles.premiumHeader} />
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
      <Text style={styles.heroText}>Clear answers for shopping and selling on Rozare.</Text>
      {commerceFaqCategories.map(category => <GlassPanel key={category.id} variant="card" style={styles.categoryCard}>
        <View style={styles.categoryHeader}><Ionicons name={category.icon} size={20} color={palette.colors.primary} /><Text accessibilityRole="header" style={styles.categoryTitle}>{category.category}</Text></View>
        {category.questions.map(item => <FAQItem key={item.id} item={item} styles={styles} palette={palette} navigation={navigation} />)}
      </GlassPanel>)}
      <GlassPanel variant="card" style={styles.ctaCard}><Text style={styles.heroText}>Need help with a specific order or case?</Text><TouchableOpacity accessibilityRole="link" style={styles.ctaBtn} onPress={() => navigation.navigate('Contact')}><Text style={styles.ctaBtnText}>Contact Support</Text></TouchableOpacity></GlassPanel>
    </ScrollView>
  </SafeAreaView></GlassBackground>;
}
const buildStyles = p => StyleSheet.create({
  container: { flex: 1 }, premiumHeader: { marginTop: spacing.sm }, scrollContent: { paddingHorizontal: spacing.md, paddingTop: spacing.md, paddingBottom: 100 },
  heroText: { fontSize: fontSize.md, color: p.colors.textSecondary, textAlign: 'center', marginBottom: spacing.lg },
  categoryCard: { overflow: 'hidden', marginBottom: spacing.md }, categoryHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.md },
  categoryTitle: { fontSize: fontSize.lg, fontWeight: fontWeight.semibold, color: p.colors.text, flex: 1 },
  faqItem: { backgroundColor: p.colors.surface || 'rgba(255,255,255,0.08)', borderRadius: borderRadius.lg, padding: spacing.md, marginBottom: spacing.sm },
  faqHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 40 }, faqQuestion: { fontSize: fontSize.md, fontWeight: fontWeight.medium, color: p.colors.text, flex: 1, marginRight: spacing.sm },
  faqAnswer: { fontSize: fontSize.sm, color: p.colors.textSecondary, marginTop: spacing.sm, lineHeight: 21 }, answerLinks: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 16 }, answerLink: { paddingVertical: 10 }, link: { color: p.colors.primary, fontSize: fontSize.sm, textDecorationLine: 'underline' },
  ctaCard: { alignItems: 'center', marginTop: spacing.md }, ctaBtn: { backgroundColor: p.colors.primary, paddingHorizontal: spacing.xl, paddingVertical: spacing.md, borderRadius: borderRadius.lg }, ctaBtnText: { color: p.colors.white, fontWeight: fontWeight.semibold },
});
