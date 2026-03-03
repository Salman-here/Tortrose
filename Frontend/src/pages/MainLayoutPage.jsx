import React, { useEffect } from 'react'
import { Link, Outlet, useLocation } from 'react-router-dom'
import Navbar from '../components/layout/Navbar'
import CartDropdown from '../components/common/CartDropdown'
import { useGlobal } from '../contexts/GlobalContext'
import { AnimatePresence, motion } from 'framer-motion'

function MainLayoutPage() {
  const {
    dropdownRef,
    setIsOpen,
    cartBtn,
    isOpen
  } = useGlobal()

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const location = useLocation()

  useEffect(() => {
    setIsOpen(false);
  }, [location.pathname])

  return (
    <div className='relative'>
      <AnimatePresence mode='wait'>
        {
          isOpen && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className={`flex fixed w-full h-screen top-0 left-0 backdrop-blur-[4px] bg-black/30 z-50`}></motion.div>
          )
        }

      </AnimatePresence>
      <Navbar />
      <CartDropdown />
      <div className='mt-[70px] sm:mt-[80px]'>
        <Outlet />
      </div>
      
    </div>
  )
}

export default MainLayoutPage