import React from 'react';
import { motion } from 'framer-motion';
import { Users, Clock, Trophy, AlertCircle } from 'lucide-react';

export default function SpinBanner({ spinResult, selectedCount = 0 }) {
  if (!spinResult) return null;

  const getDiscountText = () => {
    if (spinResult.type === 'free') {
      return 'FREE';
    } else if (spinResult.type === 'fixed') {
      return `$${spinResult.value}`;
    } else {
      return `${spinResult.value}% OFF`;
    }
  };

  const getTimeRemaining = () => {
    const now = new Date();
    // Calculate expiration from timestamp (24 hours from spin)
    const spinTimestamp = localStorage.getItem('spinTimestamp');
    if (!spinTimestamp) return '0h 0m';
    
    const spinTime = parseInt(spinTimestamp);
    const expires = new Date(spinTime + (24 * 60 * 60 * 1000));
    const diff = expires - now;
    
    if (diff <= 0) return '0h 0m';
    
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    return `${hours}h ${minutes}m`;
  };

  if (spinResult.hasCheckedOut) {
    const timeRemaining = getTimeRemaining();
    
    return (
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-gradient-to-r from-purple-600 via-indigo-600 to-purple-600 text-white p-6 rounded-xl shadow-lg mb-6"
      >
        {/* Main Message */}
        <div className="flex items-center justify-center gap-3 mb-4">
          <Trophy size={28} className="animate-pulse" />
          <div className="text-center">
            <p className="font-bold text-xl mb-1">🎉 You're in the Winner's List! 🎉</p>
            <p className="text-sm text-white/90">
              {spinResult.isWinner !== null
                ? spinResult.isWinner
                  ? 'Congratulations! You won! Check your orders.'
                  : 'Better luck next time! Try again tomorrow.'
                : 'Results will be announced soon. Come back to see if you won!'}
            </p>
          </div>
        </div>

        {/* Info Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
          {/* Next Spin Timer */}
          <motion.div
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.2 }}
            className="bg-white/20 backdrop-blur-sm rounded-lg p-3"
          >
            <div className="flex items-center gap-2 mb-1">
              <Clock size={18} />
              <p className="font-semibold text-sm">Next Spin Available</p>
            </div>
            <p className="text-lg font-bold">{timeRemaining}</p>
            <p className="text-xs text-white/80">Spin again to get new exclusive discounts!</p>
          </motion.div>

          {/* Winner Selection */}
          <motion.div
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.3 }}
            className="bg-white/20 backdrop-blur-sm rounded-lg p-3"
          >
            <div className="flex items-center gap-2 mb-1">
              <Users size={18} />
              <p className="font-semibold text-sm">Winner Selection</p>
            </div>
            <p className="text-lg font-bold">2,350 Winners</p>
            <p className="text-xs text-white/80">You're in the draw! Results coming soon.</p>
          </motion.div>
        </div>

        {/* Additional Info */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4 }}
          className="bg-white/15 backdrop-blur-sm rounded-lg p-4 space-y-2"
        >
          <div className="flex items-start gap-2">
            <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
            <div className="text-sm">
              <p className="font-semibold mb-1">🎁 What's Next?</p>
              <ul className="space-y-1 text-white/90 text-xs">
                <li>• <strong>2,350 lucky winners</strong> will receive their orders at the exclusive discount price</li>
                <li>• Come back in <strong>{timeRemaining}</strong> to spin again and win amazing prizes</li>
                <li>• Next spin could win you <strong>ALL products at $0.00</strong> - 100% FREE!</li>
                <li>• Check back regularly to see if you're one of the winners</li>
              </ul>
            </div>
          </div>
        </motion.div>

        {/* Call to Action */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.5 }}
          className="mt-4 text-center"
        >
          <p className="text-sm font-semibold">
            ⏰ Set a reminder to come back in {timeRemaining} for your next chance to win!
          </p>
        </motion.div>
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: -20 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-gradient-to-r from-green-500 to-emerald-600 text-white p-4 rounded-xl shadow-lg mb-6"
    >
      <div className="flex flex-col md:flex-row items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Trophy size={32} className="flex-shrink-0" />
          <div>
            <p className="font-bold text-lg">
              🎉 You Won: {getDiscountText()}
            </p>
            <p className="text-sm text-white/90">
              Select up to 3 products at this special price!
            </p>
          </div>
        </div>

        <div className="flex items-center gap-6 text-sm">
          <div className="flex items-center gap-2">
            <Users size={18} />
            <span>{selectedCount}/3 Selected</span>
          </div>
          <div className="flex items-center gap-2">
            <Clock size={18} />
            <span>{getTimeRemaining()} left</span>
          </div>
        </div>
      </div>

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.3 }}
        className="mt-3 p-3 bg-white/20 rounded-lg backdrop-blur-sm"
      >
        <div className="flex items-start gap-2 text-sm">
          <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
          <p>
            <strong>Note:</strong> Many people are shopping now! and you can also be the winner to win these all products in this discounted price. Complete your checkout to enter the draw!
          </p>
        </div>
      </motion.div>
    </motion.div>
  );
}
