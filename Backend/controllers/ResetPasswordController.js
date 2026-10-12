const crypto = require('crypto');
const bcrypt = require('bcrypt')
const asyncHandler = require('express-async-handler');
const User = require('../models/User');
const { sendEmail } = require('./mailController');
const { passwordChangedEmail, passwordResetEmail } = require('../utils/accountEmailTemplates');

exports.forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body;

  const user = await User.findOne({ email })
  if (!user) {
    // const error = new Error('User not found');
    // error.statusCode = 404;
    // throw error;
    return res.status(404).json({ msg: 'user not found' })
  }

  const resetToken = user.getResetPasswordToken()

  await user.save()

  const resetURL = `${process.env.FRONTEND_URL || 'https://rozare.com'}/reset-password/${resetToken}`

  const emailTemplate = passwordResetEmail({ name: user.username, resetUrl: resetURL });

  try {
    await sendEmail({
      to: user.email,
      ...emailTemplate
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

  const goToAuthUrl = `${process.env.FRONTEND_URL || 'https://rozare.com'}/login`

  const emailTemplate = passwordChangedEmail({ name: user.username, loginUrl: goToAuthUrl });


  await sendEmail({
    to: user.email,
    ...emailTemplate
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
