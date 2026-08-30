const STATUS_LABELS = {
    active: 'Active',
    past_due: 'Past Due',
    cancelled: 'Cancelled',
    blocked: 'Blocked',
}

const asValidDate = (value) => {
    if (!value) return null
    const date = value instanceof Date ? value : new Date(value)
    return Number.isNaN(date.getTime()) ? null : date
}

const resolveUserJoinedAt = (user) => {
    const storedDate = asValidDate(user?.createdAt)
    if (storedDate) return storedDate

    const objectId = user?._id
    if (objectId && typeof objectId.getTimestamp === 'function') {
        return asValidDate(objectId.getTimestamp())
    }

    const objectIdText = String(objectId || '')
    if (/^[a-f\d]{24}$/i.test(objectIdText)) {
        return new Date(Number.parseInt(objectIdText.slice(0, 8), 16) * 1000)
    }

    return null
}

const endingLabel = (name, date, now) => {
    const endDate = asValidDate(date)
    if (!endDate) return `${name} end`
    return `${name} ${endDate.getTime() < now.getTime() ? 'ended' : 'ends'}`
}

const presentSellerSubscription = (subscription, now = new Date()) => {
    if (!subscription) return null

    const status = subscription.status || ''
    const plan = subscription.plan || ''
    const isSellerTrial = status === 'trial' || plan === 'free_trial'

    let displayPlanName = subscription.planName || 'No plan selected'
    if (isSellerTrial) displayPlanName = 'Rozare Free Trial'
    else if (plan === 'starter') displayPlanName = 'Rozare Starter'
    else if (plan === 'elite') displayPlanName = subscription.planName || 'Rozare Elite'

    let displayStatus = STATUS_LABELS[status] || status.replace(/_/g, ' ') || 'Unknown'
    let periodEndDate = subscription.currentPeriodEnd || null
    let periodLabel = endingLabel('Period', periodEndDate, now)

    if (isSellerTrial) {
        const adminGrant = subscription.adminTrialGrant
        const grantAmount = adminGrant?.amount
        const grantUnit = adminGrant?.unit
        const hasAdminGrant = Number.isSafeInteger(grantAmount)
            && grantAmount > 0
            && ['days', 'months'].includes(grantUnit)
        if (status === 'trial' && hasAdminGrant) {
            const rawUnit = grantUnit.slice(0, -1)
            const unit = `${rawUnit.charAt(0).toUpperCase()}${rawUnit.slice(1)}`
            displayStatus = adminGrant.mode === 'extend'
                ? `${grantAmount}-${unit} Trial Extension`
                : `${grantAmount}-${unit} Free Trial`
        } else if (status === 'trial') {
            displayStatus = '15-Day Free Trial'
        }
        periodEndDate = subscription.trialEndDate || null
        periodLabel = endingLabel('Trial', periodEndDate, now)
    } else if (status === 'free_period') {
        displayStatus = `${plan === 'elite' ? 45 : 30}-Day Free Period`
        periodEndDate = subscription.freePeriodEndDate || subscription.currentPeriodEnd || null
        periodLabel = endingLabel('Free period', periodEndDate, now)
    } else if (status === 'active') {
        periodLabel = 'Renews'
    } else if (status === 'cancelled') {
        periodLabel = endingLabel('Access', periodEndDate, now)
    }

    return {
        ...subscription,
        displayPlanName,
        displayStatus,
        periodLabel,
        periodEndDate,
    }
}

module.exports = {
    presentSellerSubscription,
    resolveUserJoinedAt,
}
