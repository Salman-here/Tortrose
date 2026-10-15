export default function AfterSalesPhotos({ photos = [], onRemove, busy = false, label = 'Return photo' }) {
  return <div className="flex flex-wrap gap-3 mt-3" aria-label={`${label} evidence`}>
    {photos.map((photo, index) => {
      const url = typeof photo === 'string' ? photo : photo.url;
      if (typeof url !== 'string' || !url.startsWith('https://')) return null;
      const key = photo._id || `${url}-${index}`;
      return <div key={key} className="space-y-1">
        <a href={url} target="_blank" rel="noopener noreferrer" aria-label={`View ${label.toLowerCase()} ${index + 1}`}><img src={url} alt={`${label} ${index + 1}`} className="w-24 h-24 object-cover rounded-xl border border-border" /></a>
        {onRemove && <button type="button" className="block text-xs text-muted-foreground disabled:opacity-50" disabled={busy} onClick={() => onRemove(photo._id)} aria-label={`Remove ${label.toLowerCase()} ${index + 1}`}>Remove</button>}
      </div>;
    })}
  </div>;
}
