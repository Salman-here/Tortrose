import { useState } from 'react'
import reactLogo from './assets/react.svg'
import viteLogo from '/vite.svg'
import Products from './components/Products'
import AppRoutes from './routes/AppRoutes'
import 'react-toastify/dist/ReactToastify.css';
import { ToastContainer } from 'react-toastify'


function App() {

  return (
    <>
      <ToastContainer position='top-center' autoClose={2300} />
      <AppRoutes />
    </>
  )
}

export default App
