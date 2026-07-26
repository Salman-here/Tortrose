/**
 * useNotifications hook
 * Manages push notification lifecycle: registration, listeners, navigation on tap.
 */

import { useEffect, useRef } from 'react';
import { useNavigation } from '@react-navigation/native';
import { useAuth } from '../contexts/AuthContext';
import { getNotificationsModule } from '../utils/notificationRuntime';
import {
  registerForPushNotifications,
  savePushTokenToServer,
  NotificationTypes,
} from '../services/notifications';

const Notifications = getNotificationsModule();

export default function useNotifications() {
  const { currentUser } = useAuth();
  const navigation = useNavigation();
  const notificationListener = useRef();
  const responseListener = useRef();

  useEffect(() => {
    if (!Notifications) return undefined;

    // Register for push notifications
    registerForPushNotifications().then((token) => {
      if (token && currentUser) {
        savePushTokenToServer(token);
      }
    });

    // Listen for notifications received while app is foregrounded
    notificationListener.current = Notifications.addNotificationReceivedListener((notification) => {
      // Notification received in foreground — handler already shows it via setNotificationHandler
    });

    // Listen for user tapping on a notification
    responseListener.current = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data;
      handleNotificationTap(data);
    });

    return () => {
      if (notificationListener.current) {
        notificationListener.current.remove();
      }
      if (responseListener.current) {
        responseListener.current.remove();
      }
    };
  }, [currentUser]);

  const handleNotificationTap = (data) => {
    if (!data?.type) return;

    switch (data.type) {
      case NotificationTypes.ORDER_PLACED:
      case NotificationTypes.ORDER_CONFIRMED:
      case NotificationTypes.ORDER_SHIPPED:
      case NotificationTypes.ORDER_DELIVERED:
      case NotificationTypes.ORDER_CANCELLED:
        if (data.orderId) {
          navigation.navigate('OrderDetail', { orderId: data.orderId });
        } else {
          navigation.navigate('Orders');
        }
        break;

      case NotificationTypes.NEW_ORDER_RECEIVED:
        if (data.orderObjectId) {
          navigation.navigate('OrderDetailManagement', { orderId: data.orderObjectId, isAdmin: false });
        } else {
          navigation.navigate('SellerOrderManagement');
        }
        break;

      case NotificationTypes.ORDER_CONFIRMED_BY_BUYER:
        // Deep-link seller/admin straight to the order detail management screen
        if (data.orderObjectId) {
          navigation.navigate('OrderDetailManagement', { orderId: data.orderObjectId, isAdmin: false });
        } else {
          navigation.navigate('SellerOrderManagement');
        }
        break;

      case NotificationTypes.LOW_STOCK:
        navigation.navigate('SellerProductManagement');
        break;

      case NotificationTypes.STORE_VERIFIED:
        navigation.navigate('SellerStoreSettings');
        break;

      case NotificationTypes.PRICE_DROP:
      case NotificationTypes.BACK_IN_STOCK:
      case NotificationTypes.WISHLIST_SALE:
        if (data.productId) {
          navigation.navigate('ProductDetail', { productId: data.productId });
        } else {
          navigation.navigate('MainTabs', { screen: 'Wishlist' });
        }
        break;

      case NotificationTypes.CART_REMINDER:
        navigation.navigate('MainTabs', { screen: 'Cart' });
        break;

      case NotificationTypes.COUPON_AVAILABLE:
        navigation.navigate('MainTabs', { screen: 'Home' });
        break;

      default:
        navigation.navigate('Notifications');
        break;
    }
  };
}
