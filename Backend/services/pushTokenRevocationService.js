'use strict';

const crypto = require('crypto');
const User = require('../models/User');
const ExpoPushTokenRegistration = require('../models/ExpoPushTokenRegistration');

const hashValue = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const newCredential = () => crypto.randomBytes(32).toString('base64url');
const hashesMatch = (left, right) => {
    if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
    return crypto.timingSafeEqual(Buffer.from(left), Buffer.from(right));
};
const isCredentialShape = value => (
    typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
);

const invalidCredentialError = () => {
    const error = new Error('Invalid push-token revocation credential.');
    error.code = 'INVALID_PUSH_REVOCATION_CREDENTIAL';
    return error;
};

const registrationMatches = (registration, { userId, revocationHash }) => (
    registration
    && String(registration.user) === String(userId)
    && hashesMatch(registration.revocationHash, revocationHash)
    && !registration.revokedAt
);

async function registerPushToken(userId, pushToken, requestedCredential = null) {
    // The token-hash unique index is the ownership mutex. Await it before the
    // first production write so a cold deployment cannot accept two owners
    // while Mongoose is still creating indexes in the background.
    await ExpoPushTokenRegistration.init();
    const clientProvidedCredential = requestedCredential !== null && requestedCredential !== undefined;
    if (clientProvidedCredential && !isCredentialShape(requestedCredential)) {
        throw invalidCredentialError();
    }
    const credential = clientProvidedCredential ? requestedCredential : newCredential();
    const tokenHash = hashValue(pushToken);
    const revocationHash = hashValue(credential);
    const now = new Date();

    const registrationUpdate = {
        $set: {
            revocationHash,
            user: userId,
            revokedAt: null,
            rotatedAt: now,
        },
        $setOnInsert: { tokenHash },
    };
    try {
        await ExpoPushTokenRegistration.findOneAndUpdate(
            { tokenHash },
            registrationUpdate,
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );
    } catch (error) {
        // Two first-time account registrations for one installation can race
        // on the unique token hash. Retry as an ordinary rotation; final claim
        // verification below ensures there is still only one owner.
        if (error?.code !== 11000) throw error;
        await ExpoPushTokenRegistration.findOneAndUpdate(
            { tokenHash },
            { $set: registrationUpdate.$set },
            { new: true }
        );
    }

    // Ordered ownership transfer cleans legacy duplicates before subscribing
    // the current account.
    await User.updateMany(
        { _id: { $ne: userId }, expoPushTokens: pushToken },
        { $pull: { expoPushTokens: pushToken } }
    );
    const current = await User.updateOne(
        { _id: userId },
        { $addToSet: { expoPushTokens: pushToken } }
    );
    if (!current.matchedCount) {
        await ExpoPushTokenRegistration.updateOne(
            { tokenHash, user: userId, revocationHash },
            { $set: { revokedAt: new Date() } }
        );
        const error = new Error('User not found');
        error.code = 'PUSH_TOKEN_USER_NOT_FOUND';
        throw error;
    }

    // A concurrent account switch may rotate ownership after our first write.
    // Verify the final claim and remove this account's stale subscription if
    // another registration won the race.
    const finalRegistration = await ExpoPushTokenRegistration.findOne({ tokenHash })
        .select('+revocationHash user revokedAt')
        .lean();
    if (!registrationMatches(finalRegistration, { userId, revocationHash })) {
        await User.updateOne(
            { _id: userId },
            { $pull: { expoPushTokens: pushToken } }
        );
        if (finalRegistration?.user && !finalRegistration.revokedAt) {
            // A later claimant owns the installation. A losing claimant may
            // have pulled the winner's token after the winner completed its
            // own verification, so restore the authoritative final owner.
            await User.updateMany(
                { _id: { $ne: finalRegistration.user }, expoPushTokens: pushToken },
                { $pull: { expoPushTokens: pushToken } }
            );
            await User.updateOne(
                { _id: finalRegistration.user },
                { $addToSet: { expoPushTokens: pushToken } }
            );
        }
        const error = new Error('Push token ownership changed. Please retry registration.');
        error.code = 'PUSH_TOKEN_OWNERSHIP_CHANGED';
        throw error;
    }

    return { credential, clientProvidedCredential };
}

async function revokePushToken(pushToken, credential) {
    await ExpoPushTokenRegistration.init();
    if (!isCredentialShape(credential)) throw invalidCredentialError();
    const tokenHash = hashValue(pushToken);
    const revocationHash = hashValue(credential);

    let registration = await ExpoPushTokenRegistration.findOne({ tokenHash })
        .select('+revocationHash user revokedAt')
        .lean();
    if (!registration || !hashesMatch(registration.revocationHash, revocationHash)) {
        throw invalidCredentialError();
    }

    const alreadyRevoked = Boolean(registration.revokedAt);
    if (!alreadyRevoked) {
        registration = await ExpoPushTokenRegistration.findOneAndUpdate(
            { tokenHash, revocationHash, revokedAt: null },
            { $set: { revokedAt: new Date() } },
            { new: true }
        ).select('+revocationHash user revokedAt').lean();
        if (!registration) {
            const latest = await ExpoPushTokenRegistration.findOne({ tokenHash })
                .select('+revocationHash user revokedAt')
                .lean();
            if (!latest || !hashesMatch(latest.revocationHash, revocationHash)) throw invalidCredentialError();
            registration = latest;
        }
    }

    await User.updateMany(
        { expoPushTokens: pushToken },
        { $pull: { expoPushTokens: pushToken } }
    );

    // If authenticated registration rotated while revocation was executing,
    // the new credential wins. Restore the token only to that new owner.
    const latest = await ExpoPushTokenRegistration.findOne({ tokenHash })
        .select('+revocationHash user revokedAt')
        .lean();
    if (latest && latest.revocationHash !== revocationHash && !latest.revokedAt) {
        await User.updateOne(
            { _id: latest.user },
            { $addToSet: { expoPushTokens: pushToken } }
        );
    }

    return { alreadyRevoked };
}

async function unregisterPushTokenForUser(userId, pushToken) {
    await ExpoPushTokenRegistration.init();
    const tokenHash = hashValue(pushToken);
    await User.updateOne(
        { _id: userId },
        { $pull: { expoPushTokens: pushToken } }
    );
    await ExpoPushTokenRegistration.updateOne(
        { tokenHash, user: userId },
        { $set: { revokedAt: new Date() } }
    );
}

module.exports = {
    hashValue,
    hashesMatch,
    isCredentialShape,
    registerPushToken,
    revokePushToken,
    unregisterPushTokenForUser,
};
