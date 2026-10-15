import React from 'react';
import { Text, StyleSheet, ScrollView, TouchableOpacity, Platform, Linking, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import GlassBackground from '../components/common/GlassBackground';
import GlassPanel from '../components/common/GlassPanel';
import PremiumBackHeader from '../components/common/PremiumBackHeader';
import { useTheme } from '../contexts/ThemeContext';
import { policyConfig } from '../content/commercePolicies';
import { paymentPrivacyNotice, privacyIntro, privacySections } from '../content/privacyContent';

export default function PrivacyPolicyScreen({ navigation }) {
  const { palette } = useTheme();
  const styles = makeStyles(palette);
  const open = url => Linking.openURL(url).catch(() => Alert.alert('Privacy support', 'Contact privacy@rozare.com for help.'));
  return <GlassBackground><SafeAreaView style={styles.container} edges={Platform.OS === 'android' ? [] : ['top']}>
    <PremiumBackHeader title="Privacy Policy" subtitle={`Updated ${policyConfig.updatedAt}`} icon="shield-checkmark-outline" onBack={() => navigation.goBack()} rightIcon="lock-closed-outline" rightLabel="Privacy" />
    <ScrollView contentContainerStyle={styles.content}>
      <GlassPanel style={styles.panel}><Text style={styles.text}>{privacyIntro}</Text></GlassPanel>
      <GlassPanel style={styles.panel}><Text accessibilityRole="header" style={styles.title}>Who operates Rozare and handles payments</Text><Text style={styles.text}>{paymentPrivacyNotice}</Text></GlassPanel>
      {privacySections.map(section => <GlassPanel key={section.id} style={styles.panel}><Text accessibilityRole="header" style={styles.title}>{section.title}</Text><Text style={styles.text}>{section.content}</Text></GlassPanel>)}
      <GlassPanel style={styles.panel}><Text accessibilityRole="header" style={styles.title}>Privacy support</Text><TouchableOpacity accessibilityRole="link" onPress={() => open('mailto:privacy@rozare.com')} style={styles.linkButton}><Text style={styles.link}>privacy@rozare.com</Text></TouchableOpacity><TouchableOpacity accessibilityRole="link" onPress={() => navigation.navigate('TermsOfService')} style={styles.linkButton}><Text style={styles.link}>Terms and Conditions</Text></TouchableOpacity><TouchableOpacity accessibilityRole="link" onPress={() => open('https://rozare.com/account-deletion')} style={styles.linkButton}><Text style={styles.link}>Account-deletion instructions</Text></TouchableOpacity><TouchableOpacity accessibilityRole="link" onPress={() => navigation.navigate('Contact')} style={styles.linkButton}><Text style={styles.link}>Contact support</Text></TouchableOpacity></GlassPanel>
    </ScrollView>
  </SafeAreaView></GlassBackground>;
}
const makeStyles = p => StyleSheet.create({ container: { flex: 1 }, content: { padding: 16, paddingBottom: 100 }, panel: { padding: 20, marginBottom: 16 }, title: { fontSize: 17, fontWeight: '600', color: p.colors.text, marginBottom: 12 }, text: { fontSize: 14, lineHeight: 23, color: p.colors.textSecondary }, linkButton: { paddingVertical: 10 }, link: { fontSize: 14, color: p.colors.primary, textDecorationLine: 'underline' } });
