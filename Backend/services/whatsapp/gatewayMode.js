'use strict';

const SINGLE_INSTANCE_ENV = 'WHATSAPP_SINGLE_INSTANCE_MODE';

function useUnifiedWhatsAppInstance() {
    return String(process.env[SINGLE_INSTANCE_ENV] || 'true').toLowerCase() !== 'false';
}

function configKeyFor(logicalInstanceType = 'main') {
    if (useUnifiedWhatsAppInstance()) return 'seller';
    return logicalInstanceType === 'seller' ? 'seller' : 'main';
}

function routingScopeFor(logicalInstanceType = 'main') {
    if (useUnifiedWhatsAppInstance()) return 'seller';
    return logicalInstanceType === 'seller' ? 'seller' : 'main';
}

function managementInstanceName() {
    return process.env.EVOLUTION_SELLER_INSTANCE_NAME || 'rozare-seller';
}

module.exports = {
    useUnifiedWhatsAppInstance,
    configKeyFor,
    routingScopeFor,
    managementInstanceName,
};
