import AppRoutes from './routes/AppRoutes'
import 'react-toastify/dist/ReactToastify.css';
import { ToastContainer } from 'react-toastify'
import { HelmetProvider } from 'react-helmet-async'

function App() {
  return (
    <HelmetProvider>
      <ToastContainer position='top-center' autoClose={2300} />
      <AppRoutes />
    </HelmetProvider>
  )
}

export default App
