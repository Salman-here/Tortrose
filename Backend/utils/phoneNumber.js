const normalizePhoneDigits = (value) => String(value || '').replace(/[^0-9]/g, '');

const toE164PhoneNumber = (value) => {
    const digits = normalizePhoneDigits(value);
    return digits ? `+${digits}` : '';
};

/** Match canonical rows plus legacy values containing the same digit sequence. */
const sellerPhoneConflictQuery = (digits, excludeSellerId = null) => {
    const normalizedDigits = normalizePhoneDigits(digits);
    // Digits are the only interpolated characters, so this regex cannot be
    // user-controlled regex syntax. It permits punctuation/spacing only.
    const legacyFormattedNumber = new RegExp(
        `^[^0-9]*${normalizedDigits.split('').join('[^0-9]*')}[^0-9]*$`
    );
    return {
        role: 'seller',
        ...(excludeSellerId ? { _id: { $ne: excludeSellerId } } : {}),
        $or: [
            { 'sellerInfo.whatsappDigits': normalizedDigits },
            { 'sellerInfo.whatsappNumber': legacyFormattedNumber },
            { 'sellerInfo.phoneNumber': legacyFormattedNumber },
        ],
    };
};

module.exports = {
    normalizePhoneDigits,
    toE164PhoneNumber,
    sellerPhoneConflictQuery,
};
