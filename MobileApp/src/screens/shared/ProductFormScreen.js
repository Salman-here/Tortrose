/**
 * ProductFormScreen
 * Create and edit products for sellers
 * 
 * Requirements: 19.1, 19.2, 19.3, 19.4, 19.5, 19.6, 19.7
 */

import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Alert,
  SafeAreaView,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import api from '../../config/api';
import Loader from '../../components/common/Loader';
import {
  colors,
  spacing,
  fontSize,
  borderRadius,
  shadows,
  fontWeight,
  typography,
  buttonStyles,
} from '../../styles/theme';

/**
 * Determine form mode (create vs edit)
 * Exported for property testing
 */
export const getFormMode = (product) => {
  return product && product._id ? 'edit' : 'create';
};

/**
 * Validate product form data
 * Exported for property testing
 */
export const validateProductForm = (data) => {
  const errors = {};
  
  if (!data.name || !data.name.trim()) {
    errors.name = 'Product name is required';
  } else if (data.name.length < 3) {
    errors.name = 'Product name must be at least 3 characters';
  }
  
  if (!data.price || isNaN(parseFloat(data.price)) || parseFloat(data.price) <= 0) {
    errors.price = 'Valid price is required';
  }
  
  if (!data.stock || isNaN(parseInt(data.stock)) || parseInt(data.stock) < 0) {
    errors.stock = 'Valid stock quantity is required';
  }
  
  return {
    isValid: Object.keys(errors).length === 0,
    errors,
  };
};

export default function ProductFormScreen({ navigation, route }) {
  const { product, isAdmin } = route.params || {};
  const isEditMode = getFormMode(product) === 'edit';
  
  const [formData, setFormData] = useState({
    name: product?.name || '',
    description: product?.description || '',
    price: product?.price?.toString() || '',
    discountedPrice: product?.discountedPrice?.toString() || '',
    stock: product?.stock?.toString() || '',
    category: product?.category || '',
    brand: product?.brand || '',
  });
  const [images, setImages] = useState(product?.images || []);
  const [errors, setErrors] = useState({});
  const [loading, setLoading] = useState(false);
  const [touched, setTouched] = useState({});

  const updateField = useCallback((field, value) => {
    setFormData(prev => ({ ...prev, [field]: value }));
    // Clear error when user starts typing
    if (errors[field]) {
      setErrors(prev => ({ ...prev, [field]: null }));
    }
  }, [errors]);

  const handleBlur = useCallback((field) => {
    setTouched(prev => ({ ...prev, [field]: true }));
  }, []);

  const pickImage = useCallback(async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsMultipleSelection: true,
        quality: 0.8,
        aspect: [1, 1],
      });

      if (!result.canceled && result.assets) {
        const newImages = result.assets.map(asset => asset.uri);
        setImages(prev => [...prev, ...newImages].slice(0, 5)); // Max 5 images
      }
    } catch (error) {
      Alert.alert('Error', 'Failed to pick image');
    }
  }, []);

  const removeImage = useCallback((index) => {
    setImages(prev => prev.filter((_, i) => i !== index));
  }, []);

  const saveProduct = async () => {
    // Validate form
    const validation = validateProductForm(formData);
    if (!validation.isValid) {
      setErrors(validation.errors);
      setTouched({ name: true, price: true, stock: true });
      Alert.alert('Validation Error', 'Please fix the errors in the form');
      return;
    }

    setLoading(true);
    try {
      const productData = {
        name: formData.name.trim(),
        description: formData.description.trim(),
        price: parseFloat(formData.price),
        discountedPrice: formData.discountedPrice ? parseFloat(formData.discountedPrice) : null,
        stock: parseInt(formData.stock),
        category: formData.category.trim(),
        brand: formData.brand.trim(),
        images,
      };

      if (isEditMode) {
        await api.put(`/api/products/edit/${product._id}`, productData);
        Alert.alert('Success', 'Product updated successfully', [
          { text: 'OK', onPress: () => navigation.goBack() }
        ]);
      } else {
        await api.post('/api/products/add', productData);
        Alert.alert('Success', 'Product created successfully', [
          { text: 'OK', onPress: () => navigation.goBack() }
        ]);
      }
    } catch (error) {
      Alert.alert('Error', error.response?.data?.message || 'Failed to save product');
    } finally {
      setLoading(false);
    }
  };

  const renderInput = (field, label, options = {}) => {
    const {
      placeholder,
      keyboardType = 'default',
      multiline = false,
      required = false,
      prefix,
    } = options;
    
    const hasError = touched[field] && errors[field];
    
    return (
      <View style={styles.inputGroup}>
        <Text style={styles.label}>
          {label} {required && <Text style={styles.required}>*</Text>}
        </Text>
        <View style={[
          styles.inputContainer,
          multiline && styles.textAreaContainer,
          hasError && styles.inputError,
        ]}>
          {prefix && <Text style={styles.inputPrefix}>{prefix}</Text>}
          <TextInput
            style={[
              styles.input,
              multiline && styles.textArea,
              prefix && styles.inputWithPrefix,
            ]}
            value={formData[field]}
            onChangeText={(value) => updateField(field, value)}
            onBlur={() => handleBlur(field)}
            placeholder={placeholder}
            placeholderTextColor={colors.grayLight}
            keyboardType={keyboardType}
            multiline={multiline}
            numberOfLines={multiline ? 4 : 1}
            textAlignVertical={multiline ? 'top' : 'center'}
          />
        </View>
        {hasError && (
          <Text style={styles.errorText}>{errors[field]}</Text>
        )}
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.keyboardView}
      >
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.scrollContent}
        >
          {/* Header */}
          <View style={styles.header}>
            <View style={styles.headerIcon}>
              <Ionicons
                name={isEditMode ? 'create-outline' : 'add-circle-outline'}
                size={28}
                color={colors.primary}
              />
            </View>
            <Text style={styles.headerTitle}>
              {isEditMode ? 'Edit Product' : 'Add New Product'}
            </Text>
            <Text style={styles.headerSubtitle}>
              {isEditMode ? 'Update your product details' : 'Fill in the details to add a new product'}
            </Text>
          </View>

          {/* Images Section */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Product Images</Text>
            <Text style={styles.sectionSubtitle}>Add up to 5 images</Text>
            
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={styles.imagesScroll}
              contentContainerStyle={styles.imagesContainer}
            >
              {images.map((uri, index) => (
                <View key={index} style={styles.imageWrapper}>
                  <Image source={{ uri }} style={styles.imagePreview} contentFit="cover" cachePolicy="memory-disk" transition={150} />
                  <TouchableOpacity
                    style={styles.removeImageButton}
                    onPress={() => removeImage(index)}
                  >
                    <Ionicons name="close" size={16} color={colors.white} />
                  </TouchableOpacity>
                </View>
              ))}
              
              {images.length < 5 && (
                <TouchableOpacity
                  style={styles.addImageButton}
                  onPress={pickImage}
                  activeOpacity={0.7}
                >
                  <Ionicons name="camera-outline" size={28} color={colors.primary} />
                  <Text style={styles.addImageText}>Add Photo</Text>
                </TouchableOpacity>
              )}
            </ScrollView>
          </View>

          {/* Form Section */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Product Details</Text>
            
            {renderInput('name', 'Product Name', {
              placeholder: 'Enter product name',
              required: true,
            })}
            
            {renderInput('description', 'Description', {
              placeholder: 'Describe your product...',
              multiline: true,
            })}
            
            <View style={styles.row}>
              <View style={styles.halfInput}>
                {renderInput('price', 'Price', {
                  placeholder: '0.00',
                  keyboardType: 'decimal-pad',
                  required: true,
                  prefix: '$',
                })}
              </View>
              <View style={styles.halfInput}>
                {renderInput('discountedPrice', 'Sale Price', {
                  placeholder: '0.00',
                  keyboardType: 'decimal-pad',
                  prefix: '$',
                })}
              </View>
            </View>
            
            {renderInput('stock', 'Stock Quantity', {
              placeholder: '0',
              keyboardType: 'number-pad',
              required: true,
            })}
            
            <View style={styles.row}>
              <View style={styles.halfInput}>
                {renderInput('category', 'Category', {
                  placeholder: 'e.g., Electronics',
                })}
              </View>
              <View style={styles.halfInput}>
                {renderInput('brand', 'Brand', {
                  placeholder: 'e.g., Apple',
                })}
              </View>
            </View>
          </View>

          {/* Submit Button */}
          <View style={styles.submitContainer}>
            <TouchableOpacity
              style={[styles.submitButton, loading && styles.submitButtonDisabled]}
              onPress={saveProduct}
              disabled={loading}
              activeOpacity={0.8}
            >
              {loading ? (
                <Loader size="small" color={colors.white} />
              ) : (
                <>
                  <Ionicons
                    name={isEditMode ? 'checkmark-circle' : 'add-circle'}
                    size={22}
                    color={colors.white}
                  />
                  <Text style={styles.submitButtonText}>
                    {isEditMode ? 'Update Product' : 'Create Product'}
                  </Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  keyboardView: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: spacing.xxl,
  },
  // Header
  header: {
    backgroundColor: colors.white,
    padding: spacing.xl,
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: colors.light,
  },
  headerIcon: {
    width: 60,
    height: 60,
    borderRadius: borderRadius.full,
    backgroundColor: colors.primaryLighter,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  headerTitle: {
    ...typography.h2,
    marginBottom: spacing.xs,
  },
  headerSubtitle: {
    ...typography.body,
    color: colors.textSecondary,
    textAlign: 'center',
  },
  // Sections
  section: {
    backgroundColor: colors.white,
    marginTop: spacing.md,
    padding: spacing.lg,
  },
  sectionTitle: {
    ...typography.h4,
    marginBottom: spacing.xs,
  },
  sectionSubtitle: {
    ...typography.bodySmall,
    color: colors.textSecondary,
    marginBottom: spacing.md,
  },
  // Images
  imagesScroll: {
    marginHorizontal: -spacing.lg,
  },
  imagesContainer: {
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
  },
  imageWrapper: {
    position: 'relative',
  },
  imagePreview: {
    width: 100,
    height: 100,
    borderRadius: borderRadius.lg,
    backgroundColor: colors.lighter,
  },
  removeImageButton: {
    position: 'absolute',
    top: -8,
    right: -8,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.error,
    justifyContent: 'center',
    alignItems: 'center',
  },
  addImageButton: {
    width: 100,
    height: 100,
    borderRadius: borderRadius.lg,
    borderWidth: 2,
    borderColor: colors.primary,
    borderStyle: 'dashed',
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: colors.primaryLighter,
  },
  addImageText: {
    ...typography.caption,
    color: colors.primary,
    marginTop: spacing.xs,
  },
  // Form
  inputGroup: {
    marginBottom: spacing.lg,
  },
  label: {
    ...typography.bodySemibold,
    marginBottom: spacing.sm,
  },
  required: {
    color: colors.error,
  },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.lighter,
    borderRadius: borderRadius.lg,
    borderWidth: 2,
    borderColor: colors.lighter,
  },
  textAreaContainer: {
    alignItems: 'flex-start',
  },
  inputError: {
    borderColor: colors.error,
  },
  inputPrefix: {
    ...typography.body,
    color: colors.textSecondary,
    paddingLeft: spacing.md,
  },
  input: {
    flex: 1,
    padding: spacing.md,
    fontSize: fontSize.md,
    color: colors.text,
  },
  inputWithPrefix: {
    paddingLeft: spacing.xs,
  },
  textArea: {
    height: 100,
    textAlignVertical: 'top',
  },
  errorText: {
    ...typography.caption,
    color: colors.error,
    marginTop: spacing.xs,
  },
  row: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  halfInput: {
    flex: 1,
  },
  // Submit
  submitContainer: {
    padding: spacing.lg,
  },
  submitButton: {
    ...buttonStyles.primary,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: spacing.sm,
  },
  submitButtonDisabled: {
    opacity: 0.7,
  },
  submitButtonText: {
    ...buttonStyles.primaryText,
  },
});
