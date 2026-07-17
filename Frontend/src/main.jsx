import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { AuthProvider } from './contexts/AuthContext.jsx'
import { BrowserRouter } from 'react-router-dom'
import { GlobalProvider } from './contexts/GlobalContext.jsx'
import { CurrencyProvider } from './contexts/CurrencyContext.jsx'
import { BuyerLocationProvider } from './contexts/BuyerLocationContext.jsx'
import { ThemeProvider } from './contexts/ThemeContext.jsx'
import { installHttpResilience } from './utils/httpResilience.js'
import { captureTikTokClickId } from './utils/tiktokPixel.js'
import AppErrorBoundary from './components/common/AppErrorBoundary.jsx'
import { reloadOnceForStaleChunk } from './utils/chunkReload.js'

installHttpResilience()
captureTikTokClickId()

// After a deploy, tabs opened on the previous version fail to lazy-load route
// chunks (old hashed filenames are gone). Vite fires this event on any dynamic
// import/preload failure — refresh once to pick up the new version instead of
// crashing to the error screen. Guarded so a truly broken build cannot cause
// a reload loop (the error boundary takes over on repeat failures).
window.addEventListener('vite:preloadError', (event) => {
  if (reloadOnceForStaleChunk()) event.preventDefault()
})

createRoot(document.getElementById('root')).render(
  <BrowserRouter>
    <ThemeProvider>
      <AuthProvider>
        <CurrencyProvider>
          <BuyerLocationProvider>
            <GlobalProvider>
              <AppErrorBoundary>
                <App />
              </AppErrorBoundary>
            </GlobalProvider>
          </BuyerLocationProvider>
        </CurrencyProvider>
      </AuthProvider>
    </ThemeProvider>
  </BrowserRouter>
)
