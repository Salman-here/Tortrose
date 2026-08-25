const axios = require('axios');
const mailConfig = require('../config/mail');

/**
 * Send a transactional email via Brevo API
 *
 * Expected data:
 * {
 *   "to": "recipient@example.com",
 *   "subject": "Subject here",
 *   "text": "Plain text version",  (optional)
 *   "html": "<b>HTML version</b>"
 * }
 */
exports.sendEmail = async (data) => {
    const { to, subject, text, html } = data;

    if (!mailConfig.isConfigured) {
        throw new Error('Email service not configured. Please set BREVO_API_KEY in your .env file.');
    }

    console.log('📧 Sending email via Brevo to:', to);

    const payload = {
        sender: mailConfig.BREVO_SENDER,
        to: [{ email: to }],
        subject: subject,
        htmlContent: html
    };

    if (text) {
        payload.textContent = text;
    }

    try {
        const response = await axios.post(mailConfig.BREVO_API_URL, payload, {
            headers: {
                'accept': 'application/json',
                'content-type': 'application/json',
                'api-key': mailConfig.BREVO_API_KEY
            },
            // Keep provider calls comfortably inside the notification outbox
            // lease. An unbounded socket wait could otherwise let another
            // worker reclaim the row while this request is still in flight.
            timeout: 20_000,
            maxBodyLength: 1_000_000,
            maxContentLength: 1_000_000,
        });

        console.log('✅ Email sent successfully via Brevo, messageId:', response.data?.messageId);

        return {
            success: true,
            service: 'brevo',
            messageId: response.data?.messageId
        };
    } catch (error) {
        const errMsg = error.response?.data?.message || error.message;
        console.error('❌ Brevo email error:', errMsg);
        throw new Error(`Failed to send email via Brevo: ${errMsg}`);
    }
};
