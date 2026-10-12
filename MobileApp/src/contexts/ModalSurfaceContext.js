import { createContext, useContext } from 'react';

// Native Modal is a separate window. Never sample the screen's BlurTargetView
// through its dimmer, including in nested cards, forms and option pickers.
export const ModalSurfaceContext = createContext(false);
export const useModalSurface = () => useContext(ModalSurfaceContext);
