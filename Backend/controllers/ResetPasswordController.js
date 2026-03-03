const crypto = require('crypto');
const bcrypt = require('bcrypt')
const asyncHandler = require('express-async-handler');
const User = require('../models/User');
const { sendEmail } = require('./mailController');

exports.forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body;
  console.log('forgot password email:', email);

  const user = await User.findOne({ email })
  if (!user) {
    // const error = new Error('User not found');
    // error.statusCode = 404;
    // throw error;
    return res.status(404).json({ msg: 'user not found' })
  }

  const resetToken = user.getResetPasswordToken()
  console.log('resetToken:', resetToken);

  await user.save()

  const resetURL = `${process.env.FRONTEND_URL}/reset-password/${resetToken}`

  console.log(req.get('host'));

  const message = `
        You requested a password reset. Click the link below to reset your password:
        ${resetURL}
        If you did not request this, please ignore this email.
    `;

  // === HTML Template ===
  const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
      <title>Reset Password</title>
      <style>
        body {
          background-color: #F8F9FA;
          font-family: 'Inter', 'Lato', 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
          color: #1A1A1A;
          line-height: 1.6;
          font-size: 16px;
        }
        .email-wrapper {
          max-width: 600px;
          margin: 0 auto;
          padding: 1.5rem;
        }
        .card {
          background-color: #FFFFFF;
          border-radius: 16px;
          box-shadow: 0 10px 25px rgba(0, 0, 0, 0.05);
          padding: 2rem;
        }
        .header {
          background-color: #2563EB;
          color: #ffffff;
          padding: 1rem 2rem;
          border-radius: 12px 12px 0 0;
          font-family: 'Poppins', sans-serif;
          font-size: 1.25rem;
          font-weight: 600;
          text-align: center;
        }
        .content {
          padding: 1.5rem 0;
        }
        .content p {
          margin: 1rem 0;
        }
        .button {
          display: inline-block;
          margin-top: 1.5rem;
          background-color: #2563EB;
          
          padding: 0.75rem 1.5rem;
          border-radius: 8px;
          text-decoration: none;
          font-weight: 500;
          transition: background-color 0.3s ease;
        }
        .button:hover {
          background-color: #1E40AF;
        }
        .footer {
          font-size: 14px;
          text-align: center;
          color: #6B7280;
          margin-top: 2rem;
        }
      </style>
    </head>
    <body>
      <div class="email-wrapper">
        <div class="card">
          <div class="header">Reset Your Password</div>
          <div class="content">
            <p>Hello ${user.username || 'there'},</p>
            <p>You requested to reset your password. Click the button below to choose a new one:</p>
            <p style="text-align: center;">
              <a href="${resetURL}" class="button" style="color: white;">Reset Password</a>
            </p>
            <p>If you didn’t request a password reset, you can safely ignore this email.</p>
            <p>Thanks,<br/>The Tortrose Team</p>
          </div>
        </div>
        <div class="footer">
          &copy; ${new Date().getFullYear()} Tortrose. All rights reserved.
        </div>
      </div>
    </body>
    </html>
    `;


  try {
    await sendEmail({
      to: user.email,
      subject: 'Password reset instructions',
      text: message,
      html: html
    })
    res.status(200).json({ msg: 'Password reset link sent' })
  } catch (error) {
    user.resetPasswordToken = undefined;
    user.resetPasswordExpire = undefined;
    await user.save();
    res.status(500).json({ msg: 'error sending password reset link' })
  }


});

exports.resetPassword = asyncHandler(async (req, res) => {
  const { token } = req.params;
  const { password } = req.body;

  const hashedToken = crypto.createHash('sha256').update(token).digest('hex');
  const user = await User.findOne({
    resetPasswordToken: hashedToken,
    resetPasswordTokenExpiry: { $gt: Date.now() }
  });

  if (!user) return res.status(409).json({ msg: 'Token is invalid or expired.' })
  user.password = password
  user.resetPasswordToken = undefined
  user.resetPasswordTokenExpiry = undefined

  await user.save()

  const goToAuthUrl = `${process.env.FRONTEND_URL}/auth`

  const message = `
        Your password has been successfully changed.
        Click here to login
        ${goToAuthUrl}
        If you did not request this, please ignore this email.
    `;

  // === HTML Template ===
  const html = `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
    <title>Password Changed</title>
    <style>
      body {
        background-color: #F8F9FA;
        font-family: 'Inter', 'Lato', 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
        color: #1A1A1A;
        line-height: 1.6;
        font-size: 16px;
      }
      .email-wrapper {
        max-width: 600px;
        margin: 0 auto;
        padding: 1.5rem;
      }
      .card {
        background-color: #FFFFFF;
        border-radius: 16px;
        box-shadow: 0 10px 25px rgba(0, 0, 0, 0.05);
        padding: 2rem;
      }
      .header {
        background-color: #16A34A; /* green */
        color: #ffffff;
        padding: 1rem 2rem;
        border-radius: 12px 12px 0 0;
        font-family: 'Poppins', sans-serif;
        font-size: 1.25rem;
        font-weight: 600;
        text-align: center;
      }
      .content {
        padding: 1.5rem 0;
      }
      .content p {
        margin: 1rem 0;
      }
      .footer {
        font-size: 14px;
        text-align: center;
        color: #6B7280;
        margin-top: 2rem;
      }
        .button {
          display: inline-block;
          margin-top: 1.5rem;
          background-color: #16A34A;
          
          padding: 0.75rem 1.5rem;
          border-radius: 8px;
          text-decoration: none;
          font-weight: 500;
          transition: background-color 0.3s ease;
        }
        .button:hover {
          background-color: #1E40AF;
        }
    </style>
  </head>
  <body>
    <div class="email-wrapper">
      <div class="card">
        <div class="header">Password Changed Successfully</div>
        <div class="content">
          <p>Hello ${user.username || 'there'},</p>
          <p>This is a confirmation that your password has been successfully changed.</p>
          <p style="text-align: center;">
              <a href="${goToAuthUrl}" class="button" style="color: white;">Login now!</a>
            </p>
          <p>If you did not make this change or believe an unauthorized person has accessed your account, please contact our support team immediately.</p>
          <p>Stay safe,<br/>The Tortrose Team</p>
        </div>
      </div>
      <div class="footer">
        &copy; ${new Date().getFullYear()} Tortrose. All rights reserved.
      </div>
    </div>
  </body>
  </html>
`;



  await sendEmail({
    to: user.email,
    subject: 'Password successfully changed.',
    text: message,
    html: html
  })


  res.status(200).json({ msg: 'Password has been successfully changed.' })
});


exports.changePassword = async (req, res) => {
  const { id } = req.user
  const { currentPassword, newPassword, confirmPassword } = req.body
  if (!currentPassword || !newPassword || !confirmPassword) return res.status(400).json({ msg: 'Credentials not provided properly' })

  const user = await User.findById(id)

  if (!user) return res.status(404).json({ msg: 'User not found' })
  const isMatched = await bcrypt.compare(currentPassword, user.password)
  if (!isMatched) return res.status(400).json({ msg: "Current password doesn't match." })
  if (newPassword !== confirmPassword) return res.status(400).json({ msg: "New password and confirm password doesn't match." })

  user.password = newPassword

  await user.save()


  return res.status(200).json({ msg: 'Your password has been changed successfully' })



}