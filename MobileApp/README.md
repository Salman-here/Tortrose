# Mobile App - React Native

This is the React Native mobile app version of your MERN e-commerce platform.

## 🚀 Quick Start

### Prerequisites
- Node.js (v14 or higher)
- npm or yarn
- Expo CLI: `npm install -g expo-cli`
- For Android: Android Studio with Android SDK
- For iOS: Xcode (Mac only)

### Installation

1. Navigate to the MobileApp directory:
```bash
cd MobileApp
```

2. Install dependencies:
```bash
npm install
```

3. Configure API URL:
   - Open `src/config/api.js`
   - Update `API_BASE_URL` with your backend URL:
     - For Android Emulator: `http://10.0.2.2:5000`
     - For Physical Device: `http://YOUR_LOCAL_IP:5000`
     - For Production: Your deployed backend URL

4. Start the development server:
```bash
npm start
```

5. Run on device/emulator:
   - Press `a` for Android
   - Press `i` for iOS (Mac only)
   - Scan QR code with Expo Go app on your phone

## 📱 Features Implemented

### ✅ Core Features
- User Authentication (Login, Signup, Forgot Password)
- Product Browsing with Search
- Product Details
- Shopping Cart
- Wishlist
- Store Listings
- Store Details
- User Profile
- Currency Conversion
- Toast Notifications

### 🔄 Reused from Web App
- All API calls and business logic
- Context providers (Auth, Global, Currency)
- Backend integration (100% compatible)

### 📋 To Be Implemented
- Checkout Flow
- Order Management
- Payment Integration
- Admin/Seller Dashboards
- Push Notifications
- Image Upload

## 📂 Project Structure

```
MobileApp/
├── App.js                      # Entry point
├── app.json                    # Expo configuration
├── package.json
├── src/
│   ├── navigation/
│   │   └── AppNavigator.js     # Navigation setup
│   ├── screens/
│   │   ├── auth/               # Auth screens
│   │   ├── HomeScreen.js
│   │   ├── ProductDetailScreen.js
│   │   ├── CartScreen.js
│   │   ├── WishlistScreen.js
│   │   ├── ProfileScreen.js
│   │   └── ...
│   ├── components/
│   │   └── ProductCard.js
│   ├── contexts/               # Reused contexts
│   │   ├── AuthContext.js
│   │   ├── GlobalContext.js
│   │   └── CurrencyContext.js
│   ├── config/
│   │   └── api.js              # API configuration
│   └── styles/
│       └── theme.js            # Shared styles
```

## 🔧 Configuration

### Backend Connection
Edit `src/config/api.js`:
```javascript
export const API_BASE_URL = 'http://YOUR_BACKEND_URL:5000';
```

### App Metadata
Edit `app.json` to customize:
- App name
- Bundle identifier
- Icons and splash screen
- Permissions

## 📦 Builds and over-the-air updates

Create an internally installable Android APK on the `preview` update channel:

```bash
npm run build:preview
```

After that OTA-enabled APK has been installed once, publish compatible
JavaScript and asset changes to testers with:

```bash
npm run update:preview -- --message "Describe the tested change"
```

Publish a tested update to store builds with:

```bash
npm run update:production -- --message "Describe the production change"
```

The `preview` and `production` channels are isolated. Updates use the matching
EAS environment and the app-version runtime policy. Increment `expo.version`
and create a new binary whenever native dependencies, permissions, config
plugins, or the Expo SDK change. With the zero-second launch timeout, a device
downloads an update without delaying startup and applies it on the next full
restart.

## 🎨 Customization

### Theme Colors
Edit `src/styles/theme.js` to change colors, spacing, fonts, etc.

### Navigation
Edit `src/navigation/AppNavigator.js` to add/modify screens.

## 🐛 Troubleshooting

### Can't connect to backend
- Make sure backend is running
- Check API_BASE_URL in `src/config/api.js`
- For Android emulator, use `10.0.2.2` instead of `localhost`
- For physical device, use your computer's local IP

### Dependencies issues
```bash
rm -rf node_modules
npm install
```

### Clear Expo cache
```bash
expo start -c
```

## 📱 Play Store Deployment

1. Build production APK/AAB:
```bash
eas build --platform android --profile production
```

2. Create Google Play Console account

3. Upload AAB file

4. Fill in store listing details

5. Submit for review

## 🔐 Environment Variables

For sensitive data, use `expo-constants`:
```bash
npm install expo-constants
```

Create `app.config.js` instead of `app.json` for dynamic config.

## 📝 Notes

- This app uses Expo for easier development and deployment
- All backend APIs are reused from the web app
- AsyncStorage is used instead of localStorage
- React Navigation for routing
- Toast messages for notifications

## 🤝 Contributing

When adding new features:
1. Keep components minimal and reusable
2. Follow the existing file structure
3. Use the theme system for styling
4. Test on both Android and iOS if possible
