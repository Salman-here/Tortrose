const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const User = require("../models/User");
const dotenv = require('dotenv')
dotenv.config()

if (process.env.clientID && process.env.clientSecret && process.env.GOOGLE_CALLBACK_URL) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: process.env.clientID,
        clientSecret: process.env.clientSecret,
        callbackURL: process.env.GOOGLE_CALLBACK_URL,
      },
    async (accessToken, refreshToken, profile, done) => {
      try {
        // Check if user already exists
        let user = await User.findOne({ email: profile.emails[0].value });
        
        if (!user) {
          // If not, create one (password null because Google handles it)
          user = await User.create({
            username: profile.displayName,
            email: profile.emails[0].value,
            avatar: profile.photos[0].value,
            profilePicture: profile.photos[0].value,
            password: null,
            isVerified: true,
          });
        } else if (user.status === 'blocked') {
          // Return the live account without mutating it. googleCallback reloads
          // status immediately before token issuance and redirects blocked
          // accounts without ever creating a JWT.
          return done(null, user);
        } else if (!user.avatar && user.profilePicture) {
          // Update existing user's avatar if they don't have one
          user.avatar = user.profilePicture;
          await user.save();
        }

        return done(null, user);
      } catch (error) {
        return done(error, null);
      }
    }
  )
);
} else {
  console.warn('⚠️ Google OAuth not configured - missing clientID, clientSecret, or GOOGLE_CALLBACK_URL');
}


// Serialize & deserialize
// passport.serializeUser((user, done) => {
//   done(null, user.id);
// });
// passport.deserializeUser(async (id, done) => {
//   try {
//     const user = await Schema.findById(id);
//     done(null, user);
//   } catch (error) {
//     done(error, null);
//   }
// });
