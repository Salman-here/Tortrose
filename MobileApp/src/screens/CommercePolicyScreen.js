import React from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, Platform, Linking, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import GlassBackground from '../components/common/GlassBackground';
import GlassPanel from '../components/common/GlassPanel';
import PremiumBackHeader from '../components/common/PremiumBackHeader';
import { useTheme } from '../contexts/ThemeContext';
import { commercePolicies, policyConfig, policyPublicationReady } from '../content/commercePolicies';

export default function CommercePolicyScreen({ navigation, route, policy = 'terms' }) {
  const key = route?.params?.policy || Object.keys(commercePolicies).find(value => commercePolicies[value].screen === route?.name) || policy;
  const document = commercePolicies[key] || commercePolicies.terms;
  const { palette } = useTheme();
  const styles = makeStyles(palette);
  const open = url => Linking.openURL(url).catch(() => Alert.alert('Contact support', `${policyConfig.supportEmail}${policyConfig.supportPhone ? ` · ${policyConfig.supportPhone}` : ''}`));
  return <GlassBackground><SafeAreaView style={styles.container} edges={Platform.OS === 'android' ? [] : ['top']}>
    <PremiumBackHeader title={document.title} subtitle={`Updated ${policyConfig.updatedAt}`} icon={document.icon} onBack={() => navigation.goBack()} rightIcon="shield-checkmark-outline" rightLabel="Legal" />
    <ScrollView contentContainerStyle={styles.content}>
      {!policyPublicationReady && <GlassPanel style={styles.panel}><Text style={styles.text}>Draft policy update — business details and service timelines are awaiting merchant confirmation. This draft is not approved for publication.</Text></GlassPanel>}
      <GlassPanel style={styles.panel}><Text style={styles.text}>{document.description}</Text></GlassPanel>
      {document.sections.map(section => <GlassPanel key={section.title} style={styles.panel}><Text accessibilityRole="header" style={styles.title}>{section.title}</Text><Text style={styles.text}>{section.content}</Text></GlassPanel>)}
      <GlassPanel style={styles.panel}><Text accessibilityRole="header" style={styles.title}>Customer support</Text><TouchableOpacity accessibilityRole="link" onPress={() => open(`mailto:${policyConfig.supportEmail}`)}><Text style={styles.link}>{policyConfig.supportEmail}</Text></TouchableOpacity>{!!policyConfig.supportPhone && <TouchableOpacity accessibilityRole="link" onPress={() => open(`tel:${policyConfig.supportPhone.replace(/[^+\d]/g, '')}`)}><Text style={styles.link}>{policyConfig.supportPhone}</Text></TouchableOpacity>}
        {Object.entries(commercePolicies).filter(([name]) => name !== key).map(([name, doc]) => <TouchableOpacity key={name} accessibilityRole="link" onPress={() => navigation.navigate(doc.screen)}><Text style={styles.link}>{doc.title} →</Text></TouchableOpacity>)}
        <TouchableOpacity accessibilityRole="link" onPress={() => navigation.navigate('PrivacyPolicy')}><Text style={styles.link}>Privacy Policy →</Text></TouchableOpacity>
        <TouchableOpacity accessibilityRole="link" onPress={() => navigation.navigate('Contact')}><Text style={styles.link}>Contact us →</Text></TouchableOpacity>
      </GlassPanel>
    </ScrollView>
  </SafeAreaView></GlassBackground>;
}
const makeStyles = p => StyleSheet.create({
  container: { flex: 1 }, content: { padding: 16, paddingBottom: 100 }, panel: { marginBottom: 16, padding: 20 },
  title: { color: p.colors.text, fontSize: 18, fontWeight: '600', marginBottom: 12 },
  text: { color: p.colors.textSecondary, fontSize: 14, lineHeight: 22 },
  link: { color: p.colors.primary, fontSize: 14, lineHeight: 22, paddingVertical: 10 },
});
