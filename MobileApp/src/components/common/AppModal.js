import React, { forwardRef } from 'react';
import { Modal as NativeModal, Platform } from 'react-native';
import { ModalSurfaceContext } from '../../contexts/ModalSurfaceContext';

// Preserve native presentation, dismissal, accessibility and keyboard props.
// Only the window's surface/blur context changes.
const AppModal = forwardRef(function AppModal({ children, ...props }, ref) {
  return <NativeModal {...props} supportedOrientations={getModalOrientations(Platform.OS, Platform.isPad, props.supportedOrientations)} ref={ref}>
    <ModalSurfaceContext.Provider value>{children}</ModalSurfaceContext.Provider>
  </NativeModal>;
});
export function getModalOrientations(os, isPad, provided) {
  if (provided !== undefined) return provided;
  return os === 'ios' && isPad ? ['portrait', 'portrait-upside-down', 'landscape-left', 'landscape-right'] : undefined;
}
export default AppModal;
