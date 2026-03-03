import React, { useState, useEffect } from 'react';
import { 
  View, 
  Text, 
  ScrollView, 
  StyleSheet, 
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform 
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as SecureStore from 'expo-secure-store';
import Toast from 'react-native-toast-message';
import api from '../config/api';
import { useAuth } from '../contexts/AuthContext';
import { colors, spacing, fontSize, borderRadius, shadows } from '../styles/theme';

export default function BecomeSellerScreen({ navigation }) {
  const { currentUser, fetchAndUpdateCurrentUser } = useAuth();
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({
    phoneNumber: '',
    address: '',
    city: '',
    country: '',
    businessName: ''
  });

  // Redirect if already a seller or admin
  useEffect(() => {
    if (currentUser?.role === 'seller' || currentUser?.role === 'admin') {
      navigation.replace('SellerDashboard');
    }
  }, [currentUser, navigation]);

  const handleInputChange = (name, value) => {
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const validateForm = () => {
    if (!formData.phoneNumber || formData.phoneNumber.trim().length < 10) {
      Toast.show({
        type: 'error',
        text1: 'Invalid Phone',
        text2: 'Please enter a valid phone number (at least 10 digits)'
      });
      return false;
    }

    if (!formData.address || formData.address.trim().length < 5) {
      Toast.show({
        type: 'error',
        text1: 'Invalid Address',
        text2: 'Please enter a valid address'
      });
      return false;
    }

    if (!formData.city || formData.city.trim().length < 2) {
      Toast.show({
        type: 'error',
        text1: 'Invalid City',
        text2: 'Please enter your city'
      });
      return false;
    }

    if (!formData.country || formData.country.trim().length < 2) {
      Toast.show({
        type: 'error',
        text1: 'Invalid Country',
        text2: 'Please enter your country'
      });
      return false;
    }

    return true;
  };

  const handleBecomeSeller = async () => {
    if (!validateForm()) return;

    setLoading(true);

    try {
      const res = await api.post('/api/user/become-seller', {
        phoneNumber: formData.phoneNumber.trim(),
        address: formData.address.trim(),
        city: formData.city.trim(),
        country: formData.country.trim(),
        businessName: formData.businessName.trim()
      });

      // Save the new token with updated role
      if (res.data.token) {
        await SecureStore.setItemAsync('jwtToken', res.data.token);
      }

      Toast.show({
        type: 'success',
        text1: '🎉 Congratulations!',
        text2: 'You are now a seller!'
      });

      // Refresh user data
      if (fetchAndUpdateCurrentUser) {
        await fetchAndUpdateCurrentUser();
      }

      // Navigate to seller dashboard
      setTimeout(() => {
        navigation.replace('SellerDashboard');
      }, 1500);

    } catch (error) {
      console.error('Error becoming seller:', error);
      Toast.show({
        type: 'error',
        text1: 'Error',
        text2: error.response?.data?.message || 'Failed to create seller account'
      });
    } finally {
      setLoading(false);
    }
  };

  if (!currentUser) {
    return (
      <View style={styles.authContainer}>
        <Ionicons name="lock-closed" size={64} color={colors.textSecondary} />
        <Text style={styles.authTitle}>Login Required</Text>
        <Text style={styles.authDescription}>
          Please login to become a seller
        </Text>
        <TouchableOpacity
          style={styles.loginButton}
          onPress={() => navigation.navigate('Login')}
        >
          <Text style={styles.loginButtonText}>Login</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const benefits = [
    { icon: 'trending-up', title: 'Grow Your Business', description: 'Reach millions of customers' },
    { icon: 'shield-checkmark', title: 'Secure Platform', description: 'Safe payments guaranteed' },
    { icon: 'bar-chart', title: 'Analytics & Insights', description: 'Track your performance' },
  ];

  const features = [
    'Full store management dashboard',
    'Product listing & inventory control',
    'Order management system',
    'Secure payment processing',
    'Real-time sales analytics',
    'Customer communication tools',
    'Marketing & promotion features',
    '24/7 seller support'
  ];

  return (
    <KeyboardAvoidingView 
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView showsVerticalScrollIndicator={false}>
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.headerIcon}>
            <Ionicons name="storefront" size={48} color={colors.white} />
          </View>
          <Text style={styles.headerTitle}>Become a Seller - FREE</Text>
          <Text style={styles.headerSubtitle}>
            Join thousands of successful sellers and start your e-commerce journey today
          </Text>
          <Text style={styles.freeText}>
            🎁 Create your store for FREE - No hidden costs!
          </Text>
        </View>

        <View style={styles.content}>
          {!showForm ? (
            <>
              {/* Benefits */}
              <View style={styles.benefitsGrid}>
                {benefits.map((benefit, index) => (
                  <View key={index} style={styles.benefitCard}>
                    <View style={[styles.benefitIcon, { backgroundColor: `${colors.primary}20` }]}>
                      <Ionicons name={benefit.icon} size={28} color={colors.primary} />
                    </View>
                    <Text style={styles.benefitTitle}>{benefit.title}</Text>
                    <Text style={styles.benefitDescription}>{benefit.description}</Text>
                  </View>
                ))}
              </View>

              {/* Features */}
              <View style={styles.featuresSection}>
                <View style={styles.featuresTitleRow}>
                  <Ionicons name="sparkles" size={24} color="#eab308" />
                  <Text style={styles.featuresTitle}>What You'll Get</Text>
                </View>
                <View style={styles.featuresList}>
                  {features.map((feature, index) => (
                    <View key={index} style={styles.featureItem}>
                      <Ionicons name="checkmark-circle" size={20} color={colors.success} />
                      <Text style={styles.featureText}>{feature}</Text>
                    </View>
                  ))}
                </View>
              </View>

              {/* CTA */}
              <View style={styles.ctaSection}>
                <Text style={styles.ctaTitle}>Ready to Start Selling?</Text>
                <Text style={styles.ctaSubtitle}>
                  Click the button below to provide your details and activate your seller account!
                </Text>
                <Text style={styles.ctaFree}>
                  ✨ 100% FREE - No setup fees, no monthly charges!
                </Text>
                <TouchableOpacity
                  style={styles.getStartedButton}
                  onPress={() => setShowForm(true)}
                >
                  <Ionicons name="storefront" size={24} color="#9333ea" />
                  <Text style={styles.getStartedText}>Get Started</Text>
                </TouchableOpacity>
              </View>
            </>
          ) : (
            /* Form */
            <View style={styles.formSection}>
              <Text style={styles.formTitle}>Seller Information</Text>
              <Text style={styles.formSubtitle}>
                Please provide your contact details to activate your seller account
              </Text>

              {/* Phone Number */}
              <View style={styles.inputGroup}>
                <View style={styles.labelRow}>
                  <Ionicons name="call" size={18} color={colors.primary} />
                  <Text style={styles.label}>Phone Number <Text style={styles.required}>*</Text></Text>
                </View>
                <TextInput
                  style={styles.input}
                  placeholder="+1 234 567 8900"
                  value={formData.phoneNumber}
                  onChangeText={(value) => handleInputChange('phoneNumber', value)}
                  keyboardType="phone-pad"
                />
              </View>

              {/* Business Name */}
              <View style={styles.inputGroup}>
                <View style={styles.labelRow}>
                  <Ionicons name="storefront" size={18} color={colors.primary} />
                  <Text style={styles.label}>Business Name (Optional)</Text>
                </View>
                <TextInput
                  style={styles.input}
                  placeholder="Your business or brand name"
                  value={formData.businessName}
                  onChangeText={(value) => handleInputChange('businessName', value)}
                  maxLength={100}
                />
              </View>

              {/* Address */}
              <View style={styles.inputGroup}>
                <View style={styles.labelRow}>
                  <Ionicons name="location" size={18} color={colors.primary} />
                  <Text style={styles.label}>Address <Text style={styles.required}>*</Text></Text>
                </View>
                <TextInput
                  style={styles.input}
                  placeholder="Street address"
                  value={formData.address}
                  onChangeText={(value) => handleInputChange('address', value)}
                />
              </View>

              {/* City & Country */}
              <View style={styles.rowInputs}>
                <View style={[styles.inputGroup, { flex: 1 }]}>
                  <Text style={styles.label}>City <Text style={styles.required}>*</Text></Text>
                  <TextInput
                    style={styles.input}
                    placeholder="Your city"
                    value={formData.city}
                    onChangeText={(value) => handleInputChange('city', value)}
                  />
                </View>
                <View style={[styles.inputGroup, { flex: 1 }]}>
                  <Text style={styles.label}>Country <Text style={styles.required}>*</Text></Text>
                  <TextInput
                    style={styles.input}
                    placeholder="Your country"
                    value={formData.country}
                    onChangeText={(value) => handleInputChange('country', value)}
                  />
                </View>
              </View>

              {/* Buttons */}
              <View style={styles.buttonRow}>
                <TouchableOpacity
                  style={styles.backButton}
                  onPress={() => setShowForm(false)}
                >
                  <Text style={styles.backButtonText}>Back</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.submitButton, loading && styles.disabledButton]}
                  onPress={handleBecomeSeller}
                  disabled={loading}
                >
                  {loading ? (
                    <ActivityIndicator size="small" color={colors.white} />
                  ) : (
                    <>
                      <Ionicons name="storefront" size={20} color={colors.white} />
                      <Text style={styles.submitButtonText}>Activate Account</Text>
                    </>
                  )}
                </TouchableOpacity>
              </View>
            </View>
          )}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  authContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.xl,
    backgroundColor: colors.background,
  },
  authTitle: {
    fontSize: fontSize.xl,
    fontWeight: 'bold',
    color: colors.text,
    marginTop: spacing.lg,
  },
  authDescription: {
    fontSize: fontSize.md,
    color: colors.textSecondary,
    textAlign: 'center',
    marginTop: spacing.sm,
    marginBottom: spacing.xl,
  },
  loginButton: {
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: borderRadius.md,
  },
  loginButtonText: {
    color: colors.white,
    fontSize: fontSize.md,
    fontWeight: '600',
  },
  header: {
    backgroundColor: '#9333ea',
    padding: spacing.xl,
    alignItems: 'center',
  },
  headerIcon: {
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    padding: spacing.md,
    borderRadius: borderRadius.full,
    marginBottom: spacing.md,
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    color: colors.white,
    textAlign: 'center',
  },
  headerSubtitle: {
    fontSize: fontSize.md,
    color: 'rgba(255, 255, 255, 0.9)',
    textAlign: 'center',
    marginTop: spacing.sm,
  },
  freeText: {
    fontSize: fontSize.lg,
    fontWeight: 'bold',
    color: '#fbbf24',
    marginTop: spacing.md,
  },
  content: {
    padding: spacing.md,
  },
  benefitsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    marginBottom: spacing.xl,
  },
  benefitCard: {
    flex: 1,
    minWidth: '30%',
    backgroundColor: colors.white,
    borderRadius: borderRadius.lg,
    padding: spacing.md,
    alignItems: 'center',
    ...shadows.sm,
  },
  benefitIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  benefitTitle: {
    fontSize: fontSize.md,
    fontWeight: 'bold',
    color: colors.text,
    textAlign: 'center',
  },
  benefitDescription: {
    fontSize: fontSize.xs,
    color: colors.textSecondary,
    textAlign: 'center',
    marginTop: spacing.xs,
  },
  featuresSection: {
    backgroundColor: colors.white,
    borderRadius: borderRadius.lg,
    padding: spacing.lg,
    marginBottom: spacing.xl,
    ...shadows.sm,
  },
  featuresTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  featuresTitle: {
    fontSize: fontSize.xl,
    fontWeight: 'bold',
    color: colors.text,
  },
  featuresList: {
    gap: spacing.sm,
  },
  featureItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  featureText: {
    fontSize: fontSize.md,
    color: colors.text,
  },
  ctaSection: {
    backgroundColor: '#9333ea',
    borderRadius: borderRadius.lg,
    padding: spacing.xl,
    alignItems: 'center',
    ...shadows.md,
  },
  ctaTitle: {
    fontSize: fontSize.xl,
    fontWeight: 'bold',
    color: colors.white,
  },
  ctaSubtitle: {
    fontSize: fontSize.md,
    color: 'rgba(255, 255, 255, 0.9)',
    textAlign: 'center',
    marginTop: spacing.sm,
  },
  ctaFree: {
    fontSize: fontSize.lg,
    fontWeight: 'bold',
    color: '#fbbf24',
    marginTop: spacing.md,
    marginBottom: spacing.lg,
  },
  getStartedButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.white,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: borderRadius.full,
    gap: spacing.sm,
  },
  getStartedText: {
    fontSize: fontSize.lg,
    fontWeight: 'bold',
    color: '#9333ea',
  },
  formSection: {
    backgroundColor: colors.white,
    borderRadius: borderRadius.lg,
    padding: spacing.lg,
    ...shadows.sm,
  },
  formTitle: {
    fontSize: fontSize.xl,
    fontWeight: 'bold',
    color: '#9333ea',
    textAlign: 'center',
  },
  formSubtitle: {
    fontSize: fontSize.md,
    color: colors.textSecondary,
    textAlign: 'center',
    marginTop: spacing.xs,
    marginBottom: spacing.xl,
  },
  inputGroup: {
    marginBottom: spacing.md,
  },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginBottom: spacing.xs,
  },
  label: {
    fontSize: fontSize.md,
    fontWeight: '600',
    color: colors.text,
  },
  required: {
    color: colors.error,
  },
  input: {
    backgroundColor: colors.light,
    borderRadius: borderRadius.md,
    padding: spacing.md,
    fontSize: fontSize.md,
    color: colors.text,
    borderWidth: 1,
    borderColor: colors.light,
  },
  rowInputs: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: spacing.md,
    marginTop: spacing.lg,
  },
  backButton: {
    flex: 1,
    backgroundColor: colors.light,
    paddingVertical: spacing.md,
    borderRadius: borderRadius.md,
    alignItems: 'center',
  },
  backButtonText: {
    fontSize: fontSize.md,
    fontWeight: '600',
    color: colors.text,
  },
  submitButton: {
    flex: 2,
    flexDirection: 'row',
    backgroundColor: '#9333ea',
    paddingVertical: spacing.md,
    borderRadius: borderRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  disabledButton: {
    opacity: 0.6,
  },
  submitButtonText: {
    fontSize: fontSize.md,
    fontWeight: 'bold',
    color: colors.white,
  },
});
