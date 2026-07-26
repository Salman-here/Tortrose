/**
 * RozareLogo — pixel-matches the website mark (Frontend/public/rozare-logo.svg).
 * Rotated "gem" tile with a negative-space R monogram, orbital arc + spark dot,
 * and the "Rozare" wordmark in the brand teal→sky→indigo gradient.
 *
 * The website wraps the mark in <g transform="translate(4,4)">; here that offset
 * is baked into every absolute coordinate so we don't depend on <G> transform
 * behaviour, which differs between native react-native-svg and react-native-web.
 */

import React, { useId } from 'react';
import { View } from 'react-native';
import Svg, { Defs, LinearGradient, Stop, Rect, Path, Circle, Text as SvgText } from 'react-native-svg';

export default function RozareLogo({ width = 140, height = 36, showText = true }) {
  const instanceId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const gradientId = `rzGrad-${instanceId}`;
  const softGradientId = `rzGradSoft-${instanceId}`;
  const iconSize = height;
  // Icon-only mark lives in a 56×56 box; full lockup (mark + wordmark) is 220×56.
  const viewBoxW = showText ? 220 : 56;

  return (
    <View style={{ width: showText ? width : iconSize, height: iconSize }}>
      <Svg
        viewBox={`0 0 ${viewBoxW} 56`}
        width={showText ? width : iconSize}
        height={iconSize}
      >
        <Defs>
          <LinearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="100%">
            <Stop offset="0%" stopColor="#14B8A6" />
            <Stop offset="50%" stopColor="#0EA5E9" />
            <Stop offset="100%" stopColor="#6366F1" />
          </LinearGradient>
          <LinearGradient id={softGradientId} x1="0%" y1="0%" x2="100%" y2="100%">
            <Stop offset="0%" stopColor="#14B8A6" stopOpacity="0.18" />
            <Stop offset="100%" stopColor="#6366F1" stopOpacity="0.18" />
          </LinearGradient>
        </Defs>

        {/* Mark: rotated square "gem" with negative-space R cut by an orbital arc */}
        {/* Soft glow tile */}
        <Rect x="6" y="6" width="44" height="44" rx="12" fill={`url(#${softGradientId})`} />
        {/* Primary gem tile */}
        <Rect x="8" y="8" width="40" height="40" rx="11" fill={`url(#${gradientId})`} />
        {/* Orbital arc accent */}
        <Path
          d="M41 18 a15 15 0 0 1 -25 21"
          fill="none"
          stroke="white"
          strokeOpacity="0.35"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
        {/* Negative-space monogram R */}
        <Path
          d="M19 18 h11 a7 7 0 0 1 0 14 h-7 l9 6 M23 32 v6 M23 18 v20"
          fill="none"
          stroke="white"
          strokeWidth="3.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {/* Spark dot */}
        <Circle cx="39" cy="16" r="2" fill="white" />

        {showText && (
          <SvgText
            x="62"
            y="37"
            fontFamily="System"
            fontSize="26"
            fontWeight="700"
            letterSpacing="1.2"
            fill={`url(#${gradientId})`}
          >
            Rozare
          </SvgText>
        )}
      </Svg>
    </View>
  );
}
