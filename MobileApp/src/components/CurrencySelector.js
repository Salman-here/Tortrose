/**
 * CurrencySelector - themed selector for backend-supported currencies.
 */

import React, { useState } from 'react';
import { View, Text, TouchableOpacity, Modal, StyleSheet, FlatList } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useCurrency } from '../contexts/CurrencyContext';
import { useTheme } from '../contexts/ThemeContext';
import GlassPanel from './common/GlassPanel';
import { spacing, fontSize, borderRadius, fontWeight } from '../styles/theme';

export default function CurrencySelector() {
  const { currency, setCurrency, currencies } = useCurrency();
  const { palette } = useTheme();
  const colors = palette.colors;
  const glass = palette.glass;
  const styles = makeStyles(palette);
  const [modalVisible, setModalVisible] = useState(false);

  const currencyList = Object.values(currencies);
  const currentCurrency = currencies[currency] || currencyList[0];

  const handleSelect = (code) => {
    setCurrency(code);
    setModalVisible(false);
  };

  return (
    <>
      <TouchableOpacity style={styles.selector} onPress={() => setModalVisible(true)} activeOpacity={0.8}>
        <Text style={styles.selectorText}>{currentCurrency.symbol} {currentCurrency.code}</Text>
        <Ionicons name="chevron-down" size={14} color={colors.textSecondary} />
      </TouchableOpacity>

      <Modal visible={modalVisible} animationType="slide" transparent onRequestClose={() => setModalVisible(false)}>
        <View style={styles.modalOverlay}>
          <GlassPanel variant="strong" style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Select Currency</Text>
              <TouchableOpacity style={styles.closeBtn} onPress={() => setModalVisible(false)} activeOpacity={0.8}>
                <Ionicons name="close" size={20} color={colors.text} />
              </TouchableOpacity>
            </View>
            <FlatList
              data={currencyList}
              keyExtractor={(item) => item.code}
              showsVerticalScrollIndicator={false}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={[styles.currencyItem, item.code === currency && styles.currencyItemSelected]}
                  onPress={() => handleSelect(item.code)}
                  activeOpacity={0.75}
                >
                  <View style={styles.currencyInfo}>
                    <View style={styles.symbolWrap}>
                      <Text style={styles.currencySymbol}>{item.symbol}</Text>
                    </View>
                    <View>
                      <Text style={styles.currencyCode}>{item.code}</Text>
                      <Text style={styles.currencyName}>{item.name}</Text>
                    </View>
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

const makeStyles = (palette) => {
  const colors = palette.colors;
  const glass = palette.glass;
  return StyleSheet.create({
    selector: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: glass.bgSubtle,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderRadius: 12,
      gap: 4,
      borderWidth: 1,
      borderColor: glass.borderSubtle,
    },
    selectorText: { fontSize: fontSize.sm, color: colors.text, fontWeight: fontWeight.medium },
    modalOverlay: { flex: 1, backgroundColor: colors.overlay, justifyContent: 'flex-end' },
    modalContent: { borderTopLeftRadius: 28, borderTopRightRadius: 28, maxHeight: '70%', paddingBottom: spacing.xxl },
    modalHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: spacing.lg,
      borderBottomWidth: 1,
      borderBottomColor: glass.borderSubtle,
    },
    modalTitle: { fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: colors.text },
    closeBtn: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: glass.bgSubtle,
      justifyContent: 'center',
      alignItems: 'center',
    },
    currencyItem: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: spacing.md,
      paddingHorizontal: spacing.lg,
      borderBottomWidth: 1,
      borderBottomColor: glass.borderSubtle,
    },
    currencyItemSelected: { backgroundColor: colors.primarySubtle },
    currencyInfo: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    symbolWrap: {
      width: 36,
      height: 36,
      borderRadius: 12,
      backgroundColor: glass.bgSubtle,
      justifyContent: 'center',
      alignItems: 'center',
    },
    currencySymbol: { fontSize: fontSize.md, fontWeight: fontWeight.bold, color: colors.primary },
    currencyCode: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.text },
    currencyName: { fontSize: fontSize.sm, color: colors.textSecondary },
  });
};
