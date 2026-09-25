import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../contexts/ThemeContext';
import { useAuth } from '../contexts/AuthContext';
import { registerSafepayPresenter, safepayNavigationAction } from '../utils/safepaySheet';

export default function SafepayCheckoutProvider({ children }) {
  const { palette } = useTheme();
  const { currentUser } = useAuth();
  const owner = String(currentUser?._id || currentUser?.id || '');
  const active = useRef(null);
  const [checkout, setCheckout] = useState(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const finish = useCallback((type = 'dismiss') => {
    const request = active.current;
    active.current = null; setCheckout(null); request?.resolve({ type });
  }, []);
  useEffect(() => {
    const unregister = registerSafepayPresenter(payment => {
      if (!owner) return Promise.reject(new Error('Sign in before opening checkout.'));
      if (active.current) {
        if (active.current.paymentId === payment.paymentId) return active.current.promise;
        return Promise.reject(new Error('Finish the open checkout before starting another payment.'));
      }
      let resolve;
      const promise = new Promise(done => { resolve = done; });
      active.current = { paymentId: payment.paymentId, owner, resolve, promise };
      setFailed(false); setLoading(true); setCheckout(payment);
      return promise;
    });
    return () => { unregister(); const request = active.current; active.current = null; request?.resolve({ type: 'dismiss' }); };
  }, [owner]);
  useEffect(() => { if (!active.current || active.current.owner !== owner) setCheckout(null); }, [owner]);
  const allowNavigation = request => {
    const action = safepayNavigationAction(request.url, checkout?.environment);
    if (action === 'complete') { finish('return'); return false; }
    if (action === 'block') { setFailed(true); return false; }
    return true;
  };
  return <>{children}<Modal visible={!!checkout} animationType="slide" presentationStyle="fullScreen" onRequestClose={() => finish('dismiss')}>
    <SafeAreaView style={[styles.container, { backgroundColor: palette.colors.background }]}>
      <View style={[styles.header, { borderBottomColor: palette.colors.border || '#d1d5db' }]}>
        <View style={styles.heading}><Ionicons name="lock-closed-outline" size={21} color={palette.colors.primary} />
          <View><Text style={[styles.title, { color: palette.colors.text }]}>Secure payment</Text>
            <Text style={{ color: palette.colors.textSecondary }}>{checkout?.environment === 'sandbox' ? 'Safepay sandbox · Test payment' : 'Powered by Safepay'}</Text></View>
        </View>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Close payment screen" onPress={() => finish('dismiss')} style={styles.close}>
          <Ionicons name="close" size={27} color={palette.colors.text} />
        </TouchableOpacity>
      </View>
      <Text style={[styles.notice, { color: palette.colors.textSecondary }]}>Closing this screen does not confirm cancellation. Rozare will check your payment status.</Text>
      {!!checkout && !failed && <View style={styles.container}>
        {/* Our navigation policy handles every scheme; unapproved links must not be handed to the OS. */}
        <WebView key={checkout.paymentId} source={{ uri: checkout.checkoutUrl }} testID="safepay-webview"
          originWhitelist={['*']}
          onShouldStartLoadWithRequest={allowNavigation}
          onNavigationStateChange={state => { if (safepayNavigationAction(state.url, checkout.environment) === 'complete') finish('return'); }}
          onLoadStart={() => setLoading(true)} onLoadEnd={() => setLoading(false)}
          onError={() => { setLoading(false); setFailed(true); }}
          onHttpError={event => { if (event.nativeEvent.statusCode >= 400 && event.nativeEvent.url === checkout.checkoutUrl) setFailed(true); }}
          onContentProcessDidTerminate={() => { setLoading(false); setFailed(true); }}
          onRenderProcessGone={() => { setLoading(false); setFailed(true); }}
          javaScriptEnabled domStorageEnabled sharedCookiesEnabled={false} thirdPartyCookiesEnabled
          incognito cacheEnabled={false} mixedContentMode="never" allowFileAccess={false}
          allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false}
          javaScriptCanOpenWindowsAutomatically={false} setSupportMultipleWindows={false}
          webviewDebuggingEnabled={false} allowsBackForwardNavigationGestures={false}
        />
        {loading && <View pointerEvents="none" style={styles.loading}><ActivityIndicator color={palette.colors.primary} /></View>}
      </View>}
      {failed && <View style={styles.error}>
        <Ionicons name="alert-circle-outline" size={40} color={palette.colors.textSecondary} />
        <Text style={[styles.title, { color: palette.colors.text }]}>Payment screen interrupted</Text>
        <Text style={[styles.message, { color: palette.colors.textSecondary }]}>Return to Rozare to check this payment. We will keep the same payment attempt so you are not asked to pay twice.</Text>
        <TouchableOpacity accessibilityRole="button" onPress={() => finish('dismiss')} style={[styles.button, { backgroundColor: palette.colors.primary }]}>
          <Text style={styles.buttonText}>Check payment status</Text>
        </TouchableOpacity>
      </View>}
    </SafeAreaView>
  </Modal></>;
}
const styles = StyleSheet.create({ container: { flex: 1 }, header: { padding: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: StyleSheet.hairlineWidth },
  heading: { flexDirection: 'row', alignItems: 'center', gap: 10 }, title: { fontSize: 17, fontWeight: '700' }, close: { padding: 8 },
  notice: { fontSize: 12, lineHeight: 17, paddingHorizontal: 16, paddingVertical: 10 }, loading: { position: 'absolute', top: 16, alignSelf: 'center' },
  error: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28, gap: 16 }, message: { textAlign: 'center', lineHeight: 22 },
  button: { padding: 16, borderRadius: 12 }, buttonText: { color: '#fff', fontWeight: '600' } });
