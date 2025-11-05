// Email controller using Resend API (backup for when SMTP doesn't work)
const { sendEmailWithResend } = require("../config/mail-resend");

exports.sendEmail = async (data) => {
    const { to, subject, text, html } = data;

    try {
        const result = await sendEmailWithResend({ to, subject, text, html });
        
        console.log('✅ Email sent successfully to:', to);
        
        return result;
    } catch (error) {
        console.error("❌ Error sending email:", error);
        console.error("Error details:", error.message);
        
        // Throw the error so it can be caught by the calling function
        throw new Error(`Failed to send email: ${error.message}`);
    }
};
