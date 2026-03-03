/* SPIN WHEEL DISABLED
import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Gift, Sparkles, Trophy, Zap, Star } from 'lucide-react';
import { toast } from 'react-toastify';

export default function SpinWheel({ onSpinComplete, onClose }) {
  const segments = [
    { label: '40% OFF', color: '#ef4444', value: 40, type: 'percentage' },
    { label: 'All products FREE', color: '#10b981', value: 100, type: 'free' },
    { label: '60% OFF', color: '#3b82f6', value: 60, type: 'percentage' },
    { label: 'All products $0.99', color: '#eab308', value: 0.99, type: 'fixed' },
    { label: '80% OFF', color: '#a855f7', value: 80, type: 'percentage' },
    { label: '99% OFF', color: '#ec4899', value: 99, type: 'percentage' },
  ];

  const [rotation, setRotation] = useState(0);
  const [isSpinning, setIsSpinning] = useState(false);
  const [result, setResult] = useState(null);
  const [showCongrats, setShowCongrats] = useState(false);

  const targetSegments = [1, 3]; // "All products FREE" and "All products $0.99"

  const spin = async () => {
    if (isSpinning) return;

    setIsSpinning(true);
    setResult(null);
    setShowCongrats(false);

    const targetIndex = targetSegments[Math.floor(Math.random() * targetSegments.length)];
    const segmentAngle = 360 / segments.length;
    const targetAngle = targetIndex * segmentAngle + segmentAngle / 2;
    const currentAngle = rotation % 360;
    const angleDifference = (targetAngle - currentAngle + 360) % 360;
    const fullRotations = (5 + Math.random()) * 360;
    const finalRotation = rotation + fullRotations + angleDifference;

    setRotation(finalRotation);

    setTimeout(async () => {
      setIsSpinning(false);
      const wonSegment = segments[targetIndex];
      setResult(wonSegment);
      setShowCongrats(true);

      // Notify parent component for immediate UI update
      if (onSpinComplete) {
        onSpinComplete(wonSegment);
      }
    }, 5000);
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 bg-gradient-to-br from-black/80 via-purple-900/50 to-black/80 backdrop-blur-md flex items-center justify-center p-4 z-50 overflow-y-auto"
    >
      {/* Animated background particles */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        {[...Array(20)].map((_, i) => (
          <motion.div
            key={i}
            className="absolute w-2 h-2 bg-white/20 rounded-full"
            style={{
              left: `${Math.random() * 100}%`,
              top: `${Math.random() * 100}%`,
            }}
            animate={{
              y: [0, -30, 0],
              opacity: [0.2, 0.5, 0.2],
              scale: [1, 1.5, 1],
            }}
            transition={{
              duration: 3 + Math.random() * 2,
              repeat: Infinity,
              delay: Math.random() * 2,
            }}
          />
        ))}
      </div>

      <motion.div
        initial={{ scale: 0.8, opacity: 0, y: 50 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.8, opacity: 0, y: 50 }}
        transition={{ type: "spring", damping: 20, stiffness: 300 }}
        className="bg-white rounded-2xl sm:rounded-3xl shadow-2xl p-3 sm:p-6 max-w-2xl w-full relative"
      >
        {/* Decorative elements */}
        <div className="absolute top-0 left-0 w-full h-2 bg-gradient-to-r from-purple-500 via-pink-500 to-orange-500"></div>
        
        {/* Close button */}
        <motion.button
          onClick={onClose}
          whileHover={{ scale: 1.1, rotate: 90 }}
          whileTap={{ scale: 0.9 }}
          className="sticky top-2 sm:absolute sm:top-6 right-2 sm:right-6 ml-auto p-2 bg-gray-100 hover:bg-gray-200 rounded-full transition-colors z-50 shadow-lg flex items-center justify-center"
        >
          <X size={20} className="text-gray-600" />
        </motion.button>

        {/* Header */}
        <motion.div
          initial={{ y: -20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.2 }}
          className="text-center mb-2 sm:mb-4 mt-1"
        >
          <motion.div
            animate={{ rotate: [0, 10, -10, 0] }}
            transition={{ duration: 0.5, repeat: Infinity, repeatDelay: 3 }}
            className="inline-block mb-1"
          >
            <Gift size={28} className="text-purple-600 sm:w-9 sm:h-9" />
          </motion.div>
          <h1 className="text-2xl sm:text-4xl font-black bg-gradient-to-r from-purple-600 via-pink-600 to-orange-600 bg-clip-text text-transparent mb-1">
            SPIN & WIN!
          </h1>
          <p className="text-gray-600 text-xs sm:text-base font-medium px-2">
            Get discounts up to <span className="text-purple-600 font-bold">100% OFF!</span>
          </p>
        </motion.div>

        {/* Wheel Container */}
        <div className="relative flex flex-col items-center justify-center mb-2 sm:mb-4">
          {/* Glow effect behind wheel */}
          <motion.div
            animate={{
              scale: [1, 1.1, 1],
              opacity: [0.3, 0.5, 0.3],
            }}
            transition={{
              duration: 2,
              repeat: Infinity,
            }}
            className="absolute w-48 h-48 sm:w-72 sm:h-72 bg-gradient-to-r from-purple-500 to-pink-500 rounded-full blur-3xl"
          />

          {/* Pointer */}
          <motion.div
            animate={isSpinning ? { y: [0, -3, 0] } : {}}
            transition={{ duration: 0.3, repeat: isSpinning ? Infinity : 0 }}
            className="relative z-20 w-0 h-0 mb-1"
            style={{
              borderLeft: '16px solid transparent',
              borderRight: '16px solid transparent',
              borderTop: '32px solid #dc2626',
              filter: 'drop-shadow(0 4px 8px rgba(220, 38, 38, 0.5))',
            }}
          />

          {/* Wheel with border glow */}
          <div className="relative w-full max-w-[220px] sm:max-w-[320px]">
            <motion.div
              animate={isSpinning ? {
                boxShadow: [
                  '0 0 20px rgba(168, 85, 247, 0.4)',
                  '0 0 40px rgba(236, 72, 153, 0.6)',
                  '0 0 20px rgba(168, 85, 247, 0.4)',
                ]
              } : {}}
              transition={{ duration: 0.5, repeat: isSpinning ? Infinity : 0 }}
              className="relative w-full aspect-square rounded-full"
            >
              <div
                className="absolute inset-0 rounded-full shadow-2xl border-8 border-white"
                style={{
                  transform: `rotate(${rotation}deg)`,
                  transition: isSpinning
                    ? 'transform 5000ms cubic-bezier(0.17, 0.67, 0.12, 0.99)'
                    : 'none',
                }}
              >
                <svg viewBox="0 0 200 200" className="w-full h-full">
                  {segments.map((segment, index) => {
                    const angle = (360 / segments.length) * index;
                    const nextAngle = (360 / segments.length) * (index + 1);

                    const x1 = 100 + 100 * Math.cos(((angle - 90) * Math.PI) / 180);
                    const y1 = 100 + 100 * Math.sin(((angle - 90) * Math.PI) / 180);
                    const x2 = 100 + 100 * Math.cos(((nextAngle - 90) * Math.PI) / 180);
                    const y2 = 100 + 100 * Math.sin(((nextAngle - 90) * Math.PI) / 180);

                    const largeArc = nextAngle - angle > 180 ? 1 : 0;
                    const pathData = `M 100 100 L ${x1} ${y1} A 100 100 0 ${largeArc} 1 ${x2} ${y2} Z`;

                    const textAngle = angle + (360 / segments.length) / 2;
                    const textX = 100 + 65 * Math.cos(((textAngle - 90) * Math.PI) / 180);
                    const textY = 100 + 65 * Math.sin(((textAngle - 90) * Math.PI) / 180);

                    return (
                      <g key={index}>
                        <path d={pathData} fill={segment.color} stroke="white" strokeWidth="4" />
                        <text
                          x={textX}
                          y={textY}
                          fill="white"
                          fontSize="10"
                          fontWeight="bold"
                          textAnchor="middle"
                          transform={`rotate(${textAngle}, ${textX}, ${textY})`}
                        >
                          {segment.label.split(' ').map((word, i) => (
                            <tspan key={i} x={textX} dy={i === 0 ? 0 : 11}>
                              {word}
                            </tspan>
                          ))}
                        </text>
                      </g>
                    );
                  })}
                  {/* Center circle with gradient */}
                  <defs>
                    <radialGradient id="centerGradient">
                      <stop offset="0%" stopColor="#fbbf24" />
                      <stop offset="100%" stopColor="#f59e0b" />
                    </radialGradient>
                  </defs>
                  <circle cx="100" cy="100" r="20" fill="url(#centerGradient)" stroke="white" strokeWidth="4" />
                  <circle cx="100" cy="100" r="8" fill="white" />
                </svg>
              </div>
            </motion.div>
          </div>

          {/* Spin Button */}
          <motion.button
            onClick={spin}
            disabled={isSpinning || showCongrats}
            whileHover={!isSpinning && !showCongrats ? { scale: 1.05, y: -2 } : {}}
            whileTap={!isSpinning && !showCongrats ? { scale: 0.95 } : {}}
            className="mt-2 sm:mt-4 px-6 sm:px-12 py-2 sm:py-3 rounded-full bg-gradient-to-r from-purple-600 via-pink-600 to-orange-600 text-white font-black text-base sm:text-xl shadow-2xl hover:shadow-purple-500/50 disabled:opacity-50 disabled:cursor-not-allowed transition-all relative overflow-hidden group"
          >
            {/* Button shine effect */}
            <motion.div
              animate={!isSpinning && !showCongrats ? {
                x: ['-100%', '200%'],
              } : {}}
              transition={{
                duration: 2,
                repeat: Infinity,
                repeatDelay: 1,
              }}
              className="absolute inset-0 w-1/2 bg-gradient-to-r from-transparent via-white/30 to-transparent skew-x-12"
            />
            
            <span className="relative z-10 flex items-center gap-2">
              {isSpinning ? (
                <>
                  <motion.span
                    animate={{ rotate: 360 }}
                    transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
                  >
                    <Sparkles size={18} className="sm:w-5 sm:h-5" />
                  </motion.span>
                  SPINNING...
                </>
              ) : showCongrats ? (
                <>
                  <Trophy size={18} className="sm:w-5 sm:h-5" />
                  PRIZE WON!
                </>
              ) : (
                <>
                  <Zap size={18} className="sm:w-5 sm:h-5" fill="currentColor" />
                  SPIN NOW
                  <Zap size={18} className="sm:w-5 sm:h-5" fill="currentColor" />
                </>
              )}
            </span>
          </motion.button>
        </div>

        {/* Congratulations Section */}
        <AnimatePresence>
          {showCongrats && result && (
            <motion.div
              initial={{ opacity: 0, scale: 0.8, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.8, y: -20 }}
              transition={{ type: "spring", damping: 15, stiffness: 300 }}
              className="relative"
            >
              {/* Confetti effect */}
              <div className="absolute inset-0 pointer-events-none">
                {[...Array(30)].map((_, i) => (
                  <motion.div
                    key={i}
                    className="absolute w-3 h-3 rounded-full"
                    style={{
                      left: '50%',
                      top: '50%',
                      backgroundColor: ['#ef4444', '#10b981', '#3b82f6', '#eab308', '#a855f7', '#ec4899'][i % 6],
                    }}
                    animate={{
                      x: [0, (Math.random() - 0.5) * 400],
                      y: [0, (Math.random() - 0.5) * 400],
                      opacity: [1, 0],
                      scale: [1, 0],
                    }}
                    transition={{
                      duration: 1.5,
                      ease: "easeOut",
                    }}
                  />
                ))}
              </div>

              <div className="bg-gradient-to-br from-yellow-400 via-orange-500 to-pink-600 rounded-xl sm:rounded-2xl p-4 sm:p-6 text-center shadow-2xl relative overflow-hidden">
                {/* Animated background pattern */}
                <motion.div
                  animate={{
                    backgroundPosition: ['0% 0%', '100% 100%'],
                  }}
                  transition={{
                    duration: 3,
                    repeat: Infinity,
                    repeatType: "reverse",
                  }}
                  className="absolute inset-0 opacity-20"
                  style={{
                    backgroundImage: 'radial-gradient(circle, white 1px, transparent 1px)',
                    backgroundSize: '30px 30px',
                  }}
                />

                <motion.div
                  animate={{ rotate: [0, 360] }}
                  transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
                  className="absolute top-4 right-4"
                >
                  <Star size={32} className="text-white/30" fill="currentColor" />
                </motion.div>

                <motion.div
                  animate={{ rotate: [360, 0] }}
                  transition={{ duration: 3, repeat: Infinity, ease: "linear" }}
                  className="absolute bottom-4 left-4"
                >
                  <Sparkles size={28} className="text-white/30" />
                </motion.div>

                <motion.div
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={{ type: "spring", damping: 10, stiffness: 200, delay: 0.2 }}
                  className="relative z-10"
                >
                  <Trophy size={40} className="text-white mx-auto mb-2 drop-shadow-lg sm:w-14 sm:h-14" />
                  <h2 className="text-xl sm:text-3xl font-black text-white mb-2 drop-shadow-lg">
                    🎊 CONGRATULATIONS! 🎊
                  </h2>
                  <motion.p
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    transition={{ type: "spring", damping: 10, stiffness: 200, delay: 0.4 }}
                    className="text-3xl sm:text-5xl font-black text-white mb-3 drop-shadow-lg"
                  >
                    {result.label}
                  </motion.p>
                  <div className="bg-white/20 backdrop-blur-sm rounded-lg sm:rounded-xl p-3 mb-3">
                    <p className="text-white text-sm sm:text-base font-semibold mb-1">
                      🎁 Your Exclusive Offer:
                    </p>
                    <p className="text-white/90 text-xs sm:text-sm">
                      Select up to <span className="font-bold text-base sm:text-lg">3 products</span> at this special price!
                    </p>
                  </div>
                  <motion.button
                    onClick={onClose}
                    whileHover={{ scale: 1.05 }}
                    whileTap={{ scale: 0.95 }}
                    className="bg-white text-purple-600 font-bold text-sm sm:text-base px-6 sm:px-8 py-2 sm:py-3 rounded-full shadow-lg hover:shadow-xl transition-all"
                  >
                    Start Shopping! 🛍️
                  </motion.button>
                </motion.div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Initial message */}
        {/* {!result && !isSpinning && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.3 }}
            className="text-center"
          >
            <div className="bg-gradient-to-r from-purple-50 to-pink-50 rounded-lg sm:rounded-xl p-3 sm:p-4 border-2 border-purple-200">
              <div className="flex items-center justify-center gap-2 mb-2">
                <Sparkles className="text-purple-600" size={18} />
                <p className="text-sm sm:text-lg font-bold text-gray-800">Ready to Win Big?</p>
                <Sparkles className="text-pink-600" size={18} />
              </div>
              <p className="text-gray-600 text-xs sm:text-sm mb-1">
                🎯 <span className="font-semibold">6 amazing prizes</span> waiting!
              </p>
              <p className="text-[10px] sm:text-xs text-gray-500">
                Click the button to spin and discover your discount!
              </p>
            </div>
          </motion.div>
        )}

        {isSpinning && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-center"
          >
            <div className="bg-gradient-to-r from-blue-50 to-purple-50 rounded-lg sm:rounded-xl p-3 sm:p-4 border-2 border-blue-200">
              <motion.div
                animate={{ rotate: 360 }}
                transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
                className="inline-block mb-2"
              >
                <Sparkles size={28} className="text-purple-600 sm:w-9 sm:h-9" />
              </motion.div>
              <p className="text-base sm:text-xl font-bold text-gray-800 mb-1 animate-pulse">
                🍀 Spinning... Good Luck! 🍀
              </p>
              <p className="text-gray-600 text-xs sm:text-sm">
                Your prize is being selected...
              </p>
            </div>
          </motion.div>
        )} */}

        {/* Features */}
        {/* {!showCongrats && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4 }}
            className="mt-2 sm:mt-4 grid grid-cols-3 gap-2"
          >
            <div className="text-center p-1.5 sm:p-2 bg-purple-50 rounded-lg">
              <div className="text-lg sm:text-xl mb-0.5">🎁</div>
              <p className="text-[9px] sm:text-[10px] font-semibold text-gray-700">Up to 100% OFF</p>
            </div>
            <div className="text-center p-1.5 sm:p-2 bg-pink-50 rounded-lg">
              <div className="text-lg sm:text-xl mb-0.5">⚡</div>
              <p className="text-[9px] sm:text-[10px] font-semibold text-gray-700">Instant Discount</p>
            </div>
            <div className="text-center p-1.5 sm:p-2 bg-orange-50 rounded-lg">
              <div className="text-lg sm:text-xl mb-0.5">🎯</div>
              <p className="text-[9px] sm:text-[10px] font-semibold text-gray-700">3 Products</p>
            </div>
          </motion.div>
        )} */}
      </motion.div>
    </motion.div>
  );
}
SPIN WHEEL DISABLED */
