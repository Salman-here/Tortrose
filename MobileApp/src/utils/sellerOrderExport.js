import { Platform } from 'react-native';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import api, { API_ENDPOINTS } from '../config/api';

export const ORDER_EXPORT_FORMATS = Object.freeze({
  pdf: { extension: 'pdf', mimeType: 'application/pdf' },
  excel: { extension: 'xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  csv: { extension: 'csv', mimeType: 'text/csv' },
});

export function buildOrderFilterParams({
  search = '',
  status = 'all',
  paymentStatus = 'all',
  startDate = '',
  endDate = '',
} = {}) {
  const params = {};
  const cleanSearch = String(search || '').trim();
  if (cleanSearch) params.search = cleanSearch;
  if (status && status !== 'all') params.status = status;
  if (paymentStatus && paymentStatus !== 'all') params.paymentStatus = paymentStatus;
  if (startDate) params.startDate = startDate;
  if (endDate) params.endDate = endDate;
  return params;
}

export function validateOrderDateRange(startDate, endDate) {
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  if (startDate && !datePattern.test(startDate)) return 'Start date must use YYYY-MM-DD.';
  if (endDate && !datePattern.test(endDate)) return 'End date must use YYYY-MM-DD.';
  if (startDate && Number.isNaN(Date.parse(`${startDate}T00:00:00Z`))) return 'Start date is not valid.';
  if (endDate && Number.isNaN(Date.parse(`${endDate}T00:00:00Z`))) return 'End date is not valid.';
  if (startDate && endDate && startDate > endDate) return 'Start date cannot be after end date.';
  return '';
}

function responseToBytes(data) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (typeof data === 'string') {
    return Uint8Array.from(data, (character) => character.charCodeAt(0) & 0xff);
  }
  throw new Error('The export service returned an unsupported file response.');
}

export async function shareSellerOrderExport({ format = 'pdf', filters = {}, currency = 'USD' } = {}) {
  const config = ORDER_EXPORT_FORMATS[format] || ORDER_EXPORT_FORMATS.pdf;
  const response = await api.get(API_ENDPOINTS.ORDERS.EXPORT, {
    params: { ...buildOrderFilterParams(filters), format, currency },
    responseType: 'arraybuffer',
  });

  const filename = `rozare-orders-${new Date().toISOString().slice(0, 10)}.${config.extension}`;

  if (Platform.OS === 'web') {
    const blob = new Blob([response.data], { type: config.mimeType });
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(objectUrl);
    return { uri: objectUrl, shared: false };
  }

  const file = new File(Paths.cache, filename);
  file.create({ overwrite: true, intermediates: true });
  file.write(responseToBytes(response.data));

  const canShare = await Sharing.isAvailableAsync();
  if (!canShare) return { uri: file.uri, shared: false };
  await Sharing.shareAsync(file.uri, {
    mimeType: config.mimeType,
    dialogTitle: `Share ${filename}`,
  });
  return { uri: file.uri, shared: true };
}
