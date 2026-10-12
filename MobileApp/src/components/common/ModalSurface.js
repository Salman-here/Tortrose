import React, { forwardRef } from 'react';
import { View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useTheme } from '../../contexts/ThemeContext';
import { ModalSurfaceContext } from '../../contexts/ModalSurfaceContext';
import { getModalTokens } from '../../styles/modalTheme';

const ModalSurface = forwardRef(function ModalSurface({ children, style, as: Container = View, ...props }, ref) {
  const { palette } = useTheme();
  const tokens = getModalTokens(palette);
  return <ModalSurfaceContext.Provider value><Container {...props} ref={ref}
    style={[style, { backgroundColor: tokens.surface, borderColor: tokens.border }]}>
    <LinearGradient colors={tokens.glow} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
      pointerEvents="none" style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }} />
    {children}
  </Container></ModalSurfaceContext.Provider>;
});
export default ModalSurface;
