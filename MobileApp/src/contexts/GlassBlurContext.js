import React, { createContext, useContext } from 'react';

/**
 * One Android BlurTargetView is shared by every glass surface on a screen.
 * SDK 55 can then use the efficient RenderNode path without creating a costly
 * capture target for every card in a list.
 */
const GlassBlurTargetContext = createContext(null);

export function GlassBlurTargetProvider({ targetRef, children }) {
  return (
    <GlassBlurTargetContext.Provider value={targetRef}>
      {children}
    </GlassBlurTargetContext.Provider>
  );
}

export function useGlassBlurTarget() {
  return useContext(GlassBlurTargetContext);
}

export default GlassBlurTargetContext;
