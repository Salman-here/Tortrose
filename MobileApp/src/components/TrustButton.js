import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Toast from 'react-native-toast-message';
import api from '../config/api';
import { useAuth } from '../contexts/AuthContext';
import { colors, spacing, fontSize, borderRadius } from '../styles/theme';

/**
 * TrustButton Component
 * Allows users to trust/untrust stores
 * 
 * @param {Object} props
 * @param {string} props.storeId - The store's ID
 * @param {string} props.storeName - The store's name for toast messages
 * @param {number} props.initialTrustCount - Initial trust count
 * @param {boolean} props.initialIsTrusted - Initial trust status
 * @param {boolean} props.compact - Use compact mode for cards
 * @param {Function} props.onTrustChange - Callback when trust status changes
 */
const TrustButton = ({ 
  storeId, 
  storeName, 
  initialTrustCount = 0, 
  initialIsTrusted = false, 
  compact = false,
  onTrustChange 
}) => {
  const [isTrusted, setIsTrusted] = useState(initialIsTrusted);
  const [trustCount, setTrustCount] = useState(initialTrustCount);
  const [isLoading, setIsLoading] = useState(false);
  const { currentUser } = useAuth();

  useEffect(() => {
    setIsTrusted(initialIsTrusted);
    setTrustCount(initialTrustCount);
  }, [initialIsTrusted, initialTrustCount]);

  // Fetch trust status when component mounts
  useEffect(() => {
    const fetchTrustStatus = async () => {
      if (!currentUser || !storeId) return;

      try {
        const response = await api.get(`/api/stores/${storeId}/trust-status`);

        setIsTrusted(response.data.data.isTrusted);
        setTrustCount(response.data.data.trustCount);
      } catch (error) {
        console.log('Could not fetch trust status:', error.message);
      }
    };

    fetchTrustStatus();
  }, [storeId, currentUser]);

  const handleTrustToggle = async () => {
    if (!currentUser) {
      Toast.show({
        type: 'info',
        text1: 'Login Required',
        text2: 'Please login to trust stores'
      });
      return;
    }

    setIsLoading(true);
    
    // Store previous state for rollback
    const previousIsTrusted = isTrusted;
    const previousTrustCount = trustCount;

    try {
      if (isTrusted) {
        // Optimistic update
        setIsTrusted(false);
        setTrustCount(prev => Math.max(0, prev - 1));

        const response = await api.delete(`/api/stores/${storeId}/trust`);

        setTrustCount(response.data.data.trustCount);
        Toast.show({
          type: 'success',
          text1: 'Untrusted',
          text2: `You no longer trust ${storeName}`
        });

        if (onTrustChange) {
          onTrustChange(false, response.data.data.trustCount);
        }
      } else {
        // Optimistic update
        setIsTrusted(true);
        setTrustCount(prev => prev + 1);

        const response = await api.post(`/api/stores/${storeId}/trust`, {});

        setTrustCount(response.data.data.trustCount);
        Toast.show({
          type: 'success',
          text1: 'Trusted',
          text2: `You now trust ${storeName}`
        });

        if (onTrustChange) {
          onTrustChange(true, response.data.data.trustCount);
        }
      }
    } catch (error) {
      // Rollback on error
      setIsTrusted(previousIsTrusted);
      setTrustCount(previousTrustCount);

      const errorMessage = error.response?.data?.message || error.message || 'Failed to update trust status';
      
      if (error.response?.status === 400) {
        if (error.response?.data?.message?.includes('already trusted')) {
          setIsTrusted(true);
          Toast.show({ type: 'info', text1: 'Info', text2: 'You already trust this store' });
        } else if (error.response?.data?.message?.includes('not trusted')) {
          setIsTrusted(false);
          Toast.show({ type: 'info', text1: 'Info', text2: 'You have not trusted this store' });
        } else {
          Toast.show({ type: 'error', text1: 'Error', text2: errorMessage });
        }
      } else {
        Toast.show({ type: 'error', text1: 'Error', text2: errorMessage });
      }
    } finally {
      setIsLoading(false);
    }
  };

  // Compact mode for store cards
  if (compact) {
    return (
      <TouchableOpacity
        onPress={handleTrustToggle}
        disabled={isLoading || !currentUser}
        style={[
          styles.compactButton,
          isTrusted ? styles.trustedButton : styles.untrustedButton,
          (isLoading || !currentUser) && styles.disabledButton
        ]}
      >
        {isLoading ? (
          <ActivityIndicator size="small" color={isTrusted ? colors.white : colors.gray} />
        ) : (
          <>
            <Ionicons 
              name={isTrusted ? 'checkmark' : 'add'} 
              size={14} 
              color={isTrusted ? colors.white : colors.text} 
            />
            <Text style={[
              styles.compactText,
              isTrusted ? styles.trustedText : styles.untrustedText
            ]}>
              {isTrusted ? 'Trusting' : 'Trust'}
            </Text>
          </>
        )}
      </TouchableOpacity>
    );
  }

  // Full mode for store pages
  return (
    <View style={styles.container}>
      <TouchableOpacity
        onPress={handleTrustToggle}
        disabled={isLoading || !currentUser}
        style={[
          styles.fullButton,
          isTrusted ? styles.trustedButton : styles.untrustedButton,
          (isLoading || !currentUser) && styles.disabledButton
        ]}
      >
        {isLoading ? (
          <ActivityIndicator size="small" color={isTrusted ? colors.white : colors.gray} />
        ) : (
          <>
            <Ionicons 
              name={isTrusted ? 'checkmark' : 'add'} 
              size={18} 
              color={isTrusted ? colors.white : colors.text} 
            />
            <Text style={[
              styles.fullText,
              isTrusted ? styles.trustedText : styles.untrustedText
            ]}>
              {isTrusted ? 'Trusting' : 'Trust'}
            </Text>
          </>
        )}
      </TouchableOpacity>
      
      <View style={styles.countContainer}>
        <Text style={styles.countNumber}>{trustCount}</Text>
        <Text style={styles.countLabel}>
          {trustCount === 1 ? 'truster' : 'trusters'}
        </Text>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  compactButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: borderRadius.full,
    gap: spacing.xs,
  },
  fullButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.md,
    gap: spacing.sm,
  },
  trustedButton: {
    backgroundColor: colors.success,
  },
  untrustedButton: {
    backgroundColor: colors.light,
  },
  disabledButton: {
    opacity: 0.5,
  },
  compactText: {
    fontSize: fontSize.xs,
    fontWeight: '600',
  },
  fullText: {
    fontSize: fontSize.md,
    fontWeight: '500',
  },
  trustedText: {
    color: colors.white,
  },
  untrustedText: {
    color: colors.text,
  },
  countContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  countNumber: {
    fontSize: fontSize.md,
    fontWeight: '600',
    color: colors.text,
  },
  countLabel: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
  },
});

export default TrustButton;
