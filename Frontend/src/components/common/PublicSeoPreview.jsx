import { readPublicSeoPreview } from '../../utils/publicSeoPreview';
import Loader from './Loader';

export default function PublicSeoPreview({ kind, canonical, onChooseLocation, selectionRequired }) {
  const preview = readPublicSeoPreview(kind, canonical);
  if (!preview) return <div className="min-h-[60vh] flex items-center justify-center"><Loader /></div>;
  const price = preview.currency ? new Intl.NumberFormat('en', { style: 'currency', currency: preview.currency, currencyDisplay: 'code' }).format(preview.price) : '';
  return <main className="max-w-5xl mx-auto px-4 py-10" aria-label={kind === 'product' ? 'Product preview' : 'Store preview'}>
    <section className="glass-panel p-6 sm:p-9 grid sm:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] gap-7 items-center">
      {preview.image && <img src={preview.image} alt={kind === 'store' ? `${preview.name} logo` : preview.name} className="w-full max-h-80 object-contain rounded-2xl" />}
      <div><p className="text-sm text-muted-foreground mb-3">{kind === 'product' ? 'Product on Rozare' : 'Store on Rozare'}</p>
        <h1 className="text-2xl sm:text-3xl font-bold mb-4">{preview.name}</h1>
        <p className="leading-relaxed text-muted-foreground mb-4">{preview.description}</p>
        {price && <p className="text-lg font-semibold mb-4">Listed price: {price}</p>}
        <p className="text-sm text-muted-foreground">{selectionRequired ? 'Choose your shopping location to check availability, shipping and purchase options.' : 'Checking availability and loading the latest details…'}</p>
        {selectionRequired && <button type="button" className="glass-button mt-5 px-5 py-3 rounded-xl" onClick={onChooseLocation}>Choose shopping location</button>}
      </div>
    </section>
  </main>;
}
