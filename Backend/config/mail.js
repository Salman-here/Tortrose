require('dotenv').config();

// Brevo (formerly Sendinblue) configuration
// API key stored in BREVO_API_KEY environment variable
const BREVO_API_KEY = process.env.BREVO_API_KEY;
const BREVO_API_URL = process.env.BREVO_API_URL || 'https://api.brevo.com/v3/smtp/email';

const BREVO_SENDER = {
    name: process.env.BREVO_SENDER_NAME,
    email: process.env.BREVO_SENDER_EMAIL
};

if (BREVO_API_KEY && BREVO_SENDER.name && BREVO_SENDER.email) {
    console.log('✅ Brevo email service configured');
} else {
    console.warn('⚠️  Brevo email not fully configured - check BREVO_API_KEY, BREVO_SENDER_NAME, BREVO_SENDER_EMAIL in .env');
}

module.exports = {
    BREVO_API_KEY,
    BREVO_API_URL,
    BREVO_SENDER,
    isConfigured: !!(BREVO_API_KEY && BREVO_SENDER.name && BREVO_SENDER.email)
};