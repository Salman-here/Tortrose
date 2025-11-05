// Alternative email configuration using Resend API
// Resend is free for 3,000 emails/month and works great on Railway
// Sign up at: https://resend.com
// Get your API key from: https://resend.com/api-keys

const axios = require('axios');
require('dotenv').config();

const sendEmailWithResend = async ({ to, subject, text, html }) => {
    try {
        const response = await axios.post(
            'https://api.resend.com/emails',
            {
                from: 'genZ Winners <onboarding@resend.dev>', // Use your verified domain or resend.dev for testing
                to: [to],
                subject: subject,
                html: html || text,
            },
            {
                headers: {
                    'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
                    'Content-Type': 'application/json',
                },
            }
        );

        console.log('✅ Email sent successfully via Resend');
        console.log('Email ID:', response.data.id);
        
        return {
            success: true,
            messageId: response.data.id
        };
    } catch (error) {
        console.error('❌ Resend email error:', error.response?.data || error.message);
        throw new Error(`Failed to send email via Resend: ${error.response?.data?.message || error.message}`);
    }
};

module.exports = { sendEmailWithResend };
