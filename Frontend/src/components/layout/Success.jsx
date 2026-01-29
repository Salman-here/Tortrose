import axios from "axios";
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { CheckCircle, Mail, CreditCard, DollarSign } from "lucide-react";
import { Link } from "react-router-dom";
import { toast } from "react-toastify";
import { useGlobal } from "../../contexts/GlobalContext";

export default function Success() {
    const [session, setSession] = useState(null);

    

    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const sessionId = params.get("session_id");

        if (sessionId) {
            fetchSession(sessionId);
        }
        // window.location.reload()
        // fetchCart()
    }, []);

    const fetchSession = async (sessionId) => {
        try {
            const res = await axios.get(`${import.meta.env.VITE_API_URL}api/session/${sessionId}`);
            const sessionData = res.data?.session;
            setSession(sessionData);
            
            // Track purchase with GSM
            if (sessionData && window.GSM) {
                window.GSM.trackPurchase({
                    orderId: sessionData.metadata?.orderId || sessionData.id,
                    amount: sessionData.amount_total / 100,
                    customerEmail: sessionData.customer_details?.email
                });
            }
        } catch (error) {
            console.error(error);
            toast.error(error.response?.data?.msg)
        }
    };

    return (
        <div className="flex justify-center items-center min-h-screen bg-gradient-to-br from-white via-gray-50 to-gray-100 px-4">
            <motion.div
                className="bg-white shadow-2xl rounded-2xl p-8 max-w-lg w-full text-center"
                initial={{ opacity: 0, scale: 0.8, y: 40 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                transition={{ duration: 0.6, ease: "easeOut" }}
            >
                <motion.div
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    transition={{ type: "spring", stiffness: 100, delay: 0.3 }}
                    className="flex justify-center mb-6"
                >
                    <CheckCircle className="w-20 h-20 text-green-500" />
                </motion.div>

                <h1 className="text-3xl font-bold text-gray-800 mb-4">
                    Thank you for your order!
                </h1>
                <p className="text-gray-500 mb-8">
                    Your payment was processed successfully. A confirmation has been sent
                    to your email.
                </p>

                {session && (
                    <motion.div
                        className="space-y-4 text-left"
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.5, delay: 0.5 }}
                    >
                        <div className="flex items-center bg-gray-50 p-3 rounded-xl shadow-sm">
                            <CreditCard className="w-5 h-5 text-indigo-500 mr-3" />
                            <p className="text-gray-700">
                                <span className="font-semibold">Payment Status:</span>{" "}
                                {session.payment_status}
                            </p>
                        </div>

                        <div className="flex items-center bg-gray-50 p-3 rounded-xl shadow-sm">
                            <Mail className="w-5 h-5 text-indigo-500 mr-3" />
                            <p className="text-gray-700">
                                <span className="font-semibold">Customer:</span>{" "}
                                {session.customer_details.email}
                            </p>
                        </div>

                        <div className="flex items-center bg-gray-50 p-3 rounded-xl shadow-sm">
                            <DollarSign className="w-5 h-5 text-indigo-500 mr-3" />
                            <p className="text-gray-700">
                                <span className="font-semibold">Total:</span>{" "}
                                {session.amount_total / 100} {session.currency.toUpperCase()}
                            </p>
                        </div>
                    </motion.div>
                )}

                <Link to={'/'}>
                    <motion.button

                        whileHover={{ scale: 1.05 }}
                        whileTap={{ scale: 0.95 }}
                        className="mt-8 px-6 py-3 bg-indigo-600 text-white rounded-xl font-medium shadow-lg hover:bg-indigo-700 transition"
                    >
                        Continue Shopping
                    </motion.button>
                </Link>
            </motion.div>
        </div>
    );
}
