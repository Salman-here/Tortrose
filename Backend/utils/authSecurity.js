'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const AUTH_TOKEN_TTL = '7d';

const generateSixDigitOTP = () => crypto.randomInt(100000, 1000000).toString();

const signAuthToken = (payload, secret = process.env.JWT_SECRET) => {
    if (!secret) throw new Error('JWT_SECRET is required to issue an authentication token');
    return jwt.sign(payload, secret, { expiresIn: AUTH_TOKEN_TTL });
};

module.exports = {
    AUTH_TOKEN_TTL,
    generateSixDigitOTP,
    signAuthToken,
};
