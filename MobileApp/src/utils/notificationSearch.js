export const notificationMatchesSearch = (notification, query) => {
  const search = String(query || '').trim().toLowerCase();
  if (!search) return true;
  return [notification?.title, notification?.description, notification?.body, notification?.message]
    .filter(value => typeof value === 'string').join(' ').toLowerCase().includes(search);
};
