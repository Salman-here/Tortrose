import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AlertTriangle, RefreshCw, Home, Mail, X, ChevronDown, ChevronUp } from 'lucide-react';

const ErrorPage = ({
    errorCode = 404,
    errorMessage = "Page not found",
    description = ""
}) => {
    const [showDetails, setShowDetails] = useState(false);

    const handleRetry = () => {
        window.location.reload();
    };

    const handleGoHome = () => {
        // In a real app, you would use your router here
        window.location.href = '/';
    };

    const handleContactSupport = () => {
        window.location.href = 'mailto:support@example.com';
    };

    // Animation variants
    const containerVariants = {
        hidden: { opacity: 0 },
        visible: {
            opacity: 1,
            transition: {
                when: "beforeChildren",
                staggerChildren: 0.2
            }
        }
    };

    const itemVariants = {
        hidden: { y: 20, opacity: 0 },
        visible: {
            y: 0,
            opacity: 1,
            transition: {
                type: "spring",
                damping: 12,
                stiffness: 200
            }
        }
    };

    const iconVariants = {
        hidden: { scale: 0, rotate: -180 },
        visible: {
            scale: 1,
            rotate: 0,
            transition: {
                type: "spring",
                damping: 10,
                stiffness: 200,
                duration: 0.5
            }
        },
        hover: {
            scale: 1.1,
            rotate: 10,
            transition: {
                type: "spring",
                damping: 10,
                stiffness: 300
            }
        },
        tap: { scale: 0.95 }
    };

    return (
        <div className="h flex items-center justify-center p-4">
            <motion.div
                className="bg-white rounded-2xl shadow-xl p-6 md:p-8 w-full max-w-md"
                variants={containerVariants}
                initial="hidden"
                animate="visible"
            >
                {/* Error Icon */}
                <motion.div
                    className="flex justify-center mb-6"
                    variants={iconVariants}
                    whileHover="hover"
                    whileTap="tap"
                >
                    <div className="p-4 bg-red-100 rounded-full">
                        <AlertTriangle className="h-16 w-16 text-red-500" />
                    </div>
                </motion.div>

                {/* Error Code */}
                <motion.h1
                    className="text-8xl font-bold text-center text-gray-800 mb-2"
                    variants={itemVariants}
                >
                    {errorCode}
                </motion.h1>

                {/* Error Message */}
                <motion.p
                    className="text-xl text-center text-gray-600 mb-4"
                    variants={itemVariants}
                >
                    {errorMessage}
                </motion.p>

                {/* Description */}
                <motion.p
                    className="text-gray-500 text-center mb-8"
                    variants={itemVariants}
                >
                    {description}
                </motion.p>

                {/* Action Buttons */}
                <motion.div
                    className="flex flex-col sm:flex-row gap-3 justify-center mb-6"
                    variants={itemVariants}
                >
                    <motion.button
                        className="flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-2 px-4 rounded-lg transition-colors"
                        onClick={handleRetry}
                        whileHover={{ scale: 1.05 }}
                        whileTap={{ scale: 0.95 }}
                    >
                        <RefreshCw size={18} />
                        <span>Try Again</span>
                    </motion.button>

                    <motion.button
                        className="flex items-center justify-center gap-2 bg-gray-100 hover:bg-gray-200 text-gray-800 font-medium py-2 px-4 rounded-lg transition-colors"
                        onClick={handleGoHome}
                        whileHover={{ scale: 1.05 }}
                        whileTap={{ scale: 0.95 }}
                    >
                        <Home size={18} />
                        <span>Go Home</span>
                    </motion.button>
                </motion.div>

                {/* Support Link */}
                <motion.div
                    className="text-center mb-6"
                    variants={itemVariants}
                >
                    <button
                        onClick={handleContactSupport}
                        className="text-indigo-600 hover:text-indigo-800 inline-flex items-center gap-1"
                    >
                        <Mail size={16} />
                        <span>Contact support</span>
                    </button>
                </motion.div>

                {/* Error Details Toggle */}
                <motion.div variants={itemVariants}>
                    <button
                        onClick={() => setShowDetails(!showDetails)}
                        className="w-full flex items-center justify-between p-3 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors"
                    >
                        <span className="text-sm font-medium text-gray-700">Technical details</span>
                        {showDetails ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
                    </button>
                </motion.div>

                {/* Error Details */}
                <AnimatePresence>
                    {showDetails && (
                        <motion.div
                            className="mt-4 bg-gray-50 rounded-lg overflow-hidden"
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: "auto" }}
                            exit={{ opacity: 0, height: 0 }}
                            transition={{ duration: 0.3 }}
                        >
                            <div className="p-4">
                                <div className="flex justify-between items-center mb-3">
                                    <h3 className="font-medium text-gray-800">Error Information</h3>
                                    <button
                                        onClick={() => setShowDetails(false)}
                                        className="text-gray-500 hover:text-gray-700"
                                    >
                                        <X size={16} />
                                    </button>
                                </div>
                                <div className="text-sm space-y-2">
                                    <p><span className="font-medium">Error Code:</span> {errorCode}</p>
                                    <p><span className="font-medium">Message:</span> {errorMessage}</p>
                                    <p><span className="font-medium">Timestamp:</span> {new Date().toLocaleString()}</p>
                                    <p><span className="font-medium">Page URL:</span> {window.location.href}</p>
                                </div>
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>
            </motion.div>
        </div>
    );
};

export default ErrorPage;