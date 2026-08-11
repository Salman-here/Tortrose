/**
 * StoreReviews — review thread + submission form for StoreScreen
 * Liquid Glass Design
 */
import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, TextInput, Modal, Alert, ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import api from '../../config/api';
import { useAuth } from '../../contexts/AuthContext';
import { useTheme } from '../../contexts/ThemeContext';
import GlassPanel from './GlassPanel';
import KeyboardAwareFormScrollView from './KeyboardAwareFormScrollView';
import { spacing, fontSize, fontWeight, borderRadius, shadows } from '../../styles/theme';

const Stars = ({ value = 0, size = 14, color, emptyColor }) => {
  const filled = Math.round(value);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      {[1, 2, 3, 4, 5].map((i) => (
        <Ionicons
          key={i}
          name={i <= filled ? 'star' : 'star-outline'}
          size={size}
          color={i <= filled ? (color || '#fbbf24') : (emptyColor || 'rgba(150,150,150,0.4)')}
          style={{ marginRight: 2 }}
        />
      ))}
    </View>
  );
};

const StarPicker = ({ value, onChange, size = 32, color }) => (
  <View style={{ flexDirection: 'row', justifyContent: 'center', marginVertical: spacing.md }}>
    {[1, 2, 3, 4, 5].map((i) => (
      <TouchableOpacity key={i} onPress={() => onChange(i)} hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}>
        <Ionicons
          name={i <= value ? 'star' : 'star-outline'}
          size={size}
          color={i <= value ? (color || '#fbbf24') : 'rgba(150,150,150,0.45)'}
          style={{ marginHorizontal: 4 }}
        />
      </TouchableOpacity>
    ))}
  </View>
);

export default function StoreReviews({ storeId, storeOwnerId, onSummaryChange }) {
  const { palette } = useTheme();
  const { currentUser } = useAuth();
  const styles = buildStyles(palette);

  const [reviews, setReviews] = useState([]);
  const [summary, setSummary] = useState({ average: 0, count: 0, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } });
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({ rating: 5, title: '', comment: '' });
  const [showAll, setShowAll] = useState(false);
  const [eligibility, setEligibility] = useState(null);
  const [eligibilityLoading, setEligibilityLoading] = useState(false);

  const currentUserId = String(currentUser?._id || currentUser?.id || '');
  const isOwnStore = Boolean(currentUserId && currentUserId === String(storeOwnerId || ''));
  const myReview = eligibility?.review || (currentUser ? reviews.find((r) => String(r.user?._id || r.user) === currentUserId) : null);

  const fetchReviews = useCallback(async () => {
    if (!storeId) return;
    try {
      const res = await api.get(`/api/store-reviews/${storeId}`);
      setReviews(res.data.reviews || []);
      setSummary(res.data.summary || summary);
    } catch (e) {
      // silent
    } finally {
      setLoading(false);
    }
  }, [storeId]);

  useEffect(() => { fetchReviews(); }, [fetchReviews]);

  const fetchEligibility = useCallback(async () => {
    if (!storeId || !currentUser || isOwnStore) {
      setEligibility(isOwnStore ? { eligible: false, reason: 'own_store' } : null);
      return;
    }
    setEligibilityLoading(true);
    try {
      const res = await api.get(`/api/store-reviews/${storeId}/eligibility`);
      setEligibility({ ...(res.data?.eligibility || {}), review: res.data?.review || null });
    } catch {
      setEligibility({ eligible: false, reason: 'unavailable' });
    } finally {
      setEligibilityLoading(false);
    }
  }, [storeId, currentUser, isOwnStore]);

  useEffect(() => { fetchEligibility(); }, [fetchEligibility]);
  useEffect(() => { onSummaryChange?.(summary); }, [summary, onSummaryChange]);

  const openForm = () => {
    if (!currentUser) {
      Alert.alert('Sign in required', 'Log in after receiving an order from this store to leave a verified rating.');
      return;
    }
    if (!eligibility?.eligible) {
      const message = eligibility?.reason === 'order_not_delivered'
        ? 'You can rate this store after its part of your order is delivered.'
        : 'Buy from this store and receive the order before leaving a rating.';
      Alert.alert('Verified buyers only', message);
      return;
    }
    const editableReview = eligibility.review || myReview;
    if (editableReview) {
      setForm({ rating: editableReview.rating, title: editableReview.title || '', comment: editableReview.comment || '' });
    } else {
      setForm({ rating: 5, title: '', comment: '' });
    }
    setShowForm(true);
  };

  const submit = async () => {
    if (!form.rating) return Alert.alert('Pick a rating', 'Tap the stars to rate this store.');
    setSubmitting(true);
    try {
      const res = await api.post(`/api/store-reviews/${storeId}`, form);
      // upsert in local state
      setReviews((prev) => {
        const filtered = prev.filter((r) => r._id !== res.data.review._id);
        return [res.data.review, ...filtered];
      });
      setSummary(res.data.summary);
      setShowForm(false);
      await fetchEligibility();
    } catch (e) {
      Alert.alert('Error', e.response?.data?.msg || 'Failed to submit review');
    } finally {
      setSubmitting(false);
    }
  };

  const handleHelpful = async (reviewId) => {
    if (!currentUser) return Alert.alert('Sign in required');
    try {
      const res = await api.post(`/api/store-reviews/${reviewId}/helpful`);
      setReviews((prev) => prev.map((r) => r._id === reviewId ? { ...r, helpfulCount: res.data.helpfulCount } : r));
    } catch (_) {}
  };

  const handleDelete = (reviewId) => {
    Alert.alert('Delete review?', 'This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        try {
          const res = await api.delete(`/api/store-reviews/${reviewId}`);
          setReviews((prev) => prev.filter((r) => r._id !== reviewId));
          setSummary(res.data.summary);
          await fetchEligibility();
        } catch (_) { Alert.alert('Error', 'Failed to delete'); }
      } },
    ]);
  };

  const visibleReviews = showAll ? reviews : reviews.slice(0, 3);
  const total = summary.count || 0;
  const distribution = summary.distribution || { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };

  return (
    <View style={{ paddingHorizontal: spacing.md, marginTop: spacing.lg }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.sm }}>
        <Text style={styles.title}>Reviews</Text>
        {!isOwnStore && (
          <TouchableOpacity style={styles.writeBtn} onPress={openForm} activeOpacity={0.85}>
            {eligibilityLoading ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name={myReview ? 'create-outline' : 'star'} size={14} color="#fff" />}
            <Text style={styles.writeBtnText}>{myReview ? 'Edit' : 'Rate'}</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Summary */}
      <GlassPanel variant="card" style={styles.summaryCard}>
        <View style={styles.summaryLeft}>
          <Text style={styles.avgValue}>{summary.average?.toFixed(1) || '0.0'}</Text>
          <Stars value={summary.average} size={14} />
          <Text style={styles.countText}>{total} {total === 1 ? 'review' : 'reviews'}</Text>
        </View>
        <View style={styles.summaryRight}>
          {[5, 4, 3, 2, 1].map((star) => {
            const pct = total > 0 ? (distribution[star] / total) * 100 : 0;
            return (
              <View key={star} style={styles.distRow}>
                <Text style={styles.distLabel}>{star}</Text>
                <Ionicons name="star" size={10} color="#fbbf24" />
                <View style={styles.distTrack}>
                  <View style={[styles.distFill, { width: `${pct}%`, backgroundColor: palette.colors.primary }]} />
                </View>
                <Text style={styles.distCount}>{distribution[star]}</Text>
              </View>
            );
          })}
        </View>
      </GlassPanel>

      {currentUser && !isOwnStore && eligibility && !eligibility.eligible ? (
        <Text style={{ color: palette.colors.textSecondary, fontSize: fontSize.xs, marginTop: spacing.sm }}>
          {eligibility.reason === 'order_not_delivered'
            ? 'Rating unlocks after this store delivers its part of your order.'
            : 'Only buyers with a delivered order from this store can rate it.'}
        </Text>
      ) : null}

      {/* List */}
      {loading ? (
        <View style={{ paddingVertical: spacing.xl, alignItems: 'center' }}>
          <ActivityIndicator color={palette.colors.primary} />
        </View>
      ) : reviews.length === 0 ? (
        <GlassPanel variant="card" style={{ alignItems: 'center', padding: spacing.xl, marginTop: spacing.sm }}>
          <Ionicons name="chatbubble-ellipses-outline" size={36} color={palette.colors.textSecondary} />
          <Text style={{ color: palette.colors.text, fontWeight: fontWeight.semibold, marginTop: spacing.sm, fontSize: fontSize.md }}>No reviews yet</Text>
          <Text style={{ color: palette.colors.textSecondary, fontSize: fontSize.sm, marginTop: 4, textAlign: 'center' }}>
            {isOwnStore ? 'Reviews from your customers will appear here.' : 'Be the first to share your experience.'}
          </Text>
        </GlassPanel>
      ) : (
        <>
          {visibleReviews.map((r) => {
            const isMine = currentUser && (r.user?._id || r.user) === (currentUser._id || currentUser.id);
            return (
              <GlassPanel key={r._id} variant="card" style={styles.reviewCard}>
                <View style={styles.reviewHeader}>
                  <View style={styles.avatarWrap}>
                    {r.user?.avatar ? (
                      <Image source={{ uri: r.user.avatar }} style={styles.avatar} contentFit="cover" cachePolicy="memory-disk" />
                    ) : (
                      <View style={[styles.avatar, styles.avatarFallback, { backgroundColor: palette.colors.primary }]}>
                        <Text style={{ color: '#fff', fontWeight: fontWeight.bold }}>{(r.user?.username || 'U').charAt(0).toUpperCase()}</Text>
                      </View>
                    )}
                  </View>
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' }}>
                      <Text style={styles.reviewerName}>{r.user?.username || 'Anonymous'}</Text>
                      {r.isVerifiedPurchase && (
                        <View style={styles.verifiedTag}>
                          <Ionicons name="checkmark-circle" size={10} color={palette.colors.success} />
                          <Text style={[styles.verifiedTagText, { color: palette.colors.success }]}>Verified</Text>
                        </View>
                      )}
                    </View>
                    <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 2 }}>
                      <Stars value={r.rating} size={12} />
                      <Text style={styles.timeText}>· {new Date(r.createdAt).toLocaleDateString()}</Text>
                    </View>
                  </View>
                  {isMine && (
                    <TouchableOpacity onPress={() => handleDelete(r._id)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                      <Ionicons name="trash-outline" size={16} color={palette.colors.error} />
                    </TouchableOpacity>
                  )}
                </View>

                {r.title ? <Text style={styles.reviewTitle}>{r.title}</Text> : null}
                {r.comment ? <Text style={styles.reviewBody}>{r.comment}</Text> : null}

                {r.reply?.text ? (
                  <View style={styles.replyBlock}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 4 }}>
                      <Ionicons name="storefront" size={11} color={palette.colors.primary} />
                      <Text style={[styles.replyLabel, { color: palette.colors.primary }]}>Seller response</Text>
                    </View>
                    <Text style={styles.replyText}>{r.reply.text}</Text>
                  </View>
                ) : null}

                <TouchableOpacity style={styles.helpfulBtn} onPress={() => handleHelpful(r._id)} activeOpacity={0.7}>
                  <Ionicons name="thumbs-up-outline" size={12} color={palette.colors.textSecondary} />
                  <Text style={styles.helpfulText}>Helpful · {r.helpfulCount || 0}</Text>
                </TouchableOpacity>
              </GlassPanel>
            );
          })}

          {reviews.length > 3 && (
            <TouchableOpacity style={styles.showAllBtn} onPress={() => setShowAll((s) => !s)}>
              <Text style={[styles.showAllText, { color: palette.colors.primary }]}>
                {showAll ? 'Show less' : `Show all ${reviews.length} reviews`}
              </Text>
              <Ionicons name={showAll ? 'chevron-up' : 'chevron-down'} size={14} color={palette.colors.primary} />
            </TouchableOpacity>
          )}
        </>
      )}

      {/* Submission Modal */}
      <Modal visible={showForm} transparent animationType="slide" onRequestClose={() => setShowForm(false)}>
        <View style={styles.modalOverlay}>
          <GlassPanel variant="strong" style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{myReview ? 'Edit your review' : 'Write a review'}</Text>
              <TouchableOpacity onPress={() => setShowForm(false)}>
                <Ionicons name="close" size={22} color={palette.colors.text} />
              </TouchableOpacity>
            </View>
            <KeyboardAwareFormScrollView bottomOffset={32}>
              <Text style={styles.formLabel}>Your rating</Text>
              <StarPicker value={form.rating} onChange={(v) => setForm((p) => ({ ...p, rating: v }))} />

              <Text style={styles.formLabel}>Title (optional)</Text>
              <TextInput
                style={styles.input}
                value={form.title}
                onChangeText={(v) => setForm((p) => ({ ...p, title: v }))}
                placeholder="Short summary"
                placeholderTextColor={palette.colors.textSecondary}
                maxLength={100}
              />

              <Text style={styles.formLabel}>Your review</Text>
              <TextInput
                style={[styles.input, styles.textarea]}
                value={form.comment}
                onChangeText={(v) => setForm((p) => ({ ...p, comment: v }))}
                placeholder="Share your experience with this store"
                placeholderTextColor={palette.colors.textSecondary}
                multiline
                numberOfLines={5}
                maxLength={1000}
                textAlignVertical="top"
              />
              <Text style={styles.charCount}>{form.comment.length} / 1000</Text>

              <TouchableOpacity style={[styles.submitBtn, submitting && { opacity: 0.6 }]} onPress={submit} disabled={submitting}>
                {submitting ? <ActivityIndicator color="#fff" /> : (
                  <>
                    <Ionicons name="checkmark-circle" size={18} color="#fff" />
                    <Text style={styles.submitBtnText}>{myReview ? 'Update review' : 'Submit review'}</Text>
                  </>
                )}
              </TouchableOpacity>
            </KeyboardAwareFormScrollView>
          </GlassPanel>
        </View>
      </Modal>
    </View>
  );
}

const buildStyles = (p) => StyleSheet.create({
  title: { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: p.colors.text },
  writeBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: p.colors.primary, paddingHorizontal: spacing.md, paddingVertical: 6, borderRadius: 999 },
  writeBtnText: { color: '#fff', fontSize: fontSize.xs, fontWeight: fontWeight.bold },

  summaryCard: { flexDirection: 'row', padding: spacing.md, gap: spacing.md, alignItems: 'center' },
  summaryLeft: { alignItems: 'center', justifyContent: 'center', minWidth: 90, paddingRight: spacing.md, borderRightWidth: 1, borderRightColor: p.glass.borderSubtle },
  avgValue: { fontSize: 32, fontWeight: fontWeight.extrabold, color: p.colors.text, lineHeight: 36 },
  countText: { fontSize: fontSize.xs, color: p.colors.textSecondary, marginTop: 4 },
  summaryRight: { flex: 1, gap: 4 },
  distRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  distLabel: { fontSize: 11, color: p.colors.textSecondary, width: 10, textAlign: 'right' },
  distTrack: { flex: 1, height: 6, borderRadius: 3, backgroundColor: p.glass.bgSubtle, overflow: 'hidden' },
  distFill: { height: '100%', borderRadius: 3 },
  distCount: { fontSize: 10, color: p.colors.textSecondary, width: 22, textAlign: 'right' },

  reviewCard: { padding: spacing.md, marginTop: spacing.sm },
  reviewHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.sm },
  avatarWrap: { width: 36, height: 36 },
  avatar: { width: 36, height: 36, borderRadius: 18 },
  avatarFallback: { justifyContent: 'center', alignItems: 'center' },
  reviewerName: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: p.colors.text },
  verifiedTag: { flexDirection: 'row', alignItems: 'center', gap: 2, marginLeft: 6, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 999, backgroundColor: 'rgba(16,185,129,0.12)' },
  verifiedTagText: { fontSize: 9, fontWeight: fontWeight.bold },
  timeText: { fontSize: 11, color: p.colors.textSecondary, marginLeft: 6 },
  reviewTitle: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: p.colors.text, marginBottom: 4 },
  reviewBody: { fontSize: fontSize.sm, color: p.colors.textSecondary, lineHeight: 20 },

  replyBlock: { marginTop: spacing.sm, paddingLeft: spacing.md, borderLeftWidth: 2, borderLeftColor: p.colors.primary, paddingVertical: 4 },
  replyLabel: { fontSize: 10, fontWeight: fontWeight.bold, marginLeft: 4, textTransform: 'uppercase', letterSpacing: 0.5 },
  replyText: { fontSize: fontSize.sm, color: p.colors.text, lineHeight: 18 },

  helpfulBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: spacing.sm, alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, backgroundColor: p.glass.bgSubtle },
  helpfulText: { fontSize: 11, color: p.colors.textSecondary, fontWeight: fontWeight.medium },

  showAllBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, paddingVertical: spacing.md },
  showAllText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold },

  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalCard: { maxHeight: '85%', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: spacing.lg },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.sm },
  modalTitle: { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: p.colors.text },
  formLabel: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: p.colors.text, marginTop: spacing.md, marginBottom: 6 },
  input: { backgroundColor: p.glass.bgSubtle, borderRadius: 14, padding: spacing.md, fontSize: fontSize.md, color: p.colors.text, borderWidth: 1, borderColor: p.glass.borderSubtle },
  textarea: { minHeight: 100 },
  charCount: { fontSize: 10, color: p.colors.textSecondary, textAlign: 'right', marginTop: 4 },
  submitBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, backgroundColor: p.colors.primary, paddingVertical: 14, borderRadius: 16, marginTop: spacing.lg, ...shadows.md },
  submitBtnText: { color: '#fff', fontSize: fontSize.md, fontWeight: fontWeight.bold },
});

export { Stars };
