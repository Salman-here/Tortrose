/**
 * AdminWhatsAppVerificationScreen — Liquid Glass
 * Manage the unified WhatsApp gateway plus buyer/seller activity.
 * Mirrors web WhatsAppVerificationPanel.jsx (status, link/unlink, queue, stats).
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, ScrollView, StyleSheet, RefreshControl, TouchableOpacity,
  TextInput, Alert, ActivityIndicator, SafeAreaView, Modal, Image,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../../config/api';
import Loader from '../../components/common/Loader';
import GlassBackground from '../../components/common/GlassBackground';
import GlassPanel from '../../components/common/GlassPanel';
import { spacing, fontSize, fontWeight, borderRadius } from '../../styles/theme';
import { useTheme } from '../../contexts/ThemeContext';

const STATUS_META = {
  disconnected: { label: 'Disconnected', icon: 'unlink' },
  pending_qr: { label: 'Awaiting QR', icon: 'qr-code' },
  connecting: { label: 'Connecting', icon: 'sync' },
  connected: { label: 'Connected', icon: 'checkmark-circle' },
  error: { label: 'Error', icon: 'alert-circle' },
};

const QUEUE_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'queued', label: 'Queued' },
  { value: 'sent', label: 'Sent' },
  { value: 'voted_yes', label: 'Confirmed' },
  { value: 'voted_no', label: 'Declined' },
  { value: 'failed', label: 'Failed' },
];

export default function AdminWhatsAppVerificationScreen({ navigation }) {
  const { palette } = useTheme();
  const styles = buildStyles(palette);

  const STATUS_COLORS = {
    disconnected: palette.colors.gray,
    pending_qr: palette.colors.warning,
    connecting: palette.colors.info,
    connected: palette.colors.success,
    error: palette.colors.error,
  };

  const [tab, setTab] = useState('seller'); // 'orders' | 'seller'
  const [status, setStatus] = useState(null);
  const [stats, setStats] = useState(null);
  const [queue, setQueue] = useState([]);
  const [queueFilter, setQueueFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Link modal
  const [showLink, setShowLink] = useState(false);
  const [qr, setQr] = useState('');
  const [pairingCode, setPairingCode] = useState('');
  const [phone, setPhone] = useState('');
  const [linkLoading, setLinkLoading] = useState(false);
  const [linkErr, setLinkErr] = useState('');

  const pollRef = useRef(null);
  const prefix = tab === 'seller' ? '/api/whatsapp/seller' : '/api/whatsapp';

  const fetchAll = useCallback(async () => {
    try {
      const [s, st, q] = await Promise.all([
        api.get(`${prefix}/status`).catch(() => ({ data: null })),
        api.get(`${prefix}/stats`).catch(() => ({ data: null })),
        api.get(`${prefix}/queue?filter=${queueFilter}&page=1&limit=15`).catch(() => ({ data: { items: [] } })),
      ]);
      setStatus(s.data);
      setStats(st.data);
      setQueue(q.data?.items || []);
      if (s.data?.qrBase64) setQr(s.data.qrBase64);
    } catch {} finally { setLoading(false); setRefreshing(false); }
  }, [prefix, queueFilter]);

  useEffect(() => { setLoading(true); fetchAll(); }, [tab, queueFilter, fetchAll]);

  // Poll while link modal open
  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(fetchAll, showLink ? 5000 : 30000);
    return () => clearInterval(pollRef.current);
  }, [showLink, fetchAll]);

  const requestQR = useCallback(async () => {
    setLinkLoading(true); setLinkErr('');
    try {
      const { data } = await api.post(`${prefix}/connect`, {});
      setQr(data?.qrBase64 || '');
      setPairingCode(data?.code || '');
      await fetchAll();
    } catch (e) {
      setLinkErr(e.response?.data?.msg || 'Failed to get QR');
    } finally { setLinkLoading(false); }
  }, [prefix, fetchAll]);

  const requestPairing = async () => {
    if (!phone || phone.replace(/\D/g, '').length < 7) {
      setLinkErr('Enter a valid phone number with country code'); return;
    }
    setLinkLoading(true); setLinkErr('');
    try {
      const { data } = await api.post(`${prefix}/pairing-code`, { phoneNumber: phone.replace(/\D/g, '') });
      setPairingCode(data?.code || '');
    } catch (e) { setLinkErr(e.response?.data?.msg || 'Failed to request pairing code'); }
    finally { setLinkLoading(false); }
  };

  const openLink = () => { setShowLink(true); setQr(status?.qrBase64 || ''); setPairingCode(''); setLinkErr(''); requestQR(); };
  const closeLink = () => { setShowLink(false); setTimeout(fetchAll, 1500); };

  const disconnect = () => Alert.alert('Disconnect WhatsApp?', 'You will need to scan QR again.', [
    { text: 'Keep', style: 'cancel' },
    { text: 'Disconnect', style: 'destructive', onPress: async () => {
      try { await api.post(`${prefix}/disconnect`); fetchAll(); } catch { Alert.alert('Error', 'Failed'); }
    }},
  ]);

  const reset = () => Alert.alert('Reset instance?', 'Clears stuck sessions.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Reset', style: 'destructive', onPress: async () => {
      try { await api.post(`${prefix}/reset`); setQr(''); setPairingCode(''); fetchAll(); }
      catch { Alert.alert('Error', 'Failed to reset'); }
    }},
  ]);

  const retry = async (id) => {
    try { await api.post(`${prefix.replace('/seller','')}/queue/${id}/retry`); fetchAll(); }
    catch { Alert.alert('Error', 'Retry failed'); }
  };

  const meta = STATUS_META[status?.status] || STATUS_META.disconnected;
  const statusColor = STATUS_COLORS[status?.status] || palette.colors.gray;

  return (
    <GlassBackground>
      <SafeAreaView style={{ flex: 1 }}>
        <View style={styles.headerBar}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
            <Ionicons name="arrow-back" size={22} color={palette.colors.text} />
          </TouchableOpacity>
          <View>
            <Text style={styles.title}>WhatsApp Manager</Text>
            <Text style={styles.subtitle}>{tab === 'orders' ? 'Buyer order WhatsApp activity' : 'Unified WhatsApp gateway'}</Text>
          </View>
        </View>

        <ScrollView
          contentContainerStyle={styles.scroll}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchAll(); }} tintColor={palette.colors.primary} />}
          showsVerticalScrollIndicator={false}
        >
          {/* Tabs */}
          <View style={styles.tabRow}>
            {[{ key: 'seller', label: 'Gateway', icon: 'notifications' }, { key: 'orders', label: 'Buyer Orders', icon: 'chatbubble-ellipses' }].map(t => (
              <TouchableOpacity key={t.key} onPress={() => setTab(t.key)}
                style={[styles.tab, tab === t.key && styles.tabActive]}>
                <Ionicons name={t.icon} size={14} color={tab === t.key ? palette.colors.white : palette.colors.text} />
                <Text style={[styles.tabText, tab === t.key && { color: palette.colors.white }]}>{t.label}</Text>
              </TouchableOpacity>
            ))}
          </View>

          {loading ? <Loader fullScreen={false} message="Loading..." /> : (
            <>
              {/* Status card */}
              <GlassPanel variant="card" style={styles.section}>
                <View style={styles.statusRow}>
                  <View style={[styles.statusIcon, { backgroundColor: `${statusColor}20` }]}>
                    <Ionicons name={meta.icon} size={20} color={statusColor} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.statusLabel}>{meta.label}</Text>
                    {status?.linkedNumber && <Text style={styles.statusSub}>+{status.linkedNumber}</Text>}
                    {status?.lastError ? <Text style={[styles.statusSub, { color: palette.colors.error }]}>{status.lastError}</Text> : null}
                  </View>
                </View>

                <View style={styles.actionRow}>
                  {tab !== 'seller' ? (
                    <View style={[styles.actionBtn, { backgroundColor: `${palette.colors.info}15` }]}>
                      <Ionicons name="information-circle" size={14} color={palette.colors.info} />
                      <Text style={[styles.actionBtnText, { color: palette.colors.info }]}>Managed in Gateway</Text>
                    </View>
                  ) : status?.status === 'connected' ? (
                    <TouchableOpacity onPress={disconnect} style={[styles.actionBtn, { backgroundColor: `${palette.colors.error}15` }]}>
                      <Ionicons name="power" size={14} color={palette.colors.error} />
                      <Text style={[styles.actionBtnText, { color: palette.colors.error }]}>Disconnect</Text>
                    </TouchableOpacity>
                  ) : (
                    <TouchableOpacity onPress={openLink} style={[styles.actionBtn, { backgroundColor: palette.colors.primary }]}>
                      <Ionicons name="qr-code" size={14} color={palette.colors.white} />
                      <Text style={[styles.actionBtnText, { color: palette.colors.white }]}>Link Gateway</Text>
                    </TouchableOpacity>
                  )}
                  {tab === 'seller' && (
                    <TouchableOpacity onPress={reset} style={[styles.actionBtn, { backgroundColor: `${palette.colors.warning}15` }]}>
                      <Ionicons name="refresh" size={14} color={palette.colors.warning} />
                      <Text style={[styles.actionBtnText, { color: palette.colors.warning }]}>Reset</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </GlassPanel>

              {/* Stats */}
              {stats && (
                <View style={styles.statsRow}>
                  {[
                    { label: 'Sent', value: stats.totalSent ?? stats.sent ?? 0, color: palette.colors.info, icon: 'send' },
                    { label: tab === 'orders' ? 'Confirmed' : 'Delivered', value: stats.confirmed ?? stats.delivered ?? 0, color: palette.colors.success, icon: 'checkmark-done' },
                    { label: tab === 'orders' ? 'Declined' : 'Failed', value: stats.declined ?? stats.failed ?? 0, color: palette.colors.error, icon: 'close-circle' },
                    { label: 'Pending', value: stats.pending ?? stats.queued ?? 0, color: palette.colors.warning, icon: 'time' },
                  ].map((s, i) => (
                    <GlassPanel key={i} variant="card" style={styles.statCard}>
                      <View style={[styles.statIcon, { backgroundColor: `${s.color}15` }]}>
                        <Ionicons name={s.icon} size={14} color={s.color} />
                      </View>
                      <Text style={styles.statValue}>{s.value}</Text>
                      <Text style={styles.statLabel}>{s.label}</Text>
                    </GlassPanel>
                  ))}
                </View>
              )}

              {/* Queue */}
              <GlassPanel variant="card" style={styles.section}>
                <Text style={styles.sectionLabel}>Recent Queue</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing.xs, paddingVertical: spacing.xs }}>
                  {QUEUE_FILTERS.map(f => (
                    <TouchableOpacity key={f.value} onPress={() => setQueueFilter(f.value)}
                      style={[styles.chip, queueFilter === f.value && styles.chipActive]}>
                      <Text style={[styles.chipText, queueFilter === f.value && { color: palette.colors.white }]}>{f.label}</Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
                {queue.length === 0 ? (
                  <View style={styles.empty}>
                    <Ionicons name="mail-open-outline" size={28} color={palette.colors.textLight} />
                    <Text style={styles.emptyText}>No items in queue</Text>
                  </View>
                ) : queue.map(item => (
                  <View key={item._id} style={styles.queueRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.queueTitle} numberOfLines={1}>
                        {item.recipientName || item.phoneNumber || 'Recipient'}
                      </Text>
                      <Text style={styles.queueMeta} numberOfLines={1}>
                        {item.status} · {item.createdAt ? new Date(item.createdAt).toLocaleString() : ''}
                      </Text>
                    </View>
                    {(item.status === 'failed' || item.status === 'failed_invalid_number') && (
                      <TouchableOpacity onPress={() => retry(item._id)} style={styles.retryBtn}>
                        <Ionicons name="refresh" size={12} color={palette.colors.primary} />
                        <Text style={styles.retryText}>Retry</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                ))}
              </GlassPanel>
            </>
          )}

          <View style={{ height: 60 }} />
        </ScrollView>

        {/* Link Modal */}
        <Modal visible={showLink} transparent animationType="fade" onRequestClose={closeLink}>
          <View style={styles.modalOverlay}>
            <View style={styles.modalCard}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>Link Gateway</Text>
                <TouchableOpacity onPress={closeLink}><Ionicons name="close" size={20} color={palette.colors.text} /></TouchableOpacity>
              </View>

              {linkLoading && !qr && !pairingCode ? (
                <ActivityIndicator color={palette.colors.primary} style={{ marginVertical: spacing.xl }} />
              ) : qr ? (
                <View style={{ alignItems: 'center' }}>
                  <Image source={{ uri: qr.startsWith('data:') ? qr : `data:image/png;base64,${qr}` }} style={styles.qrImg} />
                  <Text style={styles.modalHelp}>Open WhatsApp → Settings → Linked devices → Link a device</Text>
                </View>
              ) : null}

              {pairingCode ? (
                <View style={styles.pairingBox}>
                  <Text style={styles.pairingLabel}>Pairing Code</Text>
                  <Text style={styles.pairingCode}>{pairingCode}</Text>
                </View>
              ) : null}

              <View style={styles.modalDivider}>
                <View style={styles.dividerLine} />
                <Text style={styles.dividerText}>OR</Text>
                <View style={styles.dividerLine} />
              </View>

              <Text style={styles.fieldLabel}>Phone (digits + country code)</Text>
              <TextInput value={phone} onChangeText={setPhone} placeholder="923001234567"
                placeholderTextColor={palette.colors.textLight} keyboardType="phone-pad"
                style={styles.input} />
              <TouchableOpacity onPress={requestPairing} disabled={linkLoading}
                style={[styles.actionBtn, { backgroundColor: palette.colors.secondary, justifyContent: 'center', marginTop: spacing.sm }]}>
                {linkLoading ? <ActivityIndicator color={palette.colors.white} size="small" /> : (
                  <>
                    <Ionicons name="key" size={14} color={palette.colors.white} />
                    <Text style={[styles.actionBtnText, { color: palette.colors.white }]}>Get Pairing Code</Text>
                  </>
                )}
              </TouchableOpacity>

              {!!linkErr && <Text style={styles.errText}>{linkErr}</Text>}

              <TouchableOpacity onPress={requestQR} disabled={linkLoading} style={[styles.actionBtn, { backgroundColor: `${palette.colors.gray}10`, justifyContent: 'center', marginTop: spacing.sm }]}>
                <Ionicons name="refresh" size={14} color={palette.colors.text} />
                <Text style={[styles.actionBtnText, { color: palette.colors.text }]}>Refresh QR</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>
      </SafeAreaView>
    </GlassBackground>
  );
}

const buildStyles = (p) => StyleSheet.create({
  headerBar: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.sm },
  backBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: `${p.colors.gray}10`, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: fontSize.xl, fontWeight: fontWeight.extrabold, color: p.colors.text },
  subtitle: { fontSize: fontSize.xs, color: p.colors.textSecondary, marginTop: 2 },
  scroll: { paddingHorizontal: spacing.lg, paddingTop: spacing.md },

  tabRow: { flexDirection: 'row', backgroundColor: `${p.colors.gray}08`, borderRadius: borderRadius.lg, padding: 4, marginBottom: spacing.md },
  tab: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: spacing.sm, borderRadius: borderRadius.md },
  tabActive: { backgroundColor: p.colors.primary },
  tabText: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: p.colors.text },

  section: { padding: spacing.lg, marginBottom: spacing.md },
  sectionLabel: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: p.colors.text, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: spacing.sm },

  statusRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  statusIcon: { width: 44, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  statusLabel: { fontSize: fontSize.md, fontWeight: fontWeight.bold, color: p.colors.text },
  statusSub: { fontSize: fontSize.xs, color: p.colors.textSecondary, marginTop: 2 },

  actionRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  actionBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: spacing.sm, paddingHorizontal: spacing.md, borderRadius: borderRadius.md, justifyContent: 'center' },
  actionBtnText: { fontSize: fontSize.xs, fontWeight: fontWeight.bold },

  statsRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md },
  statCard: { flex: 1, padding: spacing.md, alignItems: 'center' },
  statIcon: { width: 28, height: 28, borderRadius: 9, alignItems: 'center', justifyContent: 'center', marginBottom: spacing.xs },
  statValue: { fontSize: fontSize.lg, fontWeight: fontWeight.extrabold, color: p.colors.text },
  statLabel: { fontSize: 10, color: p.colors.textSecondary, marginTop: 2 },

  chip: { paddingHorizontal: spacing.md, paddingVertical: spacing.xs, borderRadius: borderRadius.full, backgroundColor: `${p.colors.primary}10` },
  chipActive: { backgroundColor: p.colors.primary },
  chipText: { fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: p.colors.primary },

  queueRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: p.glass.borderSubtle },
  queueTitle: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: p.colors.text },
  queueMeta: { fontSize: 10, color: p.colors.textSecondary, marginTop: 2 },
  retryBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: spacing.sm, paddingVertical: 4, borderRadius: borderRadius.md, backgroundColor: `${p.colors.primary}15` },
  retryText: { fontSize: 10, fontWeight: fontWeight.bold, color: p.colors.primary },

  empty: { alignItems: 'center', paddingVertical: spacing.xl, gap: spacing.sm },
  emptyText: { fontSize: fontSize.sm, color: p.colors.textSecondary },

  // Modal
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', padding: spacing.lg },
  modalCard: { backgroundColor: p.colors.background, borderRadius: borderRadius.xl, padding: spacing.lg, borderWidth: 1, borderColor: p.glass.borderSubtle },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.md },
  modalTitle: { fontSize: fontSize.lg, fontWeight: fontWeight.extrabold, color: p.colors.text },
  qrImg: { width: 200, height: 200, borderRadius: borderRadius.md, backgroundColor: '#fff', marginVertical: spacing.md },
  modalHelp: { fontSize: 11, color: p.colors.textSecondary, textAlign: 'center', marginBottom: spacing.sm },
  pairingBox: { backgroundColor: `${p.colors.primary}10`, borderRadius: borderRadius.lg, padding: spacing.md, alignItems: 'center', marginVertical: spacing.sm },
  pairingLabel: { fontSize: 10, fontWeight: fontWeight.bold, color: p.colors.textSecondary, textTransform: 'uppercase', letterSpacing: 1 },
  pairingCode: { fontSize: 28, fontWeight: fontWeight.extrabold, color: p.colors.primary, letterSpacing: 6, marginTop: 4 },
  modalDivider: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginVertical: spacing.md },
  dividerLine: { flex: 1, height: 1, backgroundColor: p.glass.borderSubtle },
  dividerText: { fontSize: 10, fontWeight: fontWeight.bold, color: p.colors.textLight },
  fieldLabel: { fontSize: 11, fontWeight: fontWeight.semibold, color: p.colors.textSecondary, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 },
  input: { backgroundColor: `${p.colors.gray}08`, borderRadius: borderRadius.lg, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, fontSize: fontSize.sm, color: p.colors.text, borderWidth: 1, borderColor: p.glass.borderSubtle },
  errText: { fontSize: 11, color: p.colors.error, marginTop: spacing.sm, textAlign: 'center' },
});
