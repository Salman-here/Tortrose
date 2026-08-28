/**
 * PrivacyPolicyScreen — Liquid Glass Design
 */

import React from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Platform, Linking } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import GlassBackground from '../components/common/GlassBackground';
import GlassPanel from '../components/common/GlassPanel';
import PremiumBackHeader from '../components/common/PremiumBackHeader';
import { spacing, fontSize, fontWeight, borderRadius } from '../styles/theme';
import { useTheme } from '../contexts/ThemeContext';

const sections = [
  { icon: 'server-outline', title: '1. Information We Collect', content: 'We collect account and profile details such as your name, email address, avatar, phone or WhatsApp number, saved shipping addresses, preferences, and seller business or store information. We collect order, cart, Wallet, payment-status, refund, return, product, review, support, report, and account-blocking records created when you use Rozare. Payment card details are handled by our payment processors; Rozare receives transaction references and payment status needed to complete and support a purchase.' },
  { icon: 'eye-outline', title: '2. How We Use Your Information', content: 'We use information to operate accounts and stores; show relevant products; process purchases, payments, deliveries, returns, refunds, and seller settlements; preserve carts and chat history; send service, email, push, and optional WhatsApp updates; provide support; investigate reports; enforce safety rules; prevent fraud; measure performance and advertising; improve Rozare; and meet legal obligations.' },
  { icon: 'person-outline', title: '3. Information Sharing', content: 'We share only what is needed with sellers and delivery providers to fulfill orders; payment processors to complete transactions; cloud hosting, storage, email, push-notification, customer-support, and WhatsApp service providers; and analytics or advertising-measurement partners, including Meta or TikTok when those integrations are enabled. We may disclose information to authorities or other parties when required by law, to protect users, or during a business transfer. We do not sell personal information for money.' },
  { icon: 'lock-closed-outline', title: '4. Data Security', content: 'We use safeguards such as encrypted network connections, restricted access, secure credential storage, payment processing through specialist providers, monitoring, and backups. No online system is completely risk-free, so protect your password and contact security@rozare.com if you believe your account has been compromised.' },
  { icon: 'notifications-outline', title: '5. Cookies & Tracking', content: 'We use cookies, local storage, mobile identifiers, pixels, and similar technologies for sign-in, security, preferences, cart continuity, performance, analytics, and marketing measurement. Depending on your settings, Meta or TikTok technologies may receive event, device, page, or purchase information for measurement. Browser and device controls may limit some technologies, though essential features may then work differently.' },
  { icon: 'shield-checkmark-outline', title: '6. Your Rights', content: 'Depending on your location, you may be entitled to access, correct, delete, or receive a copy of personal data; object to or restrict certain processing; or withdraw consent. You can update common account information in Rozare. You can delete your account in the app under Settings, or use our public account-deletion page. Contact privacy@rozare.com for other requests; we may verify your identity before acting.' },
  { icon: 'trash-outline', title: '7. Data Retention', content: 'We retain active account and chat data while needed to provide Rozare. When you delete an account, we delete or de-identify data that is not required for fraud prevention, safety investigations, tax, accounting, payment, dispute, or other legal obligations. Order and transaction records may therefore be retained for the legally required period. Moderation reports and security logs may be retained as necessary to protect users and document enforcement decisions.' },
  { icon: 'globe-outline', title: '8. International Transfers', content: 'Your data may be transferred to and processed in countries other than your own. We ensure appropriate safeguards are in place for international data transfers, including standard contractual clauses and adequacy decisions where applicable.' },
  { icon: 'sparkles-outline', title: '9. AI, Chat, Voice & Attachments', content: 'When you use Rozare AI, we process your prompts, conversation context, selected account or commerce information, AI results, and any images, files, or voice notes you choose to send. Voice notes may be transcribed. This information is sent to third-party AI routing and model providers to produce the requested response or action. Do not include sensitive information that is not needed. Saved conversations remain available in your chat history until you delete the conversation or account, subject to the retention exceptions above.' },
  { icon: 'phone-portrait-outline', title: '10. Device, Location & Permissions', content: 'We may collect device type, operating system, app version, crash or diagnostic data, IP address, and an approximate location inferred from IP. If you select a country, region, city, town, or nearby-store location, we use it to show stores and delivery availability. Media-library access is used only when you choose an image or file; microphone access is used when you choose to record a voice note; notification access is used for alerts you enable.' },
  { icon: 'flag-outline', title: '11. Marketplace Safety', content: 'Reports about AI responses, products, stores, sellers, and reviews are provided to authorized moderators with a snapshot of the reported content and your optional explanation. A private block list is associated with your account so Rozare can hide blocked accounts and their content from you. Reporting does not automatically remove content; we review context and may take action under our policies.' },
  { icon: 'people-outline', title: '12. Children & Families', content: 'Rozare is a general shopping marketplace, not a service directed specifically to children. A person under the age of legal majority should use Rozare only with the permission and involvement of a parent or legal guardian, especially for account creation, selling, purchases, payments, and sharing personal information. Where law requires verifiable parental consent, a child must not provide personal data until that consent is obtained. A parent or guardian may contact privacy@rozare.com about a child’s information.' },
];

export default function PrivacyPolicyScreen({ navigation }) {
  const { palette } = useTheme();
  const styles = buildStyles(palette);

  return (
    <GlassBackground>
      <SafeAreaView style={styles.container} edges={Platform.OS === 'android' ? [] : ['top']}>
        <PremiumBackHeader
          title="Privacy Policy"
          subtitle="Last updated: August 29, 2026"
          icon="shield-checkmark-outline"
          onBack={() => navigation.goBack()}
          rightIcon="lock-closed-outline"
          rightLabel="Private"
          style={styles.premiumHeader}
        />

        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
          <GlassPanel variant="card" style={styles.introCard}>
            <Text style={styles.introText}>
              At Rozare, your privacy is important to us. This policy explains what information we collect, how we use it, and what choices you have. We are committed to protecting your personal data and being transparent about our practices.
            </Text>
          </GlassPanel>

          {sections.map((s, i) => (
            <GlassPanel key={i} variant="card" style={styles.sectionCard}>
              <View style={styles.sectionHeader}>
                <View style={styles.sectionIconWrap}>
                  <Ionicons name={s.icon} size={18} color={palette.colors.primary} />
                </View>
                <Text style={styles.sectionTitle}>{s.title}</Text>
              </View>
              <Text style={styles.sectionContent}>{s.content}</Text>
            </GlassPanel>
          ))}

          <GlassPanel variant="card" style={styles.ctaCard}>
            <Text style={styles.ctaText}>For privacy inquiries, email privacy@rozare.com</Text>
            <TouchableOpacity onPress={() => navigation.navigate('TermsOfService')} activeOpacity={0.7}>
              <Text style={styles.ctaLink}>View Terms of Service →</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => Linking.openURL('https://rozare.com/account-deletion')} activeOpacity={0.7}>
              <Text style={styles.ctaLink}>Account deletion instructions →</Text>
            </TouchableOpacity>
          </GlassPanel>

          <View style={{ height: 100 }} />
        </ScrollView>
      </SafeAreaView>
    </GlassBackground>
  );
}

const buildStyles = (p) => StyleSheet.create({
  container: { flex: 1 },
  premiumHeader: { marginTop: spacing.sm },
  scrollContent: { paddingHorizontal: spacing.md, paddingTop: spacing.md },
  introCard: { marginBottom: spacing.md },
  introText: { fontSize: fontSize.md, color: p.colors.text, lineHeight: 22 },
  sectionCard: { marginBottom: spacing.md },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.sm },
  sectionIconWrap: { width: 36, height: 36, borderRadius: borderRadius.lg, backgroundColor: 'rgba(99,102,241,0.12)', justifyContent: 'center', alignItems: 'center', marginRight: spacing.md },
  sectionTitle: { fontSize: fontSize.lg, fontWeight: fontWeight.semibold, color: p.colors.text, flex: 1 },
  sectionContent: { fontSize: fontSize.sm, color: p.colors.textSecondary, lineHeight: 20 },
  ctaCard: { alignItems: 'center' },
  ctaText: { fontSize: fontSize.sm, color: p.colors.textSecondary, marginBottom: spacing.sm, textAlign: 'center' },
  ctaLink: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: p.colors.primary },
});
