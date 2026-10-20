import { useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getResponsiveLayout } from '../utils/responsiveLayout';

export default function useResponsiveLayout(options = {}) {
  const { width, height, fontScale } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  return { ...getResponsiveLayout(width, { ...insets, fontScale, ...options }), windowWidth: width, windowHeight: height, fontScale };
}
