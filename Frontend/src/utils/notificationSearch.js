// Keep buyer/seller inbox search consistent with the native app: public order
// references and amounts usually live in the message body, not its short title.
export const notificationMatchesSearch = (notification, query) => {
  const search = String(query || '').trim().toLowerCase();
  if (!search) return true;
  return [notification?.title, notification?.description, notification?.body, notification?.message]
    .filter(value => typeof value === 'string').join(' ').toLowerCase().includes(search);
};
