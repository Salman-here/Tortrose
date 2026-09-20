import AppRoutes from './routes/AppRoutes'
import DocsPage from './pages/DocsPage'
import { isSubdomain, isDocsSubdomain, getSubdomain } from './utils/subdomainHelper'
import 'react-toastify/dist/ReactToastify.css';
import { ToastContainer } from 'react-toastify'
import { HelmetProvider } from 'react-helmet-async';
import Analytics from './components/common/Analytics'
import TestPhaseNotice from './components/common/TestPhaseNotice'
import ShoppingLocationPrompt from './components/common/ShoppingLocationPrompt'
import { useLocation } from 'react-router-dom'
import { useBuyerLocation } from './contexts/BuyerLocationContext'
 
function App() {  
  const { pathname } = useLocation();
  const { locationQueryString, selectionRequired } = useBuyerLocation();
  const catalogRoute = pathname === '/' || /^\/(products|stores|store|single-product|marketplace|trusted-stores)(\/|$)/.test(pathname);
  const catalogKey = catalogRoute ? locationQueryString + ':' + selectionRequired : 'non-catalog';
  // Reserved system subdomain: docs.rozare.com
  const onDocs = isDocsSubdomain(); 
  // Store subdomain (storename.rozare.com) — full app routes still work,
  // we only override the home route to render the store page for this subdomain.
  const subdomainSlug = !onDocs && isSubdomain() ? getSubdomain() : null;

  return (
    <HelmetProvider> 
      <Analytics />
      <ToastContainer
        position='bottom-right'
        autoClose={3500}
        hideProgressBar
        newestOnTop={false}
        closeOnClick
        rtl={false}
        pauseOnFocusLoss={false}
        draggable={false}
        pauseOnHover
        theme='dark'
        limit={3}
        toastStyle={{
          borderRadius: '12px',
          padding: '12px 16px',
          fontSize: '14px',
          fontWeight: '500',
          backdropFilter: 'blur(12px)',
          boxShadow: '0 8px 32px rgba(0,0,0,0.12)',
        }}
      />
      <TestPhaseNotice />
      {!onDocs && <ShoppingLocationPrompt />}
      {onDocs ? <DocsPage /> : <AppRoutes key={catalogKey} subdomainSlug={subdomainSlug} />}
    </HelmetProvider>
  )
}

export default App
