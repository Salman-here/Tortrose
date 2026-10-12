import React, { forwardRef } from 'react';
import { Modal as NativeModal } from 'react-native';
import { ModalSurfaceContext } from '../../contexts/ModalSurfaceContext';

// Preserve native presentation, dismissal, accessibility and keyboard props.
// Only the window's surface/blur context changes.
const AppModal = forwardRef(function AppModal({ children, ...props }, ref) {
  return <NativeModal {...props} ref={ref}>
    <ModalSurfaceContext.Provider value>{children}</ModalSurfaceContext.Provider>
  </NativeModal>;
});
export default AppModal;
