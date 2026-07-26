const listeners = new Set();

let nextId = 0;

const normalize = (notice = {}) => {
  const type = ['success', 'error', 'warning', 'info'].includes(notice.type)
    ? notice.type
    : 'info';

  return {
    id: ++nextId,
    type,
    title: notice.text1 || notice.title || (type === 'error' ? 'Something went wrong' : 'Update'),
    message: notice.text2 || notice.message || '',
    actionLabel: notice.actionLabel,
    onAction: notice.onAction,
    duration: Number.isFinite(notice.duration)
      ? notice.duration
      : type === 'error'
        ? 6500
        : type === 'warning'
          ? 5200
          : 3400,
  };
};

const Feedback = {
  show(notice) {
    const normalized = normalize(notice);
    listeners.forEach((listener) => listener(normalized));
    return normalized.id;
  },

  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export { normalize };
export default Feedback;
