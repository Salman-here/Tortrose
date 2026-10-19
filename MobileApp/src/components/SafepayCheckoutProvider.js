import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Modal from './common/AppModal';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import * as WebBrowser from 'expo-web-browser';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../contexts/ThemeContext';
import { useAuth } from '../contexts/AuthContext';
import { registerSafepayPresenter, safepayNavigationAction } from '../utils/safepaySheet';
import { cancelSafepayBrowser, presentSafepayBrowser, validateSafepayBrowserPayment } from '../utils/safepayBrowser';

export default function SafepayCheckoutProvider({ children }) {
  const { palette } = useTheme();
  const { currentUser } = useAuth();
  const owner = String(currentUser?._id || currentUser?.id || '');
  const active = useRef(null);
  const [checkout, setCheckout] = useState(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [failureCode, setFailureCode] = useState('');
  const [blockedLink, setBlockedLink] = useState(false);
  const interrupt = useCallback(code => {
    // Provider links contain authentication tokens. Log only a fixed category
    // and numeric native error code, never a URL or provider error description.
    const safeCode = /^[a-z_-]+(?::-?\d+)?$/.test(code) ? code : 'load_error';
    console.warn(`[SafepaySheet] ${safeCode}`);
    setFailureCode(safeCode); setLoading(false); setFailed(true);
  }, []);
  const finish = useCallback((type = 'dismiss') => {
    const request = active.current;
    if (type !== 'return') cancelSafepayBrowser(request?.paymentId);
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
      const request = { paymentId: payment.paymentId, owner, resolve, promise, payment: { ...payment }, openingBrowser: false };
      active.current = request;
      // The server's browser presentation describes an eligible hosted URL,
      // not permission to leave the app. Keep standard checkout in Rozare.
      setFailed(false); setFailureCode(''); setBlockedLink(false); setLoading(true); setCheckout(payment);
      if (payment.checkoutPresentation === 'browser') {
        try { validateSafepayBrowserPayment(payment); }
        catch (_) { interrupt('browser_invalid'); }
      }
      return promise;
    });
    return () => { unregister(); const request = active.current; active.current = null; cancelSafepayBrowser(request?.paymentId); request?.resolve({ type: 'dismiss' }); };
  }, [owner, finish, interrupt]);
  useEffect(() => { if (!active.current || active.current.owner !== owner) setCheckout(null); }, [owner]);
  const openBrowserFallback = () => {
    const request = active.current;
    if (!request || request.owner !== owner || request.openingBrowser || request.payment.checkoutPresentation !== 'browser') return;
    try { validateSafepayBrowserPayment(request.payment); }
    catch (_) { interrupt('browser_invalid'); return; }
    request.openingBrowser = true;
    // Unmount the embedded form during the explicit handoff. The two
    // presentations must never offer parallel payment forms for one attempt.
    setCheckout({ ...request.payment, browserHandoff: true });
    presentSafepayBrowser(request.payment, WebBrowser.openAuthSessionAsync).then(result => {
      if (active.current === request) finish(result.type);
    }).catch(error => {
      if (active.current !== request) return;
      request.openingBrowser = false;
      if (error?.code === 'SAFEPAY_BROWSER_INVALID') { interrupt('browser_invalid'); return; }
      setLoading(true); setBlockedLink(false);
      setCheckout({ ...request.payment, browserUnavailable: true });
    });
  };
  const allowNavigation = request => {
    const action = safepayNavigationAction(request.url, checkout?.environment);
    if (action === 'complete') { finish('return'); return false; }
    if (action === 'block') {
      // Blocking an unsupported link must not destroy the still-valid card
      // form or its in-progress 3DS state (providers may probe app-only links).
      console.warn('[SafepaySheet] unsupported_navigation_blocked');
      setBlockedLink(true); return false;
    }
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
      {checkout?.browserUnavailable && <Text accessibilityRole="alert" style={[styles.notice, { color: palette.colors.textSecondary }]}>Your browser could not open. You can continue securely here.</Text>}
      {checkout?.checkoutPresentation === 'browser' && !checkout.browserHandoff && !failed && <TouchableOpacity
        accessibilityRole="button" accessibilityLabel="Open this payment in browser" onPress={openBrowserFallback} style={styles.browserLink}>
        <Ionicons name="open-outline" size={14} color={palette.colors.primary} />
        <Text style={{ color: palette.colors.primary, fontSize: 12, fontWeight: '600' }}>Google Pay trouble? Open in browser</Text>
      </TouchableOpacity>}
      {blockedLink && !failed && <Text accessibilityRole="alert" style={[styles.notice, { color: palette.colors.textSecondary }]}>An unsupported link was blocked. You can continue with the card form below or close this screen to check payment status.</Text>}
      {!!checkout && !failed && !checkout.browserHandoff && <View style={styles.container}>
        {/* Our navigation policy handles every scheme; unapproved links must not be handed to the OS. */}
        <WebView key={checkout.paymentId} source={{ uri: checkout.checkoutUrl,
          ...(checkout.checkoutPresentation === 'saved-card' ? { headers: { 'X-Rozare-Checkout-Grant': checkout.checkoutSessionGrant } } : {}) }} testID="safepay-webview"
          originWhitelist={['*']}
          onShouldStartLoadWithRequest={allowNavigation}
          onNavigationStateChange={state => { if (safepayNavigationAction(state.url, checkout.environment) === 'complete') finish('return'); }}
          onLoadStart={() => setLoading(true)} onLoadEnd={() => setLoading(false)}
          onError={event => interrupt(`load_error${Number.isInteger(event.nativeEvent?.code) ? `:${event.nativeEvent.code}` : ''}`)}
          onHttpError={event => { if (event.nativeEvent.statusCode >= 400 && event.nativeEvent.url === checkout.checkoutUrl) interrupt(`http_error:${event.nativeEvent.statusCode}`); }}
          onContentProcessDidTerminate={() => interrupt('content_process_terminated')}
          onRenderProcessGone={() => interrupt('render_process_gone')}
          javaScriptEnabled domStorageEnabled sharedCookiesEnabled={false} thirdPartyCookiesEnabled
          paymentRequestEnabled={Platform.OS === 'android' && checkout.checkoutPresentation === 'browser'}
          incognito cacheEnabled={false} mixedContentMode="never" allowFileAccess={false}
          allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false}
          javaScriptCanOpenWindowsAutomatically={false} setSupportMultipleWindows={false}
          webviewDebuggingEnabled={false} allowsBackForwardNavigationGestures={false}
        />
        {loading && <View pointerEvents="none" style={styles.loading}><ActivityIndicator color={palette.colors.primary} /></View>}
      </View>}
      {checkout?.browserHandoff && !failed && <View style={styles.error}>
        <ActivityIndicator color={palette.colors.primary} />
        <Text style={[styles.title, { color: palette.colors.text }]}>Continue in your browser</Text>
        <Text style={[styles.message, { color: palette.colors.textSecondary }]}>Return to Rozare when you finish. We will check this same payment.</Text>
      </View>}
      {failed && <View style={styles.error}>
        <Ionicons name="alert-circle-outline" size={40} color={palette.colors.textSecondary} />
        <Text style={[styles.title, { color: palette.colors.text }]}>Payment screen interrupted</Text>
        <Text style={[styles.message, { color: palette.colors.textSecondary }]}>Return to Rozare to check this payment. We will keep the same payment attempt so you are not asked to pay twice.</Text>
        {!!failureCode && <Text style={{ color: palette.colors.textSecondary }}>Reference: {failureCode}</Text>}
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
  browserLink: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: 16, paddingVertical: 10 },
  error: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28, gap: 16 }, message: { textAlign: 'center', lineHeight: 22 },
  button: { padding: 16, borderRadius: 12 }, buttonText: { color: '#fff', fontWeight: '600' } });
