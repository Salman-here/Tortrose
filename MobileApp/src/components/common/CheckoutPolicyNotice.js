import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTheme } from '../../contexts/ThemeContext';
import { checkoutPolicyNotice } from '../../content/commercePolicies';

export default function CheckoutPolicyNotice({ onOpenPolicy }) {
  const { palette } = useTheme();
  return <View accessibilityLabel="Checkout policies" style={styles.container}>
    <Text style={[styles.text, { color: palette.colors.textSecondary }]}>
      {checkoutPolicyNotice.introduction}{' '}
      <Text accessibilityRole="link" style={{ color: palette.colors.primary }} onPress={() => onOpenPolicy(checkoutPolicyNotice.terms.screen)}>{checkoutPolicyNotice.terms.label}</Text>.
    </Text>
    <View style={styles.links}>
      {checkoutPolicyNotice.links.map(link => <TouchableOpacity key={link.path} accessibilityRole="link" onPress={() => onOpenPolicy(link.screen)} style={styles.link}>
        <Text style={[styles.text, { color: palette.colors.primary, textDecorationLine: 'underline' }]}>{link.label}</Text>
      </TouchableOpacity>)}
    </View>
  </View>;
}
const styles = StyleSheet.create({ container: { gap: 4 }, text: { fontSize: 12, lineHeight: 18 }, links: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 18 }, link: { paddingVertical: 8 } });
