/**
 * TrustButton — Liquid Glass Design
 */

import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Toast from 'react-native-toast-message';
import api from '../config/api';
import { useAuth } from '../contexts/AuthContext';
import { colors, spacing, fontSize, borderRadius, fontWeight, glass, shadows } from '../styles/theme';

const TrustButton = ({ storeId, storeName, initialTrustCount = 0, initialIsTrusted = false, compact = false, iconOnly = false, onTrustChange }) => {
  const [isTrusted, setIsTrusted] = useState(initialIsTrusted);
  const [trustCount, setTrustCount] = useState(initialTrustCount);
  const [isLoading, setIsLoading] = useState(false);
  const { currentUser } = useAuth();

  useEffect(() => { setIsTrusted(initialIsTrusted); setTrustCount(initialTrustCount); }, [initialIsTrusted, initialTrustCount]);

  useEffect(() => {
    const fetchStatus = async () => {
      if (!currentUser || !storeId) return;
      try { const r = await api.get(`/api/stores/${storeId}/trust-status`); setIsTrusted(r.data.data.isTrusted); setTrustCount(r.data.data.trustCount); } catch {}
    };
    fetchStatus();
  }, [storeId, currentUser]);

  const handleToggle = async () => {
    if (!currentUser) { Toast.show({ type: 'info', text1: 'Login Required', text2: 'Please login to trust stores' }); return; }
    setIsLoading(true);
    const prev = isTrusted; const prevCount = trustCount;
    try {
      if (isTrusted) {
        setIsTrusted(false); setTrustCount(c => Math.max(0, c - 1));
        const r = await api.delete(`/api/stores/${storeId}/trust`); setTrustCount(r.data.data.trustCount);
        Toast.show({ type: 'success', text1: 'Untrusted', text2: `You no longer trust ${storeName}` });
        onTrustChange?.(false, r.data.data.trustCount);
      } else {
        setIsTrusted(true); setTrustCount(c => c + 1);
        const r = await api.post(`/api/stores/${storeId}/trust`, {}); setTrustCount(r.data.data.trustCount);
        Toast.show({ type: 'success', text1: 'Trusted', text2: `You now trust ${storeName}` });
        onTrustChange?.(true, r.data.data.trustCount);
      }
    } catch (error) {
      setIsTrusted(prev); setTrustCount(prevCount);
      Toast.show({ type: 'error', text1: 'Error', text2: error.response?.data?.message || 'Failed to update' });
    } finally { setIsLoading(false); }
  };

  if (iconOnly) {
    return (
      <TouchableOpacity onPress={handleToggle} disabled={isLoading || !currentUser} style={[styles.iconBtn, isTrusted && styles.iconBtnTrusted, (isLoading || !currentUser) && { opacity: 0.5 }]}>
        {isLoading ? <ActivityIndicator size="small" color={isTrusted ? '#fff' : colors.text} /> :
          <Ionicons name={isTrusted ? 'heart' : 'heart-outline'} size={18} color={isTrusted ? '#fff' : colors.text} />}
      </TouchableOpacity>
    );
  }

  if (compact) {
    return (
      <TouchableOpacity onPress={handleToggle} disabled={isLoading || !currentUser}
        style={[styles.compactBtn, isTrusted ? styles.trustedBtn : styles.untrustedBtn, (isLoading || !currentUser) && { opacity: 0.5 }]}>
        {isLoading ? <ActivityIndicator size="small" color={isTrusted ? '#fff' : colors.text} /> :
          <><Ionicons name={isTrusted ? 'checkmark' : 'add'} size={14} color={isTrusted ? '#fff' : colors.text} />
          <Text style={[styles.compactText, isTrusted ? { color: '#fff' } : { color: colors.text }]}>{isTrusted ? 'Trusting' : 'Trust'}</Text></>}
      </TouchableOpacity>
    );
  }

  return (
    <View style={styles.fullContainer}>
      <TouchableOpacity onPress={handleToggle} disabled={isLoading || !currentUser}
        style={[styles.fullBtn, isTrusted ? styles.trustedBtn : styles.untrustedBtn, (isLoading || !currentUser) && { opacity: 0.5 }]}>
        {isLoading ? <ActivityIndicator size="small" color={isTrusted ? '#fff' : colors.text} /> :
          <><Ionicons name={isTrusted ? 'checkmark' : 'add'} size={18} color={isTrusted ? '#fff' : colors.text} />
          <Text style={[styles.fullText, isTrusted ? { color: '#fff' } : { color: colors.text }]}>{isTrusted ? 'Trusting' : 'Trust'}</Text></>}
      </TouchableOpacity>
      <View style={styles.countWrap}>
        <Text style={styles.countNumber}>{trustCount}</Text>
        <Text style={styles.countLabel}>{trustCount === 1 ? 'truster' : 'trusters'}</Text>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  iconBtn: { width: 36, height: 36, borderRadius: 12, backgroundColor: glass.bgSubtle, justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: glass.borderSubtle },
  iconBtnTrusted: { backgroundColor: colors.success, borderColor: colors.success },
  compactBtn: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, gap: 4 },
  fullBtn: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, borderRadius: 14, gap: spacing.sm, flex: 1 },
  trustedBtn: { backgroundColor: colors.success },
  untrustedBtn: { backgroundColor: glass.bg, borderWidth: 1, borderColor: glass.border },
  compactText: { fontSize: fontSize.xs, fontWeight: fontWeight.semibold },
  fullText: { fontSize: fontSize.md, fontWeight: fontWeight.medium },
  fullContainer: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  countWrap: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  countNumber: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.text },
  countLabel: { fontSize: fontSize.sm, color: colors.textSecondary },
});

export default TrustButton;
