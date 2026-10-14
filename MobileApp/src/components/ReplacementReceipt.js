import React, { useState } from 'react';
import { Alert, Text, TouchableOpacity, View } from 'react-native';
import api from '../config/api';
import Feedback from '../utils/feedback';
import { useTheme } from '../contexts/ThemeContext';
import { inspectReturnPresentationSnapshot } from '../utils/returnPresentationSafety';
import { publishAfterSalesChange } from '../utils/afterSalesRefresh';
export default function ReplacementReceipt({ request, onChanged }) {
  const { palette } = useTheme();
  const [busy, setBusy] = useState(false);
  if (!request.replacement?.shippedAt) return null;
  const receive = () => Alert.alert('Replacement received?', 'Confirm only after your replacement has arrived.', [{ text: 'Not now', style: 'cancel' }, { text: 'Confirm', onPress: async () => {
    setBusy(true);
    try {
      const response = await api.post(`/api/returns/${request._id}/replacement/receive`);
      if (!inspectReturnPresentationSnapshot(response.data?.returnRequest).valid || response.data.returnRequest.status !== 'replacement_delivered') throw new Error('Delivery confirmation could not be verified.');
      await onChanged(); publishAfterSalesChange(request.order); Feedback.show({ type: 'success', text1: 'Replacement received' });
    } catch (error) { Feedback.show({ type: 'error', text1: 'Unable to confirm receipt', text2: error.response?.data?.msg || error.message }); }
    finally { setBusy(false); }
  } }]);
  return <View style={{ marginTop: 14, gap: 8 }}><Text style={{ fontSize: 13, fontWeight: '700', color: palette.colors.text }}>Replacement shipment</Text><Text style={{ fontSize: 12, color: palette.colors.textSecondary }}>{request.replacement.shippingMethod === 'courier' ? `${request.replacement.carrier} · ${request.replacement.trackingNumber}` : 'Hand delivery'}</Text>{request.status === 'replacement_shipped' && <TouchableOpacity accessibilityRole="button" onPress={receive} disabled={busy} style={{ backgroundColor: palette.colors.primary, padding: 12, borderRadius: 12 }}><Text style={{ color: '#fff', fontWeight: '700', fontSize: 12 }}>{busy ? 'Confirming…' : 'Confirm replacement received'}</Text></TouchableOpacity>}{request.status === 'replacement_delivered' && <Text style={{ color: palette.colors.success, fontSize: 12 }}>Received {new Date(request.replacement.deliveredAt).toLocaleString()}</Text>}</View>;
}
