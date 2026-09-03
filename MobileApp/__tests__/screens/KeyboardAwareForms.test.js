const fs = require('fs');
const path = require('path');

const screenFiles = [
  'src/screens/CheckoutScreen.js',
  'src/screens/BecomeSellerScreen.js',
  // Home's filter sheet intentionally uses a native ScrollView. Its search
  // field is already at the top, while the keyboard wrapper can collapse a
  // height-bounded Android Modal body.
  'src/screens/auth/LoginScreen.js',
  'src/screens/auth/SignUpScreen.js',
  'src/screens/auth/SellerSignUpScreen.js',
  'src/screens/auth/OTPVerificationScreen.js',
  'src/screens/auth/ForgotPasswordScreen.js',
  'src/screens/auth/ResetPasswordScreen.js',
  'src/screens/ProfileScreen.js',
  'src/screens/SavedAddressesScreen.js',
  'src/screens/ContactScreen.js',
  'src/screens/ChangePasswordScreen.js',
  'src/screens/EditProfileScreen.js',
  'src/screens/ProductDetailScreen.js',
  'src/screens/WalletScreen.js',
  'src/screens/TrackOrderScreen.js',
  'src/screens/UserWhatsAppSettingsScreen.js',
  'src/screens/seller/SellerProfileScreen.js',
  'src/screens/seller/SellerStoreSettingsScreen.js',
  'src/screens/seller/SellerWhatsAppSettingsScreen.js',
  'src/screens/seller/SellerCouponManagementScreen.js',
  'src/screens/seller/SellerPaymentsScreen.js',
  'src/screens/seller/SellerShippingConfigurationScreen.js',
  'src/screens/seller/SellerSubdomainManagementScreen.js',
  'src/screens/seller/SellerAdsScreen.js',
  'src/screens/seller/SellerSubscriptionScreen.js',
  'src/screens/shared/ProductFormScreen.js',
  'src/screens/shared/ProductManagementScreen.js',
  'src/components/BuyerReturnsSection.js',
  'src/components/SellerReturnsPanel.js',
  'src/components/common/StoreReviews.js',
];

describe('keyboard-aware form screens', () => {
  test.each(screenFiles)('%s tracks and scrolls to the focused input', (relativeFile) => {
    const source = fs.readFileSync(path.join(__dirname, '../..', relativeFile), 'utf8');
    expect(source).toContain('KeyboardAwareFormScrollView');
    expect(source).not.toContain('<KeyboardAvoidingView');
  });
});
