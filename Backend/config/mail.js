const nodemailer = require('nodemailer');
require('dotenv').config();

console.log('=== MAIL CONFIG LOADING ===');
console.log('EMAIL_USER:', process.env.EMAIL_USER ? 'Set' : 'NOT SET');
console.log('EMAIL_PASS:', process.env.EMAIL_PASS ? 'Set' : 'NOT SET');

// CREATING TRANSPORTER FOR GMAIL SMTP with explicit configuration
// Using port 587 with STARTTLS which works better on Railway
const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false, // true for 465, false for other ports
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    },
    tls: {
        rejectUnauthorized: false // Allow self-signed certificates
    },
    // Increased timeout settings for production
    connectionTimeout: 30000, // 30 seconds
    greetingTimeout: 30000,
    socketTimeout: 30000
});

console.log('Transporter created with explicit SMTP settings (port 587)');

// VERIFICATION OF SMTP CONNECTION
transporter.verify((error, success) => {
    if (error) {
        console.log('❌ SMTP connection error:', error);
        console.log('Error message:', error.message);
    } else {
        console.log('✅ SMTP server is ready to send emails');
    }
});

module.exports = transporter;