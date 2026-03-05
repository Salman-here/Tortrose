/**
 * TortroseLogo — SVG brand mark for mobile app
 * Matches the website navbar logo (rose-shield icon + brand text)
 */

import React from 'react';
import { View } from 'react-native';
import Svg, { Defs, LinearGradient, Stop, G, Path, Ellipse, Circle, Text as SvgText } from 'react-native-svg';

export default function TortroseLogo({ width = 140, height = 32, showText = true }) {
  const iconSize = height;
  const viewBoxW = showText ? 240 : 50;

  return (
    <View style={{ width: showText ? width : iconSize, height: iconSize }}>
      <Svg
        viewBox={`0 0 ${viewBoxW} 50`}
        width={showText ? width : iconSize}
        height={iconSize}
      >
        <Defs>
          <LinearGradient id="logoGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <Stop offset="0%" stopColor="#6366f1" />
            <Stop offset="50%" stopColor="#8b5cf6" />
            <Stop offset="100%" stopColor="#a855f7" />
          </LinearGradient>
          <LinearGradient id="petalLight" x1="30%" y1="0%" x2="70%" y2="100%">
            <Stop offset="0%" stopColor="#818cf8" />
            <Stop offset="100%" stopColor="#a78bfa" />
          </LinearGradient>
          <LinearGradient id="petalDeep" x1="0%" y1="0%" x2="100%" y2="100%">
            <Stop offset="0%" stopColor="#6366f1" />
            <Stop offset="100%" stopColor="#7c3aed" />
          </LinearGradient>
          <LinearGradient id="shieldBase" x1="50%" y1="0%" x2="50%" y2="100%">
            <Stop offset="0%" stopColor="#7c3aed" />
            <Stop offset="100%" stopColor="#6366f1" />
          </LinearGradient>
        </Defs>

        <G transform="translate(3, 1) scale(0.094)">
          {/* Shield outline glow */}
          <Path d="M256 55 C188 55 125 115 125 195 C125 235 145 270 175 295 L256 365 L337 295 C367 270 387 235 387 195 C387 115 324 55 256 55Z" fill="none" stroke="url(#logoGrad)" strokeWidth="3" opacity="0.2" />
          {/* Outer petals */}
          <Path d="M256 80 C195 80 135 135 135 200 C135 232 152 262 178 283 L256 345 L334 283 C360 262 377 232 377 200 C377 135 317 80 256 80Z" fill="url(#petalLight)" opacity="0.3" />
          {/* Mid outer petals */}
          <Path d="M256 65 C185 100 135 160 158 238 C168 268 198 298 256 318 C314 298 344 268 354 238 C377 160 327 100 256 65Z" fill="url(#logoGrad)" opacity="0.5" />
          {/* Left accent petal */}
          <Path d="M200 160 C180 130 195 95 230 90 C250 88 256 110 250 140 C244 170 220 190 200 160Z" fill="url(#petalLight)" opacity="0.45" />
          {/* Right accent petal */}
          <Path d="M312 160 C332 130 317 95 282 90 C262 88 256 110 262 140 C268 170 292 190 312 160Z" fill="url(#petalLight)" opacity="0.45" />
          {/* Inner main petal */}
          <Ellipse cx="256" cy="195" rx="58" ry="78" fill="url(#logoGrad)" opacity="0.85" />
          {/* Inner detail petals */}
          <Ellipse cx="240" cy="185" rx="28" ry="48" fill="url(#petalDeep)" opacity="0.5" transform="rotate(-12, 240, 185)" />
          <Ellipse cx="272" cy="185" rx="28" ry="48" fill="url(#petalDeep)" opacity="0.5" transform="rotate(12, 272, 185)" />
          {/* Core highlight */}
          <Ellipse cx="256" cy="185" rx="24" ry="34" fill="white" opacity="0.25" />
          <Ellipse cx="256" cy="178" rx="14" ry="20" fill="white" opacity="0.35" />
          <Circle cx="252" cy="172" r="7" fill="white" opacity="0.5" />
          <Circle cx="260" cy="176" r="4" fill="white" opacity="0.35" />
          {/* Shield base */}
          <Path d="M195 280 L256 368 L317 280 C294 315 218 315 195 280Z" fill="url(#shieldBase)" />
          <Path d="M220 290 L256 345 L292 290 C278 310 234 310 220 290Z" fill="white" opacity="0.15" />
        </G>

        {showText && (
          <SvgText
            x="52"
            y="33"
            fontFamily="System"
            fontSize="25"
            fontWeight="800"
            letterSpacing="-0.5"
            fill="url(#logoGrad)"
          >
            Tortrose
          </SvgText>
        )}
      </Svg>
    </View>
  );
}
