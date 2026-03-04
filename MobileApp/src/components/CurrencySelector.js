/**
 * CurrencySelector — Liquid Glass Design
 */

import React, { useState } from 'react';
import { View, Text, TouchableOpacity, Modal, StyleSheet, FlatList } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useCurrency } from '../contexts/CurrencyContext';
import GlassPanel from './common/GlassPanel';
import { colors, spacing, fontSize, borderRadius, shadows, fontWeight, glass } from '../styles/theme';

const CURRENCIES = [
  { code: 'USD', symbol: '$', name: 'US Dollar' },
  { code: 'EUR', symbol: '€', name: 'Euro' },
  { code: 'GBP', symbol: '£', name: 'British Pound' },
  { code: 'PKR', symbol: '₨', name: 'Pakistani Rupee' },
  { code: 'INR', symbol: '₹', name: 'Indian Rupee' },
  { code: 'AED', symbol: 'د.إ', name: 'UAE Dirham' },
  { code: 'SAR', symbol: '﷼', name: 'Saudi Riyal' },
  { code: 'CAD', symbol: 'C$', name: 'Canadian Dollar' },
  { code: 'AUD', symbol: 'A$', name: 'Australian Dollar' },
  { code: 'JPY', symbol: '¥', name: 'Japanese Yen' },
];

export default function CurrencySelector() {
  const { currency, setCurrency } = useCurrency();
  const [modalVisible, setModalVisible] = useState(false);
  const currentCurrency = CURRENCIES.find(c => c.code === currency) || CURRENCIES[0];

  const handleSelect = (code) => { setCurrency(code); setModalVisible(false); };

  return (
    <>
      <TouchableOpacity style={styles.selector} onPress={() => setModalVisible(true)}>
        <Text style={styles.selectorText}>{currentCurrency.symbol} {currentCurrency.code}</Text>
        <Ionicons name="chevron-down" size={14} color={colors.textSecondary} />
      </TouchableOpacity>

      <Modal visible={modalVisible} animationType="slide" transparent onRequestClose={() => setModalVisible(false)}>
        <View style={styles.modalOverlay}>
          <GlassPanel variant="strong" style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Select Currency</Text>
              <TouchableOpacity style={styles.closeBtn} onPress={() => setModalVisible(false)}>
                <Ionicons name="close" size={20} color={colors.text} />
              </TouchableOpacity>
            </View>
            <FlatList
              data={CURRENCIES} keyExtractor={(item) => item.code} showsVerticalScrollIndicator={false}
              renderItem={({ item }) => (
                <TouchableOpacity style={[styles.currencyItem, item.code === currency && styles.currencyItemSelected]} onPress={() => handleSelect(item.code)}>
                  <View style={styles.currencyInfo}>
                    <View style={styles.symbolWrap}><Text style={styles.currencySymbol}>{item.symbol}</Text></View>
                    <View><Text style={styles.currencyCode}>{item.code}</Text><Text style={styles.currencyName}>{item.name}</Text></View>
                  </View>
                  {item.code === currency && <Ionicons name="checkmark-circle" size={22} color={colors.primary} />}
                </TouchableOpacity>
              )}
            />
          </GlassPanel>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  selector: { flexDirection: 'row', alignItems: 'center', backgroundColor: glass.bgSubtle, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: 12, gap: 4, borderWidth: 1, borderColor: glass.borderSubtle },
  selectorText: { fontSize: fontSize.sm, color: colors.text, fontWeight: fontWeight.medium },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalContent: { borderTopLeftRadius: 28, borderTopRightRadius: 28, maxHeight: '70%', paddingBottom: spacing.xxl },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: spacing.lg, borderBottomWidth: 1, borderBottomColor: glass.borderSubtle },
  modalTitle: { fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: colors.text },
  closeBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: glass.bgSubtle, justifyContent: 'center', alignItems: 'center' },
  currencyItem: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: spacing.md, paddingHorizontal: spacing.lg, borderBottomWidth: 1, borderBottomColor: glass.borderSubtle },
  currencyItemSelected: { backgroundColor: 'rgba(99,102,241,0.08)' },
  currencyInfo: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  symbolWrap: { width: 36, height: 36, borderRadius: 12, backgroundColor: glass.bgSubtle, justifyContent: 'center', alignItems: 'center' },
  currencySymbol: { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: colors.primary },
  currencyCode: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.text },
  currencyName: { fontSize: fontSize.sm, color: colors.textSecondary },
});
