import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../contexts/ThemeContext';
import {
  borderRadius,
  fontSize,
  fontWeight,
  shadows,
  spacing,
} from '../../styles/theme';
import { tap as hapticTap } from '../../utils/haptics';
import {
  formatConversationTimestamp,
  groupConversationSessions,
} from '../../utils/aiChatHistory';
import GlassBlurFill from './GlassBlurFill';

const messageCountLabel = (count) => `${count} ${count === 1 ? 'message' : 'messages'}`;

export default function AIChatHistoryModal({
  visible = false,
  conversations = [],
  activeConversationId = null,
  loading = false,
  refreshing = false,
  error = '',
  busyConversationId = null,
  onClose,
  onRefresh,
  onSelect,
  onCreate,
  onRename,
  onDelete,
}) {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const { height: viewportHeight } = useWindowDimensions();
  const styles = useMemo(() => buildStyles(palette), [palette]);
  const [query, setQuery] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [draftTitle, setDraftTitle] = useState('');
  const sections = useMemo(
    () => groupConversationSessions(conversations, query),
    [conversations, query],
  );

  useEffect(() => {
    if (visible) return;
    setQuery('');
    setEditingId(null);
    setDraftTitle('');
  }, [visible]);

  const submitRename = async (conversation) => {
    const title = draftTitle.trim();
    if (!title || title === conversation.title) {
      setEditingId(null);
      setDraftTitle('');
      return;
    }
    const renamed = await onRename?.(conversation._id, title);
    if (renamed !== false) {
      setEditingId(null);
      setDraftTitle('');
    }
  };

  const confirmDelete = (conversation) => {
    hapticTap();
    Alert.alert(
      'Delete this conversation?',
      `“${conversation.title}” and all of its messages will be permanently removed.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => onDelete?.(conversation._id),
        },
      ],
    );
  };

  const renderConversation = ({ item }) => {
    const isActive = item._id === String(activeConversationId || '');
    const isEditing = editingId === item._id;
    const isBusy = busyConversationId === item._id;

    return (
      <TouchableOpacity
        testID={`ai-history-item-${item._id}`}
        style={[styles.conversationCard, isActive && styles.conversationCardActive]}
        onPress={() => {
          if (isEditing || isBusy) return;
          hapticTap();
          onSelect?.(item._id);
        }}
        activeOpacity={0.76}
        disabled={isEditing || isBusy}
        accessibilityRole="button"
        accessibilityLabel={`Open ${item.title}`}
      >
        <LinearGradient
          colors={isActive ? palette.gradients.cta : [palette.colors.primarySubtle, palette.colors.secondarySubtle]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.conversationIcon}
        >
          <Ionicons
            name={isActive ? 'chatbubble-ellipses' : 'chatbubble-outline'}
            size={17}
            color={isActive ? '#fff' : palette.colors.primary}
          />
        </LinearGradient>

        <View style={styles.conversationCopy}>
          {isEditing ? (
            <View style={styles.renameRow}>
              <TextInput
                testID={`ai-history-rename-input-${item._id}`}
                value={draftTitle}
                onChangeText={setDraftTitle}
                onSubmitEditing={() => submitRename(item)}
                maxLength={100}
                autoFocus
                selectTextOnFocus
                returnKeyType="done"
                style={styles.renameInput}
                placeholder="Conversation name"
                placeholderTextColor={palette.colors.textLight}
                accessibilityLabel="Conversation name"
              />
              <TouchableOpacity
                testID={`ai-history-save-rename-${item._id}`}
                style={[styles.inlineAction, styles.inlineActionConfirm, isBusy && styles.disabled]}
                onPress={() => submitRename(item)}
                disabled={isBusy}
                accessibilityRole="button"
                accessibilityLabel="Save conversation name"
              >
                {isBusy
                  ? <ActivityIndicator size="small" color="#fff" />
                  : <Ionicons name="checkmark" size={16} color="#fff" />}
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.inlineAction}
                onPress={() => {
                  setEditingId(null);
                  setDraftTitle('');
                }}
                accessibilityRole="button"
                accessibilityLabel="Cancel rename"
              >
                <Ionicons name="close" size={16} color={palette.colors.textSecondary} />
              </TouchableOpacity>
            </View>
          ) : (
            <>
              <View style={styles.conversationTitleRow}>
                <Text style={styles.conversationTitle} numberOfLines={1}>{item.title}</Text>
                {isActive && (
                  <View style={styles.activeBadge}>
                    <View style={styles.activeDot} />
                    <Text style={styles.activeBadgeText}>OPEN</Text>
                  </View>
                )}
              </View>
              <Text style={styles.conversationPreview} numberOfLines={1}>
                {item.preview || (item.messageCount ? 'Continue this conversation' : 'Ready for your first message')}
              </Text>
              <View style={styles.conversationMetaRow}>
                <Text style={styles.conversationMeta}>{messageCountLabel(item.messageCount)}</Text>
                <View style={styles.metaDot} />
                <Text style={styles.conversationMeta}>
                  {formatConversationTimestamp(item.lastActive)}
                </Text>
                <View style={styles.surfaceBadge}>
                  <Ionicons
                    name={item.source === 'mobile' ? 'phone-portrait-outline' : 'globe-outline'}
                    size={10}
                    color={palette.colors.textLight}
                  />
                  <Text style={styles.surfaceBadgeText}>
                    {item.source === 'mobile' ? 'App' : 'Web'}
                  </Text>
                </View>
              </View>
            </>
          )}
        </View>

        {!isEditing && (
          <View style={styles.itemActions}>
            {isBusy ? (
              <ActivityIndicator size="small" color={palette.colors.primary} />
            ) : (
              <>
                <TouchableOpacity
                  testID={`ai-history-rename-${item._id}`}
                  style={styles.itemAction}
                  onPress={() => {
                    hapticTap();
                    setEditingId(item._id);
                    setDraftTitle(item.title);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={`Rename ${item.title}`}
                  hitSlop={5}
                >
                  <Ionicons name="pencil-outline" size={15} color={palette.colors.textSecondary} />
                </TouchableOpacity>
                <TouchableOpacity
                  testID={`ai-history-delete-${item._id}`}
                  style={[styles.itemAction, styles.deleteAction]}
                  onPress={() => confirmDelete(item)}
                  accessibilityRole="button"
                  accessibilityLabel={`Delete ${item.title}`}
                  hitSlop={5}
                >
                  <Ionicons name="trash-outline" size={15} color={palette.colors.error} />
                </TouchableOpacity>
              </>
            )}
          </View>
        )}
      </TouchableOpacity>
    );
  };

  const hasSearch = Boolean(query.trim());
  const sheetHeight = Math.min(780, Math.max(520, viewportHeight * 0.9));

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close conversation history"
        />
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.sheetAnchor}
          pointerEvents="box-none"
        >
          <View
            testID="ai-chat-history-modal"
            style={[styles.sheet, { height: sheetHeight, paddingBottom: Math.max(insets.bottom, spacing.md) }]}
          >
            <GlassBlurFill intensity={64} nativeAndroidBlur />
            {Platform.OS !== 'android' && (
              <LinearGradient
                colors={['rgba(20,184,166,0.12)', 'rgba(14,165,233,0.05)', 'rgba(99,102,241,0.14)']}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={StyleSheet.absoluteFill}
                pointerEvents="none"
              />
            )}

            <View style={styles.handle} />
            <View style={styles.header}>
              <LinearGradient colors={palette.gradients.cta} style={styles.headerIcon}>
                <Ionicons name="time" size={21} color="#fff" />
              </LinearGradient>
              <View style={styles.headerCopy}>
                <Text style={styles.eyebrow}>YOUR CONVERSATIONS</Text>
                <Text style={styles.title}>Chat history</Text>
                <Text style={styles.subtitle}>Pick up exactly where you left off.</Text>
              </View>
              <View style={styles.savedBadge}>
                <Text style={styles.savedBadgeValue}>{conversations.length}</Text>
                <Text style={styles.savedBadgeLabel}>SAVED</Text>
              </View>
              <TouchableOpacity
                style={styles.closeButton}
                onPress={onClose}
                accessibilityRole="button"
                accessibilityLabel="Close conversation history"
              >
                <Ionicons name="close" size={20} color={palette.colors.text} />
              </TouchableOpacity>
            </View>

            <View style={styles.toolbar}>
              <TouchableOpacity
                testID="ai-history-new-chat"
                style={[styles.newChatButton, busyConversationId === 'new' && styles.disabled]}
                onPress={() => {
                  hapticTap();
                  onCreate?.();
                }}
                activeOpacity={0.82}
                disabled={busyConversationId === 'new'}
                accessibilityRole="button"
                accessibilityLabel="Start a new conversation"
              >
                <LinearGradient
                  colors={palette.gradients.cta}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={StyleSheet.absoluteFill}
                />
                {busyConversationId === 'new'
                  ? <ActivityIndicator size="small" color="#fff" />
                  : <Ionicons name="add" size={19} color="#fff" />}
                <Text style={styles.newChatText}>New chat</Text>
                <Ionicons name="sparkles" size={14} color="rgba(255,255,255,0.78)" />
              </TouchableOpacity>

              <View style={styles.searchBox}>
                <Ionicons name="search" size={17} color={palette.colors.textLight} />
                <TextInput
                  testID="ai-history-search"
                  value={query}
                  onChangeText={setQuery}
                  style={styles.searchInput}
                  placeholder="Search chats"
                  placeholderTextColor={palette.colors.textLight}
                  returnKeyType="search"
                  clearButtonMode="while-editing"
                  accessibilityLabel="Search conversations"
                />
                {!!query && Platform.OS !== 'ios' && (
                  <TouchableOpacity
                    onPress={() => setQuery('')}
                    accessibilityRole="button"
                    accessibilityLabel="Clear search"
                  >
                    <Ionicons name="close-circle" size={17} color={palette.colors.textLight} />
                  </TouchableOpacity>
                )}
              </View>
            </View>

            {!!error && !loading && (
              <TouchableOpacity style={styles.errorBanner} onPress={onRefresh} activeOpacity={0.8}>
                <Ionicons name="cloud-offline-outline" size={17} color={palette.colors.error} />
                <Text style={styles.errorText}>{error}</Text>
                <Text style={styles.retryText}>Retry</Text>
              </TouchableOpacity>
            )}

            {loading && conversations.length === 0 ? (
              <View style={styles.loadingState}>
                <LinearGradient colors={palette.gradients.cta} style={styles.loadingIcon}>
                  <ActivityIndicator size="small" color="#fff" />
                </LinearGradient>
                <Text style={styles.loadingTitle}>Loading your conversations</Text>
                <Text style={styles.loadingSubtitle}>Syncing your recent chats securely…</Text>
              </View>
            ) : (
              <SectionList
                sections={sections}
                keyExtractor={(item) => item._id}
                renderItem={renderConversation}
                renderSectionHeader={({ section }) => (
                  <View style={styles.sectionHeader}>
                    <Ionicons name="calendar-clear-outline" size={12} color={palette.colors.textLight} />
                    <Text style={styles.sectionTitle}>{section.title}</Text>
                    <View style={styles.sectionLine} />
                  </View>
                )}
                refreshControl={(
                  <RefreshControl
                    refreshing={refreshing}
                    onRefresh={onRefresh}
                    tintColor={palette.colors.primary}
                    colors={[palette.colors.primary]}
                  />
                )}
                contentContainerStyle={styles.listContent}
                keyboardShouldPersistTaps="handled"
                stickySectionHeadersEnabled={false}
                showsVerticalScrollIndicator={false}
                ListEmptyComponent={(
                  <View style={styles.emptyState}>
                    <View style={styles.emptyIcon}>
                      <Ionicons
                        name={hasSearch ? 'search-outline' : 'chatbubbles-outline'}
                        size={27}
                        color={palette.colors.primary}
                      />
                    </View>
                    <Text style={styles.emptyTitle}>
                      {hasSearch ? 'No matching conversations' : 'Your next idea starts here'}
                    </Text>
                    <Text style={styles.emptySubtitle}>
                      {hasSearch
                        ? 'Try a different title or message keyword.'
                        : 'Start a chat and it will be saved here automatically.'}
                    </Text>
                  </View>
                )}
                ListFooterComponent={conversations.length > 0 ? (
                  <View style={styles.footerNote}>
                    <Ionicons name="shield-checkmark-outline" size={13} color={palette.colors.success} />
                    <Text style={styles.footerNoteText}>Up to 50 conversations are securely saved to your account.</Text>
                  </View>
                ) : null}
              />
            )}
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const buildStyles = (p) => StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: p.colors.overlay,
  },
  sheetAnchor: {
    justifyContent: 'flex-end',
  },
  sheet: {
    overflow: 'hidden',
    backgroundColor: p.colors.surface,
    borderTopLeftRadius: 30,
    borderTopRightRadius: 30,
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: p.glass.borderStrong,
    ...shadows.xl,
  },
  handle: {
    alignSelf: 'center',
    width: 42,
    height: 4,
    marginTop: spacing.sm,
    borderRadius: borderRadius.full,
    backgroundColor: p.colors.grayLighter,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
  },
  headerIcon: {
    width: 46,
    height: 46,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#0EA5E9',
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.3,
    shadowRadius: 10,
    elevation: 5,
  },
  headerCopy: {
    flex: 1,
    minWidth: 0,
  },
  eyebrow: {
    color: p.colors.primary,
    fontSize: 9,
    fontWeight: fontWeight.bold,
    letterSpacing: 1,
  },
  title: {
    marginTop: 1,
    color: p.colors.text,
    fontSize: fontSize.xl,
    fontWeight: fontWeight.extrabold,
    letterSpacing: -0.35,
  },
  subtitle: {
    marginTop: 1,
    color: p.colors.textSecondary,
    fontSize: 10,
  },
  savedBadge: {
    minWidth: 42,
    paddingHorizontal: spacing.xs,
    paddingVertical: 6,
    alignItems: 'center',
    borderRadius: 12,
    backgroundColor: p.colors.primarySubtle,
    borderWidth: 1,
    borderColor: p.colors.primaryLighter,
  },
  savedBadgeValue: {
    color: p.colors.primary,
    fontSize: fontSize.sm,
    lineHeight: 15,
    fontWeight: fontWeight.extrabold,
  },
  savedBadgeLabel: {
    color: p.colors.primary,
    fontSize: 7,
    letterSpacing: 0.7,
    fontWeight: fontWeight.bold,
  },
  closeButton: {
    width: 38,
    height: 38,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: p.glass.bgSubtle,
    borderWidth: 1,
    borderColor: p.glass.border,
  },
  toolbar: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  newChatButton: {
    minWidth: 126,
    minHeight: 46,
    overflow: 'hidden',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: spacing.md,
    borderRadius: 15,
    ...shadows.md,
  },
  newChatText: {
    color: '#fff',
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
  },
  searchBox: {
    flex: 1,
    minWidth: 0,
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: 15,
    backgroundColor: p.glass.bgSubtle,
    borderWidth: 1,
    borderColor: p.glass.border,
  },
  searchInput: {
    flex: 1,
    minWidth: 0,
    paddingVertical: 0,
    color: p.colors.text,
    fontSize: fontSize.sm,
  },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: 14,
    backgroundColor: p.colors.errorSubtle,
    borderWidth: 1,
    borderColor: p.colors.errorLighter,
  },
  errorText: {
    flex: 1,
    color: p.colors.error,
    fontSize: fontSize.xs,
    lineHeight: 16,
  },
  retryText: {
    color: p.colors.error,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
  },
  listContent: {
    flexGrow: 1,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xs,
    paddingBottom: spacing.md,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs,
  },
  sectionTitle: {
    color: p.colors.textLight,
    fontSize: 10,
    fontWeight: fontWeight.bold,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  sectionLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: p.glass.border,
  },
  conversationCard: {
    minHeight: 82,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.sm,
    padding: spacing.sm,
    borderRadius: 18,
    backgroundColor: p.glass.bgSubtle,
    borderWidth: 1,
    borderColor: p.glass.borderSubtle,
  },
  conversationCardActive: {
    backgroundColor: p.colors.primarySubtle,
    borderColor: p.colors.primaryLighter,
  },
  conversationIcon: {
    width: 42,
    height: 42,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  conversationCopy: {
    flex: 1,
    minWidth: 0,
  },
  conversationTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  conversationTitle: {
    flex: 1,
    minWidth: 0,
    color: p.colors.text,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
  },
  activeBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: borderRadius.full,
    backgroundColor: p.colors.successSubtle,
  },
  activeDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: p.colors.success,
  },
  activeBadgeText: {
    color: p.colors.success,
    fontSize: 7,
    fontWeight: fontWeight.bold,
    letterSpacing: 0.45,
  },
  conversationPreview: {
    marginTop: 3,
    color: p.colors.textSecondary,
    fontSize: 11,
  },
  conversationMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 5,
  },
  conversationMeta: {
    color: p.colors.textLight,
    fontSize: 9,
    fontWeight: fontWeight.medium,
  },
  metaDot: {
    width: 3,
    height: 3,
    borderRadius: 2,
    backgroundColor: p.colors.textLight,
  },
  surfaceBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    marginLeft: 2,
  },
  surfaceBadgeText: {
    color: p.colors.textLight,
    fontSize: 8,
    fontWeight: fontWeight.semibold,
  },
  itemActions: {
    flexDirection: 'column',
    gap: 4,
  },
  itemAction: {
    width: 30,
    height: 30,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: p.glass.bgStrong,
    borderWidth: 1,
    borderColor: p.glass.borderSubtle,
  },
  deleteAction: {
    backgroundColor: p.colors.errorSubtle,
    borderColor: p.colors.errorLighter,
  },
  renameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  renameInput: {
    flex: 1,
    minWidth: 0,
    height: 42,
    paddingHorizontal: spacing.sm,
    borderRadius: 12,
    color: p.colors.text,
    backgroundColor: p.colors.surface,
    borderWidth: 1,
    borderColor: p.colors.primaryLighter,
    fontSize: fontSize.sm,
  },
  inlineAction: {
    width: 34,
    height: 34,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: p.glass.bgStrong,
    borderWidth: 1,
    borderColor: p.glass.border,
  },
  inlineActionConfirm: {
    backgroundColor: p.colors.success,
    borderColor: p.colors.success,
  },
  loadingState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  loadingIcon: {
    width: 52,
    height: 52,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
  loadingTitle: {
    color: p.colors.text,
    fontSize: fontSize.md,
    fontWeight: fontWeight.bold,
  },
  loadingSubtitle: {
    marginTop: spacing.xs,
    color: p.colors.textSecondary,
    fontSize: fontSize.sm,
    textAlign: 'center',
  },
  emptyState: {
    flex: 1,
    minHeight: 260,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  emptyIcon: {
    width: 58,
    height: 58,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
    backgroundColor: p.colors.primarySubtle,
    borderWidth: 1,
    borderColor: p.colors.primaryLighter,
  },
  emptyTitle: {
    color: p.colors.text,
    fontSize: fontSize.md,
    fontWeight: fontWeight.bold,
    textAlign: 'center',
  },
  emptySubtitle: {
    maxWidth: 280,
    marginTop: spacing.xs,
    color: p.colors.textSecondary,
    fontSize: fontSize.sm,
    lineHeight: 18,
    textAlign: 'center',
  },
  footerNote: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs,
  },
  footerNoteText: {
    color: p.colors.textLight,
    fontSize: 9,
    textAlign: 'center',
  },
  disabled: {
    opacity: 0.55,
  },
});
