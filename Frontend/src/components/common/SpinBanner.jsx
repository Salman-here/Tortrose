/* SPIN WHEEL DISABLED
import { motion } from 'framer-motion';
import { Users, Clock, Trophy, AlertCircle, Gift, Sparkles } from 'lucide-react';
import { useCurrency } from '../../contexts/CurrencyContext';

export default function SpinBanner({ spinResult, selectedCount = 0, onOpenSpinner }) {
  const { formatPrice } = useCurrency();
  // Show "Spin to Win" banner if no spin result yet
  if (!spinResult) {
    return (
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-gradient-to-r from-purple-600 via-pink-600 to-orange-600 text-white p-4 rounded-xl shadow-lg mb-6 w-full max-w-full overflow-hidden"
      >
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <Gift size={32} className="flex-shrink-0 animate-bounce" />
            <div className="min-w-0">
              <p className="font-black text-lg sm:text-xl mb-1">
                🎉 SPIN THE WHEEL & WIN BIG! 🎉
              </p>
              <p className="text-xs sm:text-sm text-white/90">
                Get exclusive discounts up to <span className="font-bold">100% OFF</span> on 3 products!
              </p>
            </div>
          </div>
          
          <motion.button
            onClick={onOpenSpinner}
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            className="bg-white text-purple-600 font-bold text-sm sm:text-base px-6 py-3 rounded-full shadow-lg hover:shadow-xl transition-all flex items-center gap-2 whitespace-nowrap"
          >
            <Sparkles size={18} />
            SPIN NOW
            <Sparkles size={18} />
          </motion.button>
        </div>
        
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.2 }}
          className="mt-3 p-3 bg-white/20 rounded-lg backdrop-blur-sm"
        >
          <div className="flex items-start gap-2 text-xs sm:text-sm">
            <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
            <p className="break-words">
              <strong>Limited Time Offer:</strong> Spin once every 24 hours for a chance to win amazing discounts! Prizes include FREE products, {formatPrice(0.99)} deals, and up to 99% OFF!
            </p>
          </div>
        </motion.div>
      </motion.div>
    );
  }

  const getDiscountText = () => {
    if (spinResult.type === 'free') {
      return 'FREE';
    } else if (spinResult.type === 'fixed') {
      return formatPrice(spinResult.value);
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
        className="bg-gradient-to-r from-purple-600 via-indigo-600 to-purple-600 text-white p-4 sm:p-6 rounded-xl shadow-lg mb-6 w-full max-w-full overflow-hidden"
      >
        {/* Main Message */}
        <div className="flex items-center justify-center gap-2 sm:gap-3 mb-4">
          <Trophy size={24} className="animate-pulse flex-shrink-0 sm:w-7 sm:h-7" />
          <div className="text-center">
            <p className="font-bold text-base sm:text-xl mb-1">🎉 You're in the Winner's List! 🎉</p>
            <p className="text-xs sm:text-sm text-white/90">
              {spinResult.isWinner !== null
                ? spinResult.isWinner
                  ? 'Congratulations! You won! Check your orders.'
                  : 'Better luck! Come tommorow to see if you have won... and you can everyday spin the wheel to win discounts!!'
                : 'Results will be announced soon. Come back to see if you won!'}
            </p>
          </div>
        </div>

        {/* Info Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
          {/* Next Spin Timer */}
          <motion.div
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.2 }}
            className="bg-white/20 backdrop-blur-sm rounded-lg p-3 min-w-0"
          >
            <div className="flex items-center gap-2 mb-1">
              <Clock size={16} className="flex-shrink-0 sm:w-[18px] sm:h-[18px]" />
              <p className="font-semibold text-xs sm:text-sm truncate">Next Spin Available</p>
            </div>
            <p className="text-base sm:text-lg font-bold">{timeRemaining}</p>
            <p className="text-xs text-white/80">Spin again to get new exclusive discounts!</p>
          </motion.div>

          {/* Winner Selection */}
          <motion.div
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.3 }}
            className="bg-white/20 backdrop-blur-sm rounded-lg p-3 min-w-0"
          >
            <div className="flex items-center gap-2 mb-1">
              <Users size={16} className="flex-shrink-0 sm:w-[18px] sm:h-[18px]" />
              <p className="font-semibold text-xs sm:text-sm truncate">Winner Selection</p>
            </div>
            <p className="text-base sm:text-lg font-bold">2,350 Winners</p>
            <p className="text-xs text-white/80">You're in the draw! Results coming soon.</p>
          </motion.div>
        </div>

        {/* Additional Info */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4 }}
          className="bg-white/15 backdrop-blur-sm rounded-lg p-3 sm:p-4 space-y-2"
        >
          <div className="flex items-start gap-2">
            <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
            <div className="text-xs sm:text-sm min-w-0">
              <p className="font-semibold mb-1">🎁 What's Next?</p>
              <ul className="space-y-1 text-white/90 text-xs break-words">
                <li>• <strong>2,350 lucky winners</strong> will receive their orders at the exclusive discount price</li>
                <li>• Come back in <strong>{timeRemaining}</strong> to spin again and win amazing prizes</li>
                <li>• Next spin could win you <strong>ALL products at {formatPrice(0)}</strong> - 100% FREE!</li>
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
          <p className="text-xs sm:text-sm font-semibold break-words">
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
      className="bg-gradient-to-r from-green-500 to-emerald-600 text-white p-4 rounded-xl shadow-lg mb-6 w-full max-w-full overflow-hidden"
    >
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3 sm:gap-4">
        <div className="flex items-center gap-2 sm:gap-3 min-w-0 w-full sm:w-auto">
          <Trophy size={28} className="flex-shrink-0 sm:w-8 sm:h-8" />
          <div className="min-w-0">
            <p className="font-bold text-base sm:text-lg truncate">
              🎉 You Won: {getDiscountText()}
            </p>
            <p className="text-xs sm:text-sm text-white/90">
              Select up to 3 products at this special price!
            </p>
          </div>
        </div>

        <div className="flex items-center gap-4 sm:gap-6 text-xs sm:text-sm flex-shrink-0">
          <div className="flex items-center gap-2">
            <Users size={16} className="sm:w-[18px] sm:h-[18px]" />
            <span className="whitespace-nowrap">{selectedCount}/3 Selected</span>
          </div>
          <div className="flex items-center gap-2">
            <Clock size={16} className="sm:w-[18px] sm:h-[18px]" />
            <span className="whitespace-nowrap">{getTimeRemaining()} left</span>
          </div>
        </div>
      </div>

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.3 }}
        className="mt-3 p-3 bg-white/20 rounded-lg backdrop-blur-sm"
      >
        <div className="flex items-start gap-2 text-xs sm:text-sm">
          <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
          <p className="break-words">
            <strong>Note:</strong> Many people are shopping now! and you can also be the winner to win these all products in this discounted price. Complete your checkout to enter the draw!
          </p>
        </div>
      </motion.div>
    </motion.div>
  );
}
SPIN WHEEL DISABLED */
