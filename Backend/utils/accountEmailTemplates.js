'use strict';

const { escapeHtml, renderTransactionalEmail } = require('./transactionalEmail');
const safeName = value => String(value ?? '').replace(/[\r\n\t\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);

const codeCard = (code, minutes) => `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" bgcolor="#f3f2ff" style="margin:22px 0;background:#f3f2ff;border:1px solid #dcd9ff;border-radius:14px;"><tr><td align="center" style="padding:22px 12px;">
  <div style="color:#6d6a97;font-size:11px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase;">Verification code</div>
  <div style="color:#312e81;font-size:34px;font-weight:800;letter-spacing:8px;font-family:Consolas,Monaco,monospace;margin:10px 0;">${escapeHtml(code)}</div>
  <div style="color:#665d89;font-size:12px;">Expires in ${minutes} minutes</div>
</td></tr></table>`;

const button = (label, url) => `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:24px 0;"><tr><td bgcolor="#0ea5e9" style="background:#0ea5e9;background-image:linear-gradient(110deg,#14b8a6,#0ea5e9,#6366f1);border-radius:12px;"><a href="${escapeHtml(url)}" style="display:inline-block;padding:14px 22px;color:#ffffff;text-decoration:none;font-size:14px;font-weight:700;">${escapeHtml(label)}</a></td></tr></table>`;

const verificationCodeEmail = ({ name, code, purpose, expiresMinutes }) => {
  const content = {
    buyer_signup: {
      subject: 'Verify your Rozare email',
      intro: 'Enter this code on Rozare to confirm your email address and finish creating your account.',
      unrequested: 'If you did not create a Rozare account, you can ignore this message.',
    },
    seller_signup: {
      subject: 'Verify your Rozare seller email',
      intro: 'Enter this code on Rozare to confirm your email address and continue seller setup.',
      unrequested: 'If you did not start seller registration, you can ignore this message.',
    },
    email_change: {
      subject: 'Verify your new Rozare email',
      intro: 'Enter this code on Rozare to confirm this new email address for your seller account.',
      unrequested: 'If you did not request this change, do not use the code. Contact support if you have concerns about your account.',
    },
  }[purpose];
  if (!content || !Number.isInteger(expiresMinutes) || expiresMinutes < 1) throw new Error('Invalid email verification purpose or expiry.');
  const displayName = safeName(name);
  const greeting = displayName ? `Hi ${escapeHtml(displayName)},` : 'Hello,';
  const body = `<p style="margin:0 0 14px;">${greeting}</p><p style="margin:0;">${content.intro}</p>${codeCard(code, expiresMinutes)}<p style="font-size:13px;color:#64748b;">${content.unrequested} Never share this code. Rozare support will not ask for it.</p>`;
  return {
    subject: content.subject,
    text: `${displayName ? `Hi ${displayName},\n\n` : ''}${content.intro}\n\nVerification code: ${code}\nExpires in ${expiresMinutes} minutes.\n\n${content.unrequested} Never share this code. Rozare support will not ask for it.`,
    html: renderTransactionalEmail({ title: content.subject, body, preheader: 'Your one-time Rozare verification code' }),
  };
};

const passwordResetEmail = ({ name, resetUrl }) => {
  const subject = 'Reset your Rozare password';
  const body = `<p style="margin:0 0 14px;">Hello ${escapeHtml(safeName(name) || 'there')},</p><p style="margin:0;">We received a request to reset your Rozare password. Use the secure button below within one hour.</p>${button('Reset password', resetUrl)}<p style="font-size:13px;color:#64748b;">If you did not request this, you can ignore this email. Your password will stay the same. Never share the reset link with anyone.</p>`;
  return { subject, text: `We received a request to reset your Rozare password. This link expires in one hour:\n${resetUrl}\n\nIf you did not request this, you can ignore this email. Never share the link.`, html: renderTransactionalEmail({ title: subject, body, preheader: 'A secure link to reset your Rozare password' }) };
};

const passwordChangedEmail = ({ name, loginUrl }) => {
  const subject = 'Your Rozare password was changed';
  const body = `<p style="margin:0 0 14px;">Hello ${escapeHtml(safeName(name) || 'there')},</p><p style="margin:0;">The password for your Rozare account was changed.</p>${button('Sign in to Rozare', loginUrl)}<p style="font-size:13px;color:#64748b;">If this was not you, contact <a href="mailto:support@rozare.com" style="color:#4f46e5;">support@rozare.com</a> immediately so we can help secure your account.</p>`;
  return { subject, text: `Your Rozare password was changed.\n\nSign in: ${loginUrl}\n\nIf this was not you, contact support@rozare.com immediately.`, html: renderTransactionalEmail({ title: subject, body, preheader: 'A security update for your Rozare account' }) };
};

module.exports = { passwordChangedEmail, passwordResetEmail, verificationCodeEmail };
