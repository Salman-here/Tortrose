/**
 * ProductOptionsModal — premium, shared buyer option selector.
 *
 * This is deliberately a controlled submit boundary: a product with required
 * options cannot reach the cart handler until every group has a valid value.
 * It is used by product cards (including quick-add) and ProductDetailScreen so
 * the selection experience is consistent throughout the native storefront.
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import GlassPanel from './GlassPanel';
import { useTheme } from '../../contexts/ThemeContext';
import { spacing, fontSize, borderRadius, shadows, fontWeight } from '../../styles/theme';
import { tap as hapticTap } from '../../utils/haptics';
import {
  describeSelectionError,
  getInitialProductSelections,
  getProductOptionGroups,
  validateProductSelections,
} from '../../utils/productOptions';

const OPTION_GRADIENT_FALLBACK = ['#14B8A6', '#0EA5E9', '#6366F1'];

const selectionKey = (selectedColor, selectedOptions) => JSON.stringify({
  selectedColor: selectedColor || null,
  selectedOptions: selectedOptions || {},
});

export function ProductOptionsModal({
  visible = false,
  product,
  selectedColor = null,
  selectedOptions = {},
  onClose,
  onConfirm,
  submitting = false,
}) {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const { height: viewportHeight } = useWindowDimensions();
  const groups = useMemo(() => getProductOptionGroups(product), [product]);
  const styles = useMemo(() => buildStyles(palette), [palette]);
  const initialKey = useMemo(
    () => selectionKey(selectedColor, selectedOptions),
    [selectedColor, selectedOptions],
  );
  const [draftColor, setDraftColor] = useState(selectedColor || null);
  const [draftOptions, setDraftOptions] = useState(selectedOptions || {});
  const [showValidation, setShowValidation] = useState(false);

  // Reset a cancelled draft when the sheet is opened again, while preserving
  // the parent screen's current selection as the source of truth.
  useEffect(() => {
    if (!visible) return;
    const initial = getInitialProductSelections(product, {
      selectedColor,
      selectedOptions,
    });
    setDraftColor(initial.selectedColor);
    setDraftOptions(initial.selectedOptions || {});
    setShowValidation(false);
  }, [visible, product?._id, initialKey]);

  const validation = useMemo(
    () => validateProductSelections(product, {
      selectedColor: draftColor,
      selectedOptions: draftOptions,
    }),
    [product, draftColor, draftOptions],
  );

  const missingNames = useMemo(
    () => new Set((validation.missingOptions || []).map((option) => option.name.toLocaleLowerCase())),
    [validation.missingOptions],
  );

  const handleSelect = (group, value) => {
    if (submitting) return;
    hapticTap();
    setShowValidation(false);
    if (group.legacy) {
      setDraftColor(value);
      // A synthetic legacy Color group is represented by selectedColor, not a
      // second selectedOptions key. This keeps cart-line identity stable.
      setDraftOptions((previous) => {
        const next = { ...previous };
        Object.keys(next)
          .filter((key) => key.toLocaleLowerCase() === 'color')
          .forEach((key) => delete next[key]);
        return next;
      });
      return;
    }

    setDraftOptions((previous) => ({ ...previous, [group.name]: value }));
    if (group.name.toLocaleLowerCase() === 'color') setDraftColor(value);
  };

  const handleConfirm = () => {
    if (submitting) return;
    const nextValidation = validateProductSelections(product, {
      selectedColor: draftColor,
      selectedOptions: draftOptions,
    });
    if (!nextValidation.ok) {
      hapticTap();
      setShowValidation(true);
      return;
    }
    hapticTap();
    onConfirm?.({
      selectedColor: nextValidation.selectedColor,
      selectedOptions: nextValidation.selectedOptions,
    });
  };

  if (!product || groups.length === 0) return null;

  const selectedCount = groups.reduce((count, group) => {
    const selected = group.legacy
      ? draftColor
      : draftOptions?.[group.name];
    return count + (selected ? 1 : 0);
  }, 0);
  const progress = groups.length > 0 ? Math.min(1, selectedCount / groups.length) : 0;
  const errorMessage = showValidation ? describeSelectionError(validation) : '';
  const maxSheetHeight = Math.max(420, Math.min(viewportHeight * 0.9, 760));

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      statusBarTranslucent
      onRequestClose={() => {
        if (!submitting) onClose?.();
      }}
      accessibilityViewIsModal
      testID="product-options-modal"
    >
      <View style={styles.overlay}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={() => {
            if (!submitting) onClose?.();
          }}
          accessibilityRole="button"
          accessibilityLabel="Close product options"
        />
        <View style={[styles.sheetWrap, { maxHeight: maxSheetHeight, paddingBottom: Math.max(insets.bottom, spacing.md) }]}>
          <GlassPanel variant="strong" style={styles.sheet}>
            <View style={styles.handle} />
            <View style={styles.header}>
              <LinearGradient
                colors={palette.gradients?.cta || OPTION_GRADIENT_FALLBACK}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.headerIcon}
              >
                <Ionicons name="options-outline" size={21} color="#fff" />
              </LinearGradient>
              <View style={styles.headerCopy}>
                <Text style={styles.eyebrow}>PERSONALIZE YOUR PICK</Text>
                <Text style={styles.title} numberOfLines={2}>Choose options</Text>
                <Text style={styles.productName} numberOfLines={1}>{product.name || 'This product'}</Text>
              </View>
              <TouchableOpacity
                style={styles.closeButton}
                onPress={() => {
                  if (!submitting) onClose?.();
                }}
                disabled={submitting}
                accessibilityRole="button"
                accessibilityLabel="Close product options"
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Ionicons name="close" size={20} color={palette.colors.text} />
              </TouchableOpacity>
            </View>

            <View style={styles.progressBlock}>
              <View style={styles.progressCopy}>
                <Text style={styles.progressLabel}>Your selections</Text>
                <Text style={styles.progressValue}>{selectedCount} of {groups.length}</Text>
              </View>
              <View style={styles.progressTrack}>
                <LinearGradient
                  colors={palette.gradients?.cta || OPTION_GRADIENT_FALLBACK}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 0 }}
                  style={[styles.progressFill, { width: `${Math.round(progress * 100)}%` }]}
                />
              </View>
            </View>

            <ScrollView
              style={styles.optionsScroll}
              contentContainerStyle={styles.optionsContent}
              showsVerticalScrollIndicator={false}
              bounces
            >
              {groups.map((group, groupIndex) => {
                const selectedValue = group.legacy
                  ? draftColor
                  : draftOptions?.[group.name];
                const missing = showValidation && missingNames.has(group.name.toLocaleLowerCase());
                return (
                  <View
                    key={`${group.name}-${groupIndex}`}
                    style={[styles.groupCard, missing && styles.groupCardError]}
                    testID={`option-group-${group.name}`}
                  >
                    <View style={styles.groupHeading}>
                      <View style={styles.groupTitleWrap}>
                        <Text style={styles.groupTitle}>{group.name}</Text>
                        <Text style={styles.requiredLabel}>REQUIRED</Text>
                      </View>
                      {selectedValue ? (
                        <View style={styles.selectedIndicator}>
                          <Ionicons name="checkmark-circle" size={15} color={palette.colors.success} />
                          <Text style={styles.selectedIndicatorText}>Selected</Text>
                        </View>
                      ) : (
                        <Text style={[styles.chooseHint, missing && styles.chooseHintError]}>Choose one</Text>
                      )}
                    </View>
                    <View style={styles.chipsWrap}>
                      {group.values.map((value) => {
                        const active = selectedValue === value;
                        const suggested = group.default === value;
                        return (
                          <TouchableOpacity
                            key={value}
                            style={[styles.optionChip, active && styles.optionChipActive]}
                            onPress={() => handleSelect(group, value)}
                            disabled={submitting}
                            activeOpacity={0.78}
                            accessibilityRole="button"
                            accessibilityLabel={`${group.name}: ${value}${suggested ? ', suggested' : ''}`}
                            accessibilityState={{ selected: active, disabled: submitting }}
                            testID={`option-value-${group.name}-${value}`}
                          >
                            {active && (
                              <LinearGradient
                                colors={palette.gradients?.cta || OPTION_GRADIENT_FALLBACK}
                                start={{ x: 0, y: 0 }}
                                end={{ x: 1, y: 1 }}
                                style={StyleSheet.absoluteFill}
                                pointerEvents="none"
                              />
                            )}
                            {active && <Ionicons name="checkmark" size={15} color="#fff" />}
                            <Text style={[styles.optionChipText, active && styles.optionChipTextActive]}>{value}</Text>
                            {suggested && (
                              <View style={[styles.suggestedBadge, active && styles.suggestedBadgeActive]}>
                                <Text style={[styles.suggestedBadgeText, active && styles.suggestedBadgeTextActive]}>SUGGESTED</Text>
                              </View>
                            )}
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  </View>
                );
              })}
            </ScrollView>

            <View style={styles.footer}>
              <View style={styles.footerMessageWrap}>
                <Ionicons
                  name={validation.ok ? 'shield-checkmark-outline' : 'information-circle-outline'}
                  size={17}
                  color={validation.ok ? palette.colors.success : palette.colors.textSecondary}
                />
                <Text style={[styles.footerMessage, errorMessage && styles.footerMessageError]} numberOfLines={2}>
                  {errorMessage || (validation.ok ? 'Everything looks good — ready for your bag.' : 'Select one value in every section to continue.')}
                </Text>
              </View>
              <TouchableOpacity
                style={[styles.confirmButton, submitting && styles.confirmButtonDisabled]}
                onPress={handleConfirm}
                disabled={submitting}
                activeOpacity={0.84}
                accessibilityRole="button"
                accessibilityLabel={validation.ok ? 'Add selected options to cart' : 'Complete product options'}
                accessibilityState={{ disabled: submitting, busy: submitting }}
                testID="confirm-product-options"
              >
                <LinearGradient
                  colors={palette.gradients?.cta || OPTION_GRADIENT_FALLBACK}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={StyleSheet.absoluteFill}
                  pointerEvents="none"
                />
                {submitting ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <>
                    <Ionicons name={validation.ok ? 'bag-add-outline' : 'options-outline'} size={18} color="#fff" />
                    <Text style={styles.confirmButtonText}>{validation.ok ? 'Add to cart' : 'Complete selections'}</Text>
                    <Ionicons name="arrow-forward" size={16} color="rgba(255,255,255,0.9)" />
                  </>
                )}
              </TouchableOpacity>
            </View>
          </GlassPanel>
        </View>
      </View>
    </Modal>
  );
}

const buildStyles = (p) => StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(7, 12, 28, 0.62)',
  },
  sheetWrap: {
    width: '100%',
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.sm,
  },
  sheet: {
    padding: 0,
    borderRadius: 28,
    borderColor: p.glass.borderStrong,
    overflow: 'hidden',
  },
  handle: {
    alignSelf: 'center',
    width: 42,
    height: 4,
    borderRadius: borderRadius.full,
    marginTop: spacing.sm,
    backgroundColor: p.glass.borderStrong,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
    gap: spacing.md,
  },
  headerIcon: {
    width: 46,
    height: 46,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadows.sm,
  },
  headerCopy: {
    flex: 1,
    minWidth: 0,
  },
  eyebrow: {
    color: p.colors.primary,
    fontSize: 9,
    letterSpacing: 1.2,
    fontWeight: fontWeight.extrabold,
    marginBottom: 2,
  },
  title: {
    color: p.colors.text,
    fontSize: fontSize.xl,
    lineHeight: 23,
    fontWeight: fontWeight.extrabold,
  },
  productName: {
    color: p.colors.textSecondary,
    fontSize: fontSize.xs,
    marginTop: 2,
  },
  closeButton: {
    width: 36,
    height: 36,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: p.glass.bgSubtle,
    borderWidth: 1,
    borderColor: p.glass.borderSubtle,
  },
  progressBlock: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    padding: spacing.md,
    borderRadius: 16,
    backgroundColor: p.glass.bgSubtle,
    borderWidth: 1,
    borderColor: p.glass.borderSubtle,
  },
  progressCopy: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  progressLabel: {
    color: p.colors.textSecondary,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
    letterSpacing: 0.3,
  },
  progressValue: {
    color: p.colors.primary,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
  },
  progressTrack: {
    height: 6,
    borderRadius: borderRadius.full,
    overflow: 'hidden',
    backgroundColor: p.glass.borderSubtle,
  },
  progressFill: {
    height: '100%',
    borderRadius: borderRadius.full,
    minWidth: 0,
  },
  optionsScroll: {
    flexShrink: 1,
  },
  optionsContent: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xs,
    paddingBottom: spacing.sm,
    gap: spacing.sm,
  },
  groupCard: {
    padding: spacing.md,
    borderRadius: 18,
    backgroundColor: p.glass.bgSubtle,
    borderWidth: 1,
    borderColor: p.glass.borderSubtle,
  },
  groupCardError: {
    borderColor: `${p.colors.error}88`,
    backgroundColor: `${p.colors.error}0D`,
  },
  groupHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  groupTitleWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    flex: 1,
  },
  groupTitle: {
    color: p.colors.text,
    fontSize: fontSize.md,
    fontWeight: fontWeight.bold,
  },
  requiredLabel: {
    color: p.colors.textLight,
    fontSize: 9,
    letterSpacing: 0.7,
    fontWeight: fontWeight.bold,
  },
  chooseHint: {
    color: p.colors.textLight,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.medium,
  },
  chooseHintError: {
    color: p.colors.error,
  },
  selectedIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  selectedIndicatorText: {
    color: p.colors.success,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
  },
  chipsWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  optionChip: {
    minHeight: 42,
    paddingHorizontal: spacing.md,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: p.glass.border,
    backgroundColor: p.glass.bg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    overflow: 'hidden',
  },
  optionChipActive: {
    borderColor: 'rgba(255,255,255,0.42)',
    ...shadows.sm,
  },
  optionChipText: {
    color: p.colors.text,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
  },
  optionChipTextActive: {
    color: '#fff',
  },
  suggestedBadge: {
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 999,
    backgroundColor: `${p.colors.primary}16`,
  },
  suggestedBadgeActive: {
    backgroundColor: 'rgba(255,255,255,0.20)',
  },
  suggestedBadgeText: {
    color: p.colors.primary,
    fontSize: 8,
    letterSpacing: 0.35,
    fontWeight: fontWeight.bold,
  },
  suggestedBadgeTextActive: {
    color: '#fff',
  },
  footer: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    gap: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: p.glass.borderSubtle,
  },
  footerMessageWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    minHeight: 24,
  },
  footerMessage: {
    flex: 1,
    color: p.colors.textSecondary,
    fontSize: fontSize.xs,
    lineHeight: 16,
  },
  footerMessageError: {
    color: p.colors.error,
    fontWeight: fontWeight.semibold,
  },
  confirmButton: {
    minHeight: 52,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    overflow: 'hidden',
    ...shadows.md,
  },
  confirmButtonDisabled: {
    opacity: 0.65,
  },
  confirmButtonText: {
    color: '#fff',
    fontSize: fontSize.md,
    fontWeight: fontWeight.bold,
  },
});

export default ProductOptionsModal;
