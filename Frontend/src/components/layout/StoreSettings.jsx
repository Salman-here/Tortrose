import { useState, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import { Store, Upload, X, Eye, Trash2, Loader2, ExternalLink, BarChart3, ShoppingBag, Heart, DollarSign, CheckCircle, Clock, AlertTriangle, Info, Mail, Phone, Globe, Lock, AlertCircle, Sparkles, Palette, MapPin, Crosshair, Save } from 'lucide-react';
import axios from 'axios';
import { toast } from 'react-toastify';
import { uploadImageToCloudinary } from '../../utils/uploadToCloudinary';
import { Link, useOutletContext } from 'react-router-dom';
import { useCurrency } from '../../contexts/CurrencyContext';
import Loader from '../common/Loader';
import PhoneField, { isValidPhone } from '../common/PhoneField';
import { getAuthToken } from "../../utils/cookieHelper";
import StoreThemeSettings from './StoreThemeSettings';
import { DEFAULT_STORE_THEME_ID, normalizeThemeSelection } from '../../utils/storeThemes';
import LocationAutocomplete from '../common/LocationAutocomplete';

const GPS_RADIUS_VISIBILITY_ENABLED = false;

const DEFAULT_VISIBILITY = {
    mode: 'country',
    country: '',
    countryCode: '',
    region: '',
    regionCode: '',
    city: '',
    cityStateCode: '',
    town: '',
    townStateCode: '',
    radiusKm: 1,
    lat: '',
    lng: '',
    label: '',
};

const normalizeVisibilityForm = (visibility = {}, address = {}) => {
    const coordinates = visibility?.location?.coordinates;
    const normalized = {
        ...DEFAULT_VISIBILITY,
        ...visibility,
        country: visibility.country || address.country || '',
        countryCode: visibility.countryCode || address.countryCode || '',
        region: visibility.region || address.state || '',
        regionCode: visibility.regionCode || address.stateCode || '',
        city: visibility.city || address.city || '',
        radiusKm: visibility.radiusKm || 1,
        lng: Array.isArray(coordinates) && coordinates[0] !== undefined ? String(coordinates[0]) : String(visibility.lng || ''),
        lat: Array.isArray(coordinates) && coordinates[1] !== undefined ? String(coordinates[1]) : String(visibility.lat || ''),
    };
    if (!GPS_RADIUS_VISIBILITY_ENABLED && normalized.mode === 'radius') {
        normalized.mode = normalized.city ? 'city' : normalized.region ? 'region' : normalized.country ? 'country' : 'global';
    }
    return normalized;
};

const visibilityModes = [
    { mode: 'global', label: 'Global', desc: 'Visible to every buyer' },
    { mode: 'country', label: 'Country', desc: 'Visible in one country' },
    { mode: 'region', label: 'State', desc: 'Visible in one province or state' },
    { mode: 'city', label: 'City', desc: 'Visible in one city' },
    { mode: 'town', label: 'Town', desc: 'Visible in one town or area' },
    ...(GPS_RADIUS_VISIBILITY_ENABLED ? [{ mode: 'radius', label: 'Radius', desc: 'Visible near your chosen map point' }] : []),
];

const StoreVisibilitySettings = ({
    storeData,
    handleVisibilityChange,
    handleVisibilityPatch,
    useSellerCurrentPosition,
    saveVisibility,
    visibilitySaving,
    hasStore,
    blockedInfo,
}) => {
    const visibility = storeData.visibility || DEFAULT_VISIBILITY;
    const disabled = visibilitySaving || blockedInfo.blocked || !hasStore;

    return (
        <div className="glass-panel p-6 md:p-8">
            <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4 mb-6">
                <div>
                    <h2 className="text-xl font-bold flex items-center gap-2" style={{ color: 'hsl(var(--foreground))' }}>
                        <MapPin size={22} style={{ color: 'hsl(150, 60%, 45%)' }} />
                        Store Visibility
                    </h2>
                    <p className="text-sm mt-1 max-w-2xl" style={{ color: 'hsl(var(--muted-foreground))' }}>
                        Control where your store and products appear. Buyers outside this area will not see your store in Home, Marketplace, product detail, or checkout.
                    </p>
                </div>
                <button
                    type="button"
                    onClick={saveVisibility}
                    disabled={disabled}
                    className="px-4 py-2.5 rounded-xl text-white text-sm font-semibold inline-flex items-center justify-center gap-2 disabled:opacity-50"
                    style={{ background: 'linear-gradient(135deg, hsl(150, 60%, 45%), hsl(190, 70%, 45%))' }}
                >
                    {visibilitySaving ? <><Loader2 size={16} className="animate-spin" /> Saving...</> : <><Save size={16} /> Save Visibility</>}
                </button>
            </div>

            {!hasStore && (
                <div className="rounded-xl p-4 mb-5" style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)' }}>
                    <p className="text-sm font-semibold" style={{ color: 'hsl(45, 80%, 40%)' }}>Create your store first, then visibility can be saved.</p>
                </div>
            )}

            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-6">
                {visibilityModes.map(item => {
                    const active = visibility.mode === item.mode;
                    return (
                        <button
                            key={item.mode}
                            type="button"
                            disabled={disabled}
                            onClick={() => handleVisibilityChange('mode', item.mode)}
                            className="p-4 rounded-2xl text-left border transition-all disabled:opacity-60"
                            style={{
                                background: active ? 'linear-gradient(135deg, hsla(150,60%,45%,0.16), hsla(200,80%,50%,0.12))' : 'var(--glass-inner)',
                                borderColor: active ? 'hsl(150, 60%, 45%)' : 'var(--glass-border)',
                            }}
                        >
                            <p className="text-sm font-bold" style={{ color: active ? 'hsl(150, 60%, 38%)' : 'hsl(var(--foreground))' }}>{item.label}</p>
                            <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>{item.desc}</p>
                        </button>
                    );
                })}
            </div>

            {visibility.mode !== 'global' && (
                <div className="space-y-4">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <LocationAutocomplete
                            type="country"
                            label="Country"
                            value={visibility.country}
                            code={visibility.countryCode}
                            placeholder="Select country"
                            disabled={disabled}
                            onSelect={(option) => handleVisibilityPatch({
                                country: option.name,
                                countryCode: option.isoCode,
                                region: '',
                                regionCode: '',
                                city: '',
                                cityStateCode: '',
                                town: '',
                                townStateCode: '',
                            })}
                            onClear={() => handleVisibilityPatch({
                                country: '',
                                countryCode: '',
                                region: '',
                                regionCode: '',
                                city: '',
                                cityStateCode: '',
                                town: '',
                                townStateCode: '',
                            })}
                        />
                        {(visibility.mode === 'region' || visibility.mode === 'city' || visibility.mode === 'town') && (
                            <LocationAutocomplete
                                type="state"
                                label="State/Province"
                                value={visibility.region}
                                code={visibility.regionCode}
                                countryCode={visibility.countryCode}
                                countryName={visibility.country}
                                placeholder="Select state"
                                disabled={disabled || (!visibility.country && !visibility.countryCode)}
                                onSelect={(option) => handleVisibilityPatch({
                                    region: option.name,
                                    regionCode: option.isoCode,
                                    city: '',
                                    cityStateCode: '',
                                    town: '',
                                    townStateCode: '',
                                })}
                                onClear={() => handleVisibilityPatch({ region: '', regionCode: '', city: '', cityStateCode: '', town: '', townStateCode: '' })}
                            />
                        )}
                        {(visibility.mode === 'city' || visibility.mode === 'town') && (
                            <LocationAutocomplete
                                type="city"
                                label="City"
                                value={visibility.city}
                                code={visibility.cityStateCode}
                                countryCode={visibility.countryCode}
                                countryName={visibility.country}
                                stateCode={visibility.regionCode}
                                stateName={visibility.region}
                                placeholder="Select city"
                                disabled={disabled || (!visibility.country && !visibility.countryCode)}
                                onSelect={(option) => handleVisibilityPatch({
                                    city: option.name,
                                    cityStateCode: option.stateCode || visibility.regionCode,
                                    town: '',
                                    townStateCode: '',
                                })}
                                onClear={() => handleVisibilityPatch({ city: '', cityStateCode: '', town: '', townStateCode: '' })}
                            />
                        )}
                        {visibility.mode === 'town' && (
                            <LocationAutocomplete
                                type="city"
                                label="Town/Area"
                                value={visibility.town}
                                code={visibility.townStateCode}
                                countryCode={visibility.countryCode}
                                countryName={visibility.country}
                                stateCode={visibility.regionCode || visibility.cityStateCode}
                                stateName={visibility.region}
                                placeholder="Select town or area"
                                disabled={disabled || (!visibility.country && !visibility.countryCode)}
                                onSelect={(option) => handleVisibilityPatch({
                                    town: option.name,
                                    townStateCode: option.stateCode || visibility.regionCode || visibility.cityStateCode,
                                })}
                                onClear={() => handleVisibilityPatch({ town: '', townStateCode: '' })}
                            />
                        )}
                    </div>

                    {GPS_RADIUS_VISIBILITY_ENABLED && visibility.mode === 'radius' && (
                        <div className="rounded-2xl p-4 space-y-4" style={{ background: 'var(--glass-inner)', border: '1px solid var(--glass-border)' }}>
                            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                                <div>
                                    <p className="text-sm font-bold" style={{ color: 'hsl(var(--foreground))' }}>Radius Center</p>
                                    <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>Use your current location or enter coordinates manually.</p>
                                </div>
                                <button type="button" onClick={useSellerCurrentPosition} disabled={disabled}
                                    className="glass-button px-4 py-2 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 disabled:opacity-60">
                                    <Crosshair size={14} /> Use Current Location
                                </button>
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                <div>
                                    <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'hsl(var(--muted-foreground))' }}>Radius KM</label>
                                    <input type="number" min="0.1" max="500" step="0.1" value={visibility.radiusKm} onChange={(e) => handleVisibilityChange('radiusKm', e.target.value)} className="glass-input" disabled={disabled} />
                                </div>
                                <div>
                                    <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'hsl(var(--muted-foreground))' }}>Latitude</label>
                                    <input type="number" step="0.000001" value={visibility.lat} onChange={(e) => handleVisibilityChange('lat', e.target.value)} className="glass-input" placeholder="31.5204" disabled={disabled} />
                                </div>
                                <div>
                                    <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'hsl(var(--muted-foreground))' }}>Longitude</label>
                                    <input type="number" step="0.000001" value={visibility.lng} onChange={(e) => handleVisibilityChange('lng', e.target.value)} className="glass-input" placeholder="74.3587" disabled={disabled} />
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            )}

            {visibility.mode === 'global' && (
                <div className="rounded-2xl p-5" style={{ background: 'rgba(14,165,233,0.08)', border: '1px solid rgba(14,165,233,0.22)' }}>
                    <p className="text-sm font-semibold" style={{ color: 'hsl(var(--foreground))' }}>Your store will be visible globally.</p>
                </div>
            )}
        </div>
    );
};

const StoreSettings = () => {
    const { formatPrice, currency, currencies } = useCurrency();
    const outletContext = useOutletContext() || {};
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [activeSettingsTab, setActiveSettingsTab] = useState('details');
    const [hasStore, setHasStore] = useState(false);
    const [uploadingLogo, setUploadingLogo] = useState(false);
    const [uploadingBanner, setUploadingBanner] = useState(false);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [showCooldownModal, setShowCooldownModal] = useState(false);
    const [pendingChanges, setPendingChanges] = useState([]); // [{ field, label, days }]
    const [originals, setOriginals] = useState({ storeName: '', storeSlug: '', sellerType: 'store' });
    const [blockedInfo, setBlockedInfo] = useState({ blocked: false, daysUntilRemoval: null, isPurchased: false });
    const [productCurrencyInfo, setProductCurrencyInfo] = useState({
        activeCurrency: currency || 'USD',
        status: 'active',
        pendingCurrency: null,
        previousCurrency: null,
        productCount: 0,
        canAddProduct: true,
    });
    const [productCurrencyDraft, setProductCurrencyDraft] = useState(currency || 'USD');
    const [productCurrencySaving, setProductCurrencySaving] = useState(false);
    const [productCurrencyConfirm, setProductCurrencyConfirm] = useState(null);
    const [visibilitySaving, setVisibilitySaving] = useState(false);
    
    // Subdomain state
    const [customSubdomain, setCustomSubdomain] = useState('');
    const [subdomainAvailable, setSubdomainAvailable] = useState(null);
    const [subdomainChecking, setSubdomainChecking] = useState(false);
    const [subdomainMessage, setSubdomainMessage] = useState('');
    const [subdomainOwned, setSubdomainOwned] = useState(false);

    const formatCompactPrice = (amount) => {
        const value = Number(amount) || 0;
        const analyticsCurrency = analytics.currency || currency;
        const symbol = formatPrice(0, { sourceCurrency: analyticsCurrency, decimals: 0 }).replace(/[0-9,.]/g, '');
        if (value >= 1000000000) return `${symbol}${(value / 1000000000).toFixed(1)}B`;
        if (value >= 1000000) return `${symbol}${(value / 1000000).toFixed(1)}M`;
        if (value >= 10000) return `${symbol}${(value / 1000).toFixed(1)}K`;
        return formatPrice(value, { sourceCurrency: analyticsCurrency });
    };

    const [storeData, setStoreData] = useState({
        storeName: '', description: '', logo: '', banner: '', storeSlug: '', sellerType: 'store',
        storeTheme: { themeId: DEFAULT_STORE_THEME_ID, customTheme: null },
        visibility: DEFAULT_VISIBILITY,
        address: { street: '', city: '', state: '', stateCode: '', country: '', countryCode: '', postalCode: '' },
        socialLinks: { website: '', facebook: '', instagram: '', twitter: '', youtube: '', tiktok: '' },
        returnPolicy: { returnsEnabled: false, returnDuration: 0, refundType: 'none', warrantyEnabled: false, warrantyDuration: 0, warrantyDescription: '', policyDescription: '' }
    });

    const [analytics, setAnalytics] = useState({ views: 0, productCount: 0, totalSales: 0, trustCount: 0 });
    const [verification, setVerification] = useState({ isVerified: false, status: 'none', appliedAt: null, rejectionReason: '' });
    const [showVerificationModal, setShowVerificationModal] = useState(false);
    const [applicationMessage, setApplicationMessage] = useState('');
    const [contactEmail, setContactEmail] = useState('');
    const [contactPhone, setContactPhone] = useState('');
    const [applyingVerification, setApplyingVerification] = useState(false);

    useEffect(() => { fetchStoreData(); fetchVerificationStatus(); }, []);
    useEffect(() => { fetchAnalytics(); }, [currency]);

    const fetchProductCurrencySettings = async () => {
        try {
            const token = getAuthToken();
            const res = await axios.get(`${import.meta.env.VITE_API_URL}api/stores/product-currency`, { headers: { Authorization: `Bearer ${token}` } });
            if (res.data?.productCurrency) {
                setProductCurrencyInfo(res.data.productCurrency);
                setProductCurrencyDraft(res.data.productCurrency.pendingCurrency || res.data.productCurrency.activeCurrency || currency || 'USD');
            }
        } catch (error) {
            if (error.response?.status !== 404) console.error('Error fetching product currency settings:', error);
        }
    };

    const fetchStoreData = async () => {
        try {
            setLoading(true);
            const token = getAuthToken();
            const res = await axios.get(`${import.meta.env.VITE_API_URL}api/stores/my-store`, { headers: { Authorization: `Bearer ${token}` } });
            const defaultSocialLinks = { website: '', facebook: '', instagram: '', twitter: '', youtube: '', tiktok: '' };
            const defaultAddress = { street: '', city: '', state: '', stateCode: '', country: '', countryCode: '', postalCode: '' };
            const defaultReturnPolicy = { returnsEnabled: false, returnDuration: 0, refundType: 'none', warrantyEnabled: false, warrantyDuration: 0, warrantyDescription: '', policyDescription: '' };
            const slug = res.data.store.storeSlug || '';
            const sName = res.data.store.storeName || '';
            const sType = res.data.store.sellerType || 'store';
            const address = { ...defaultAddress, ...(res.data.store.address || {}) };
            setStoreData({
                storeName: sName, description: res.data.store.description || '',
                logo: res.data.store.logo || '', banner: res.data.store.banner || '', storeSlug: slug,
                sellerType: sType,
                storeTheme: normalizeThemeSelection(res.data.store.storeTheme),
                visibility: normalizeVisibilityForm(res.data.store.visibility, address),
                address,
                socialLinks: { ...defaultSocialLinks, ...(res.data.store.socialLinks || {}) },
                returnPolicy: { ...defaultReturnPolicy, ...(res.data.store.returnPolicy || {}) }
            });
            setOriginals({ storeName: sName, storeSlug: slug, sellerType: sType });
            setCustomSubdomain(slug);
            setSubdomainOwned(true);
            setSubdomainAvailable(true);
            setSubdomainMessage('This is your current subdomain');
            // Compute blocked + days until removal
            const now = Date.now();
            const removalAt = res.data.store.subdomainPurchase?.removalScheduledAt;
            const isPurchased = !!(res.data.store.subdomainPurchase?.isPurchased &&
                res.data.store.subdomainPurchase?.expiresAt &&
                new Date(res.data.store.subdomainPurchase.expiresAt).getTime() > now);
            const blocked = res.data.store.isActive === false;
            const daysUntilRemoval = (blocked && !isPurchased && removalAt)
                ? Math.max(0, Math.ceil((new Date(removalAt).getTime() - now) / 86400000))
                : null;
            setBlockedInfo({ blocked, daysUntilRemoval, isPurchased });
            setHasStore(true);
            await fetchProductCurrencySettings();
        } catch (error) {
            if (error.response?.status === 404) setHasStore(false);
            else console.error('Error fetching store:', error);
        } finally { setLoading(false); }
    };

    const fetchAnalytics = async () => {
        try {
            const token = getAuthToken();
            const res = await axios.get(`${import.meta.env.VITE_API_URL}api/stores/analytics?currency=${currency}`, { headers: { Authorization: `Bearer ${token}` } });
            setAnalytics(res.data.analytics);
        } catch (error) { console.error('Error fetching analytics:', error); }
    };

    const fetchVerificationStatus = async () => {
        try {
            const token = getAuthToken();
            const res = await axios.get(`${import.meta.env.VITE_API_URL}api/stores/verification/status`, { headers: { Authorization: `Bearer ${token}` } });
            setVerification(res.data.verification);
        } catch (error) { console.error('Error fetching verification status:', error); }
    };

    const handleApplyVerification = async () => {
        if (!applicationMessage.trim()) { toast.error('Please provide a message'); return; }
        if (!contactEmail.trim()) { toast.error('Please provide your contact email'); return; }
        if (!contactPhone.trim() || !isValidPhone(contactPhone)) { toast.error('Please enter a valid contact phone (select your country and enter the number)'); return; }
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(contactEmail)) { toast.error('Please provide a valid email'); return; }
        try {
            setApplyingVerification(true);
            const token = getAuthToken();
            await axios.post(`${import.meta.env.VITE_API_URL}api/stores/verification/apply`, { applicationMessage, contactEmail: contactEmail.trim(), contactPhone: contactPhone.trim() }, { headers: { Authorization: `Bearer ${token}` } });
            toast.success('Verification application submitted!');
            setShowVerificationModal(false); setApplicationMessage(''); setContactEmail(''); setContactPhone('');
            fetchVerificationStatus();
        } catch (error) { toast.error(error.response?.data?.msg || 'Failed to submit'); }
        finally { setApplyingVerification(false); }
    };

    const handleInputChange = (e) => { const { name, value } = e.target; setStoreData(prev => ({ ...prev, [name]: value })); };
    const handleSocialLinkChange = (platform, value) => { setStoreData(prev => ({ ...prev, socialLinks: { ...prev.socialLinks, [platform]: value } })); };
    const handleAddressChange = (field, value) => { setStoreData(prev => ({ ...prev, address: { ...prev.address, [field]: value } })); };
    const handleVisibilityChange = (field, value) => { setStoreData(prev => ({ ...prev, visibility: { ...prev.visibility, [field]: value } })); };
    const handleVisibilityPatch = (patch) => { setStoreData(prev => ({ ...prev, visibility: { ...prev.visibility, ...patch } })); };

    const useSellerCurrentPosition = () => {
        // GPS/radius visibility is intentionally disabled for now. Keep this
        // dormant so radius targeting can be restored without rebuilding it.
        if (!GPS_RADIUS_VISIBILITY_ENABLED) return;
        if (!navigator.geolocation) {
            toast.error('Location is not available in this browser.');
            return;
        }
        navigator.geolocation.getCurrentPosition(
            (position) => {
                setStoreData(prev => ({
                    ...prev,
                    visibility: {
                        ...prev.visibility,
                        lat: String(position.coords.latitude),
                        lng: String(position.coords.longitude),
                    },
                }));
                toast.success('Radius center updated');
            },
            (error) => toast.error(error.message || 'Could not get your current location.'),
            { enableHighAccuracy: true, timeout: 12000, maximumAge: 5 * 60 * 1000 }
        );
    };

    const validateVisibility = () => {
        const v = storeData.visibility || DEFAULT_VISIBILITY;
        if (v.mode !== 'global' && !String(v.country || '').trim()) return 'Country is required for this visibility mode.';
        if (v.mode === 'region' && !String(v.region || '').trim()) return 'State or province is required.';
        if (v.mode === 'city' && !String(v.city || '').trim()) return 'City is required.';
        if (v.mode === 'town' && !String(v.town || '').trim()) return 'Town or area is required.';
        if (GPS_RADIUS_VISIBILITY_ENABLED && v.mode === 'radius' && (!String(v.lat || '').trim() || !String(v.lng || '').trim())) return 'Use GPS or enter latitude and longitude for radius visibility.';
        return null;
    };

    const saveVisibility = async () => {
        if (!hasStore) {
            toast.error('Create your store before changing visibility.');
            return;
        }
        if (blockedInfo.blocked) {
            toast.error('Reactivate your subscription before changing visibility.');
            return;
        }
        const validationError = validateVisibility();
        if (validationError) {
            toast.error(validationError);
            return;
        }
        try {
            setVisibilitySaving(true);
            const token = getAuthToken();
            const res = await axios.put(`${import.meta.env.VITE_API_URL}api/stores/update`,
                { visibility: storeData.visibility },
                { headers: { Authorization: `Bearer ${token}` } });
            setStoreData(prev => ({
                ...prev,
                visibility: normalizeVisibilityForm(res.data.store?.visibility, prev.address),
            }));
            toast.success('Store visibility updated');
        } catch (error) {
            toast.error(error.response?.data?.msg || 'Failed to update store visibility');
        } finally {
            setVisibilitySaving(false);
        }
    };

    const requestProductCurrencyChange = async (nextCurrency, confirm = false) => {
        try {
            setProductCurrencySaving(true);
            const token = getAuthToken();
            const res = await axios.patch(`${import.meta.env.VITE_API_URL}api/stores/product-currency`,
                { currency: nextCurrency, confirm },
                { headers: { Authorization: `Bearer ${token}` } });
            setProductCurrencyInfo(res.data.productCurrency);
            setProductCurrencyDraft(res.data.productCurrency.pendingCurrency || res.data.productCurrency.activeCurrency || nextCurrency);
            setProductCurrencyConfirm(null);
            outletContext.fetchProductCurrencyState?.();
            toast.success(res.data.msg || 'Product currency updated');
        } catch (error) {
            const body = error.response?.data;
            if (error.response?.status === 409 && body?.requiresConfirmation) {
                setProductCurrencyConfirm({
                    requestedCurrency: body.productCurrency?.requestedCurrency || nextCurrency,
                    msg: body.msg || body.productCurrency?.msg || `Confirm product currency change to ${nextCurrency}.`,
                });
                setProductCurrencyDraft(nextCurrency);
                return;
            }
            setProductCurrencyDraft(productCurrencyInfo.pendingCurrency || productCurrencyInfo.activeCurrency || currency || 'USD');
            toast.error(body?.msg || 'Failed to update product currency');
        } finally {
            setProductCurrencySaving(false);
        }
    };

    const handleProductCurrencySelect = (nextCurrency) => {
        if (!nextCurrency || nextCurrency === productCurrencyDraft) return;
        setProductCurrencyDraft(nextCurrency);
        if (!hasStore) {
            setProductCurrencyInfo(prev => ({ ...prev, activeCurrency: nextCurrency }));
            return;
        }
        requestProductCurrencyChange(nextCurrency, false);
    };

    const cancelProductCurrencyConfirmation = () => {
        setProductCurrencyConfirm(null);
        setProductCurrencyDraft(productCurrencyInfo.pendingCurrency || productCurrencyInfo.activeCurrency || currency || 'USD');
    };

    // Sanitize subdomain input: lowercase, alphanumeric + hyphens only
    const sanitizeSubdomain = (val) =>
        val.toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-');

    const checkSubdomainAvailability = useCallback(async (slug) => {
        if (!slug || slug.length < 3) {
            setSubdomainAvailable(null);
            setSubdomainMessage('');
            setSubdomainOwned(false);
            return;
        }
        try {
            setSubdomainChecking(true);
            const token = getAuthToken();
            const res = await axios.get(`${import.meta.env.VITE_API_URL}api/stores/check-subdomain/${slug}`, { headers: { Authorization: `Bearer ${token}` } });
            setSubdomainAvailable(res.data.available);
            setSubdomainOwned(res.data.isOwned || false);
            setSubdomainMessage(res.data.msg);
        } catch (e) {
            setSubdomainAvailable(null);
            setSubdomainMessage('Could not check availability');
        } finally {
            setSubdomainChecking(false);
        }
    }, []);

    // Debounce subdomain check
    useEffect(() => {
        if (!customSubdomain || customSubdomain === storeData.storeSlug) return;
        const timer = setTimeout(() => checkSubdomainAvailability(customSubdomain), 600);
        return () => clearTimeout(timer);
    }, [customSubdomain, storeData.storeSlug, checkSubdomainAvailability]);

    const handleSubdomainChange = (e) => {
        const val = sanitizeSubdomain(e.target.value);
        setCustomSubdomain(val);
        setSubdomainAvailable(null);
        setSubdomainMessage('');
        setSubdomainOwned(false);
    };

    const handleLogoUpload = async (e) => {
        const file = e.target.files[0]; if (!file) return;
        if (file.size > 5 * 1024 * 1024) { toast.error('Logo must be less than 5MB'); return; }
        try { setUploadingLogo(true); const imageUrl = await uploadImageToCloudinary(file); setStoreData(prev => ({ ...prev, logo: imageUrl })); toast.success('Logo uploaded'); }
        catch (error) { toast.error('Failed to upload logo'); } finally { setUploadingLogo(false); }
    };

    const handleBannerUpload = async (e) => {
        const file = e.target.files[0]; if (!file) return;
        if (file.size > 5 * 1024 * 1024) { toast.error('Banner must be less than 5MB'); return; }
        try { setUploadingBanner(true); const imageUrl = await uploadImageToCloudinary(file); setStoreData(prev => ({ ...prev, banner: imageUrl })); toast.success('Banner uploaded'); }
        catch (error) { toast.error('Failed to upload banner'); } finally { setUploadingBanner(false); }
    };

    const COOLDOWN_DAYS = { storeName: 7, storeSlug: 30, sellerType: 30 };
    const FIELD_LABELS = { storeName: 'name', storeSlug: 'subdomain', sellerType: 'listing type' };

    const detectPendingChanges = () => {
        const changes = [];
        const newSlug = customSubdomain && customSubdomain.length >= 3 ? customSubdomain : storeData.storeSlug;
        if (hasStore && storeData.storeName.trim().toLowerCase() !== (originals.storeName || '').toLowerCase()) {
            changes.push({ field: 'storeName', label: FIELD_LABELS.storeName, days: COOLDOWN_DAYS.storeName });
        }
        if (hasStore && newSlug && newSlug.toLowerCase() !== (originals.storeSlug || '').toLowerCase()) {
            changes.push({ field: 'storeSlug', label: FIELD_LABELS.storeSlug, days: COOLDOWN_DAYS.storeSlug });
        }
        if (hasStore && (storeData.sellerType || 'store') !== (originals.sellerType || 'store')) {
            changes.push({ field: 'sellerType', label: FIELD_LABELS.sellerType, days: COOLDOWN_DAYS.sellerType });
        }
        return changes;
    };

    const handleSave = async () => {
        if (!storeData.storeName || storeData.storeName.trim().length < 3) { toast.error('Store name must be at least 3 characters'); return; }
        if (blockedInfo.blocked) {
            toast.error('Your store is blocked. Reactivate your subscription to make changes.');
            return;
        }
        const changes = detectPendingChanges();
        if (changes.length > 0) {
            setPendingChanges(changes);
            setShowCooldownModal(true);
            return;
        }
        await doSave();
    };

    const doSave = async () => {
        try {
            setSaving(true);
            const token = getAuthToken();
            const endpoint = hasStore ? 'update' : 'create';
            const payload = { ...storeData };
            payload.productCurrency = productCurrencyDraft || productCurrencyInfo.activeCurrency || currency;
            if (customSubdomain && customSubdomain.length >= 3) {
                payload.storeSlug = customSubdomain;
            }
            const res = await axios[hasStore ? 'put' : 'post'](`${import.meta.env.VITE_API_URL}api/stores/${endpoint}`, payload, { headers: { Authorization: `Bearer ${token}` } });
            toast.success(res.data.msg);
            setHasStore(true);
            if (res.data.store) {
                setStoreData(prev => ({
                    ...prev,
                    storeSlug: res.data.store.storeSlug,
                    storeTheme: normalizeThemeSelection(res.data.store.storeTheme || prev.storeTheme),
                }));
                setCustomSubdomain(res.data.store.storeSlug);
                const savedProductCurrency = res.data.store.productCurrency || productCurrencyDraft || currency;
                setProductCurrencyInfo(prev => ({ ...prev, activeCurrency: savedProductCurrency, status: 'active', pendingCurrency: null, previousCurrency: null }));
                setProductCurrencyDraft(savedProductCurrency);
                setOriginals({
                    storeName: res.data.store.storeName,
                    storeSlug: res.data.store.storeSlug,
                    sellerType: res.data.store.sellerType || 'store',
                });
            }
            fetchProductCurrencySettings();
            outletContext.fetchProductCurrencyState?.();
            fetchAnalytics();
        } catch (error) {
            const cd = error.response?.data?.cooldown;
            if (error.response?.status === 423 && cd) {
                toast.error(`You can change your ${cd.label} again in ${cd.daysRemaining} day(s).`);
            } else {
                toast.error(error.response?.data?.msg || 'Failed to save store');
            }
        } finally { setSaving(false); setShowCooldownModal(false); setPendingChanges([]); }
    };

    const handleDelete = async () => {
        try {
            const token = getAuthToken();
            await axios.delete(`${import.meta.env.VITE_API_URL}api/stores/delete`, { headers: { Authorization: `Bearer ${token}` } });
            toast.success('Store deleted'); setHasStore(false);
            setStoreData({
                storeName: '', description: '', logo: '', banner: '', storeSlug: '', sellerType: 'store',
                storeTheme: { themeId: DEFAULT_STORE_THEME_ID, customTheme: null },
                visibility: DEFAULT_VISIBILITY,
                address: { street: '', city: '', state: '', stateCode: '', country: '', countryCode: '', postalCode: '' },
                socialLinks: { website: '', facebook: '', instagram: '', twitter: '', youtube: '', tiktok: '' },
                returnPolicy: { returnsEnabled: false, returnDuration: 0, refundType: 'none', warrantyEnabled: false, warrantyDuration: 0, warrantyDescription: '', policyDescription: '' }
            });
            setShowDeleteConfirm(false);
        } catch (error) { toast.error(error.response?.data?.msg || 'Failed to delete store'); }
    };

    if (loading) return <div className="flex justify-center items-center h-64"><Loader /></div>;

    const statCards = [
        { label: 'Total Views', value: analytics.views, icon: <BarChart3 size={18} />, color: 'hsl(220, 70%, 55%)' },
        { label: 'Products', value: analytics.productCount, icon: <ShoppingBag size={18} />, color: 'hsl(150, 60%, 45%)' },
        { label: 'Trusters', value: analytics.trustCount || 0, icon: <Heart size={18} />, color: 'hsl(330, 70%, 55%)' },
        { label: 'Total Sales', value: formatCompactPrice(analytics.totalSales || 0), icon: <DollarSign size={18} />, color: 'hsl(200, 80%, 50%)' },
    ];

    return (
        <div className="p-4 md:p-6 max-w-4xl mx-auto">
            {/* Header */}
            <div className="mb-6">
                <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight flex items-center gap-2" style={{ color: 'hsl(var(--foreground))' }}>
                    <Store size={28} className="md:w-8 md:h-8" />
                    Store Settings
                </h1>
                <p className="text-sm md:text-base mt-2" style={{ color: 'hsl(var(--muted-foreground))' }}>
                    {hasStore ? 'Manage your store configuration' : 'Create your store to establish your brand'}
                </p>
            </div>

            {/* Blocked Banner */}
            {hasStore && blockedInfo.blocked && (
                <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }}
                    className="rounded-2xl p-4 md:p-5 mb-6 flex items-start gap-3"
                    style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)' }}>
                    <AlertTriangle size={20} className="shrink-0 mt-0.5" style={{ color: 'hsl(0, 72%, 55%)' }} />
                    <div className="flex-1">
                        <p className="text-sm font-bold" style={{ color: 'hsl(0, 72%, 50%)' }}>
                            Store blocked — subscription inactive
                        </p>
                        <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                            {blockedInfo.isPurchased
                                ? 'Your subdomain is purchased and protected. Reactivate your subscription to make your store visible again.'
                                : blockedInfo.daysUntilRemoval !== null
                                    ? <>Your subdomain <strong className="font-mono">{storeData.storeSlug}.rozare.com</strong> will be released in <strong>{blockedInfo.daysUntilRemoval} day(s)</strong> and may be claimed by another seller. Reactivate your subscription to keep it.</>
                                    : 'Reactivate your subscription to make your store visible again.'}
                        </p>
                        <Link to="/seller-dashboard/subscription"
                            className="inline-flex items-center gap-1.5 mt-3 px-4 py-2 rounded-lg text-xs font-semibold text-white"
                            style={{ background: 'linear-gradient(135deg, hsl(0, 72%, 55%), hsl(15, 80%, 55%))' }}>
                            Reactivate Subscription
                        </Link>
                    </div>
                </motion.div>
            )}

            {/* Analytics Cards */}
            {hasStore && (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
                    {statCards.map((card, i) => (
                        <motion.div key={i} whileHover={{ y: -3 }} className="glass-card p-5">
                            <div className="glass-inner inline-flex p-2.5 rounded-xl mb-3" style={{ color: card.color }}>{card.icon}</div>
                            <p className="text-xs font-medium mb-1" style={{ color: 'hsl(var(--muted-foreground))' }}>{card.label}</p>
                            <p className="text-2xl font-extrabold" style={{ color: 'hsl(var(--foreground))' }}>{card.value}</p>
                        </motion.div>
                    ))}
                </div>
            )}

            {/* Verification Status */}
            {hasStore && (
                <div className="glass-panel p-6 md:p-8 mb-6">
                    <div className="flex items-center justify-between mb-4">
                        <h2 className="text-xl font-bold flex items-center gap-2" style={{ color: 'hsl(var(--foreground))' }}>
                            {verification.isVerified ? <><CheckCircle size={22} style={{ color: 'hsl(150, 60%, 45%)' }} /> Verified Store</> : <><CheckCircle size={22} style={{ color: 'hsl(var(--muted-foreground))' }} /> Store Verification</>}
                        </h2>
                        {!verification.isVerified && verification.status === 'none' && (
                            <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.97 }} onClick={() => setShowVerificationModal(true)}
                                className="px-4 py-2 rounded-xl text-sm font-semibold text-white transition-all"
                                style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(200, 80%, 50%))', boxShadow: '0 0 20px -4px hsl(220, 70%, 55%, 0.3)' }}>
                                Apply for Verification
                            </motion.button>
                        )}
                    </div>

                    {verification.isVerified && (
                        <div className="glass-inner rounded-xl p-4" style={{ borderLeft: '3px solid hsl(150, 60%, 45%)' }}>
                            <p className="font-medium" style={{ color: 'hsl(150, 60%, 40%)' }}><CheckCircle size={16} className="inline mr-1" /> Your store is verified!</p>
                            <p className="text-sm mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>Your store displays a verification badge.</p>
                        </div>
                    )}
                    {verification.status === 'pending' && (
                        <div className="glass-inner rounded-xl p-4" style={{ borderLeft: '3px solid hsl(45, 93%, 47%)' }}>
                            <p className="font-medium" style={{ color: 'hsl(45, 80%, 40%)' }}><Clock size={16} className="inline mr-1" /> Verification Pending</p>
                            <p className="text-sm mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>Your application is under review.</p>
                            <p className="text-xs mt-2" style={{ color: 'hsl(var(--muted-foreground))' }}>Applied: {new Date(verification.appliedAt).toLocaleDateString()}</p>
                        </div>
                    )}
                    {verification.status === 'rejected' && (
                        <div className="glass-inner rounded-xl p-4" style={{ borderLeft: '3px solid hsl(0, 72%, 55%)' }}>
                            <p className="font-medium" style={{ color: 'hsl(0, 72%, 50%)' }}><AlertTriangle size={16} className="inline mr-1" /> Verification Rejected</p>
                            <p className="text-sm mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>Reason: {verification.rejectionReason}</p>
                            <motion.button whileHover={{ scale: 1.02 }} onClick={() => setShowVerificationModal(true)}
                                className="mt-3 px-4 py-2 rounded-xl text-sm font-semibold text-white" style={{ background: 'hsl(0, 72%, 55%)' }}>
                                Reapply
                            </motion.button>
                        </div>
                    )}
                    {verification.status === 'none' && (
                        <div className="glass-inner rounded-xl p-4">
                            <p className="text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                <Info size={16} className="inline mr-1" /> Get verified to build trust with customers and stand out.
                            </p>
                        </div>
                    )}
                </div>
            )}

            {/* Settings Tabs */}
            <div className="glass-panel p-2 mb-6 flex flex-col sm:flex-row gap-2">
                {[
                    { id: 'details', label: 'Store Details', Icon: Store },
                    { id: 'visibility', label: 'Visibility', Icon: MapPin },
                    { id: 'themes', label: 'Themes', Icon: Palette },
                ].map(tab => {
                    const active = activeSettingsTab === tab.id;
                    const Icon = tab.Icon;
                    return (
                        <button
                            key={tab.id}
                            type="button"
                            onClick={() => setActiveSettingsTab(tab.id)}
                            className="flex-1 px-4 py-3 rounded-xl text-sm font-bold flex items-center justify-center gap-2 transition-all"
                            style={{
                                background: active ? 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))' : 'transparent',
                                color: active ? 'white' : 'hsl(var(--foreground))',
                            }}
                        >
                            <Icon size={17} /> {tab.label}
                        </button>
                    );
                })}
            </div>

            {activeSettingsTab === 'themes' ? (
                <StoreThemeSettings
                    storeData={storeData}
                    setStoreData={setStoreData}
                    hasStore={hasStore}
                    blockedInfo={blockedInfo}
                />
            ) : activeSettingsTab === 'visibility' ? (
                <StoreVisibilitySettings
                    storeData={storeData}
                    handleVisibilityChange={handleVisibilityChange}
                    handleVisibilityPatch={handleVisibilityPatch}
                    useSellerCurrentPosition={useSellerCurrentPosition}
                    saveVisibility={saveVisibility}
                    visibilitySaving={visibilitySaving}
                    hasStore={hasStore}
                    blockedInfo={blockedInfo}
                />
            ) : (
            /* Store Form */
            <div className="glass-panel p-6 md:p-8">
                <div className="space-y-4 md:space-y-6">
                    {/* Seller Type — Store / Brand */}
                    <div>
                        <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'hsl(var(--muted-foreground))' }}>Listing Type</label>
                        <div className="grid grid-cols-2 gap-2">
                            {[
                                { value: 'store', label: 'Store', desc: 'Independent shop / reseller', Icon: Store },
                                { value: 'brand', label: 'Brand', desc: 'Own products / label', Icon: Sparkles },
                            ].map(opt => {
                                const active = (storeData.sellerType || 'store') === opt.value;
                                const Icon = opt.Icon;
                                return (
                                    <button
                                        key={opt.value}
                                        type="button"
                                        onClick={() => setStoreData(prev => ({ ...prev, sellerType: opt.value }))}
                                        className="p-3 rounded-xl text-left transition-all border"
                                        style={{
                                            background: active ? 'linear-gradient(135deg, hsla(220, 70%, 55%, 0.15), hsla(260, 60%, 60%, 0.15))' : 'hsla(0,0%,100%,0.04)',
                                            borderColor: active ? 'hsl(220, 70%, 55%)' : 'hsla(0,0%,100%,0.12)',
                                        }}
                                    >
                                        <div className="flex items-center gap-2 font-bold text-sm" style={{ color: active ? 'hsl(220, 70%, 55%)' : 'hsl(var(--foreground))' }}>
                                            <Icon size={14} /> {opt.label}
                                        </div>
                                        <p className="text-[11px] mt-0.5" style={{ color: 'hsl(var(--muted-foreground))' }}>{opt.desc}</p>
                                    </button>
                                );
                            })}
                        </div>
                        <p className="text-xs mt-2" style={{ color: 'hsl(var(--muted-foreground))' }}>You can change this anytime. It controls where you appear in the marketplace.</p>
                    </div>

                    {/* Product Currency */}
                    <div style={{ borderTop: '1px solid var(--glass-border)', paddingTop: '1.5rem' }}>
                        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 mb-3">
                            <div>
                                <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'hsl(var(--muted-foreground))' }}>Product Price Currency</label>
                                <h3 className="text-lg font-bold flex items-center gap-2" style={{ color: 'hsl(var(--foreground))' }}>
                                    <DollarSign size={18} style={{ color: 'hsl(150, 60%, 45%)' }} />
                                    {productCurrencyInfo.status === 'pending_conversion'
                                        ? `${productCurrencyInfo.previousCurrency || productCurrencyInfo.activeCurrency} to ${productCurrencyInfo.pendingCurrency}`
                                        : productCurrencyInfo.activeCurrency || productCurrencyDraft}
                                </h3>
                            </div>
                            <select
                                value={productCurrencyDraft}
                                onChange={(e) => handleProductCurrencySelect(e.target.value)}
                                disabled={productCurrencySaving || blockedInfo.blocked}
                                className="glass-input cursor-pointer font-semibold min-w-[180px]"
                            >
                                {Object.entries(currencies || {}).map(([code, info]) => (
                                    <option key={code} value={code}>{code} - {info.name}</option>
                                ))}
                            </select>
                        </div>
                        <p className="text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>
                            New product prices are saved in this currency. Buyers can still view prices in their own selected currency.
                        </p>

                        {productCurrencyInfo.status === 'pending_conversion' && (
                            <div className="mt-4 rounded-xl p-4" style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)' }}>
                                <p className="text-sm font-semibold flex items-center gap-2" style={{ color: 'hsl(45, 80%, 40%)' }}>
                                    <AlertTriangle size={15} /> Conversion required
                                </p>
                                <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                    You changed the product currency to {productCurrencyInfo.pendingCurrency}, but your existing products still need conversion. Go to Products and either convert all prices or keep {productCurrencyInfo.previousCurrency || productCurrencyInfo.activeCurrency}. You cannot add new products until then.
                                </p>
                            </div>
                        )}

                        {productCurrencyConfirm && (
                            <div className="mt-4 rounded-xl p-4" style={{ background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.22)' }}>
                                <p className="text-sm font-semibold flex items-center gap-2" style={{ color: 'hsl(0, 72%, 50%)' }}>
                                    <AlertTriangle size={15} /> Confirm currency change
                                </p>
                                <p className="text-xs mt-1 mb-3" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                    {productCurrencyConfirm.msg}
                                </p>
                                <div className="flex flex-wrap gap-2">
                                    <button type="button" onClick={cancelProductCurrencyConfirmation}
                                        className="px-4 py-2 rounded-lg text-xs font-semibold"
                                        style={{ background: 'var(--glass-inner)', color: 'hsl(var(--foreground))', border: '1px solid var(--glass-border)' }}>
                                        Cancel
                                    </button>
                                    <button type="button" disabled={productCurrencySaving}
                                        onClick={() => requestProductCurrencyChange(productCurrencyConfirm.requestedCurrency, true)}
                                        className="px-4 py-2 rounded-lg text-xs font-semibold text-white disabled:opacity-60"
                                        style={{ background: 'linear-gradient(135deg, hsl(0, 72%, 55%), hsl(15, 80%, 55%))' }}>
                                        {productCurrencySaving ? 'Saving...' : `Change to ${productCurrencyConfirm.requestedCurrency}`}
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Store Name */}
                    <div>
                        <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'hsl(var(--muted-foreground))' }}>{(storeData.sellerType || 'store') === 'brand' ? 'Brand' : 'Store'} Name *</label>
                        <input type="text" name="storeName" value={storeData.storeName} onChange={handleInputChange} className="glass-input" placeholder={`Enter your ${(storeData.sellerType || 'store') === 'brand' ? 'brand' : 'store'} name`} maxLength={50} />
                        <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>{storeData.storeName.length}/50 characters</p>
                    </div>

                    {/* Path-based store URL removed — stores are reachable only via their subdomain (see Custom Subdomain section below). */}

                    {/* ─── Subdomain Section ─── */}
                    <div style={{ borderTop: '1px solid var(--glass-border)', paddingTop: '1.5rem' }}>
                        <div className="flex items-center gap-2 mb-1">
                            <Globe size={18} style={{ color: 'hsl(var(--primary))' }} />
                            <h3 className="text-lg font-bold" style={{ color: 'hsl(var(--foreground))' }}>
                                Custom Subdomain
                            </h3>
                            {blockedInfo.blocked ? (
                                <span className="text-xs font-semibold px-2 py-0.5 rounded-full flex items-center gap-1" style={{ background: 'rgba(239,68,68,0.12)', color: 'hsl(0, 72%, 50%)', border: '1px solid rgba(239,68,68,0.3)' }}>
                                    <Lock size={10} /> Blocked{blockedInfo.daysUntilRemoval !== null ? ` — releases in ${blockedInfo.daysUntilRemoval}d` : ''}
                                </span>
                            ) : !blockedInfo.blocked ? (
                                <span className="text-xs font-semibold px-2 py-0.5 rounded-full" style={{ background: 'rgba(34,197,94,0.12)', color: 'hsl(150, 60%, 40%)', border: '1px solid rgba(34,197,94,0.25)' }}>
                                    ✓ Live
                                </span>
                            ) : (
                                <span className="text-xs font-semibold px-2 py-0.5 rounded-full flex items-center gap-1" style={{ background: 'rgba(234,179,8,0.12)', color: 'hsl(45, 80%, 40%)', border: '1px solid rgba(234,179,8,0.25)' }}>
                                    <Lock size={10} /> Unavailable
                                </span>
                            )}
                        </div>
                        <p className="text-sm mb-4" style={{ color: 'hsl(var(--muted-foreground))' }}>
                            Choose a unique subdomain for your branded store link. It stays live while your store is active; verification adds a badge and extra trust.
                        </p>

                        {/* Subdomain Input */}
                        <div className="flex items-center gap-0 rounded-xl overflow-hidden mb-2" style={{ border: '1.5px solid var(--glass-border)', background: 'var(--glass-bg)' }}>
                            <span className="px-3 py-3 text-sm font-medium select-none" style={{ background: 'var(--glass-inner)', color: 'hsl(var(--muted-foreground))', borderRight: '1px solid var(--glass-border)', whiteSpace: 'nowrap' }}>
                                rozare.com/
                            </span>
                            <input
                                type="text"
                                value={customSubdomain}
                                onChange={handleSubdomainChange}
                                className="flex-1 px-3 py-3 bg-transparent text-sm outline-none font-mono"
                                style={{ color: 'hsl(var(--foreground))' }}
                                placeholder="your-store-name"
                                maxLength={50}
                            />
                            <span className="px-3 py-3" style={{ minWidth: '28px' }}>
                                {subdomainChecking ? (
                                    <Loader2 size={16} className="animate-spin" style={{ color: 'hsl(var(--muted-foreground))' }} />
                                ) : subdomainAvailable === true ? (
                                    <CheckCircle size={16} style={{ color: 'hsl(150, 60%, 45%)' }} />
                                ) : subdomainAvailable === false ? (
                                    <AlertCircle size={16} style={{ color: 'hsl(0, 72%, 55%)' }} />
                                ) : null}
                            </span>
                        </div>

                        {/* Availability message */}
                        {subdomainMessage && customSubdomain.length >= 3 && (
                            <p className="text-xs mb-3" style={{ color: subdomainAvailable ? 'hsl(150, 60%, 45%)' : 'hsl(0, 72%, 55%)' }}>
                                {subdomainMessage}
                            </p>
                        )}

                        {/* Live subdomain preview */}
                        {customSubdomain.length >= 3 && (
                            <motion.div
                                initial={{ opacity: 0, y: 4 }}
                                animate={{ opacity: 1, y: 0 }}
                                className="rounded-xl p-4 mb-4"
                                style={{ background: 'var(--glass-inner)', border: '1px solid var(--glass-border)' }}
                            >
                                <p className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                    Subdomain Preview
                                </p>
                                <div className="flex items-center gap-2 flex-wrap">
                                    <Globe size={14} style={{ color: 'hsl(var(--primary))' }} />
                                    <span className="text-sm font-mono font-semibold" style={{ color: 'hsl(var(--foreground))' }}>
                                        {customSubdomain}.rozare.com
                                    </span>
                                    {!blockedInfo.blocked ? (
                                        <span className="text-xs" style={{ color: 'hsl(150, 60%, 45%)' }}>← Will route to your store</span>
                                    ) : (
                                        <span className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>← Unavailable while your store is blocked</span>
                                    )}
                                </div>
                            </motion.div>
                        )}

                        {/* Verification guidance */}
                        {!verification.isVerified && (
                            <motion.div
                                initial={{ opacity: 0, y: 4 }}
                                animate={{ opacity: 1, y: 0 }}
                                className="rounded-xl p-4 space-y-3"
                                style={{ background: 'rgba(234,179,8,0.07)', border: '1px solid rgba(234,179,8,0.25)' }}
                            >
                                <div className="flex items-start gap-3">
                                    <AlertTriangle size={18} className="shrink-0 mt-0.5" style={{ color: 'hsl(45, 80%, 45%)' }} />
                                    <div>
                                        <p className="text-sm font-semibold" style={{ color: 'hsl(45, 70%, 38%)' }}>
                                            Verification adds trust
                                        </p>
                                        {customSubdomain.length >= 3 && (
                                            <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                                <strong className="font-semibold" style={{ color: 'hsl(var(--foreground))' }}>{customSubdomain}.rozare.com</strong> is your store address. Verification is optional for subdomain routing, but useful for a verified badge and stronger customer confidence.
                                            </p>
                                        )}
                                    </div>
                                </div>

                                {/* Urgency: subdomain availability warning */}
                                {subdomainAvailable && !subdomainOwned && customSubdomain.length >= 3 && (
                                    <div className="flex items-start gap-2 rounded-lg px-3 py-2" style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)' }}>
                                        <AlertCircle size={14} className="shrink-0 mt-0.5" style={{ color: 'hsl(0, 72%, 55%)' }} />
                                        <p className="text-xs" style={{ color: 'hsl(0, 72%, 50%)' }}>
                                            <strong>This subdomain is currently available</strong> but is not assigned to your brand yet. Save your store settings to claim it before another seller does.
                                        </p>
                                    </div>
                                )}

                                <div className="flex flex-wrap gap-2 pt-1">
                                    {verification.status === 'none' && (
                                        <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.97 }}
                                            onClick={() => setShowVerificationModal(true)}
                                            className="px-4 py-2 rounded-lg text-xs font-semibold text-white"
                                            style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(200, 80%, 50%))' }}>
                                            Apply for Brand Verification
                                        </motion.button>
                                    )}
                                    <a href="mailto:support@rozare.com"
                                        className="px-4 py-2 rounded-lg text-xs font-semibold flex items-center gap-1.5"
                                        style={{ background: 'var(--glass-inner)', color: 'hsl(var(--foreground))', border: '1px solid var(--glass-border)' }}>
                                        <Mail size={12} /> Contact Support
                                    </a>
                                </div>

                                <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                    Need help? Contact <a href="mailto:support@rozare.com" className="underline">support@rozare.com</a> for more information about getting verified.
                                </p>
                            </motion.div>
                        )}

                        {/* Verified store badge */}
                        {verification.isVerified && customSubdomain.length >= 3 && (
                            <div className="rounded-xl p-4" style={{ background: 'rgba(34,197,94,0.07)', border: '1px solid rgba(34,197,94,0.2)' }}>
                                <p className="text-sm font-semibold flex items-center gap-2" style={{ color: 'hsl(150, 60%, 40%)' }}>
                                    <CheckCircle size={15} /> Your store is verified
                                </p>
                                <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                    Customers can reach your active store at <strong className="font-mono">{customSubdomain}.rozare.com</strong> and see your verified badge.
                                </p>
                            </div>
                        )}
                    </div>

                    {/* Description */}
                    <div style={{ borderTop: '1px solid var(--glass-border)', paddingTop: '1.5rem' }}>
                        <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'hsl(var(--muted-foreground))' }}>Description</label>
                        <textarea name="description" value={storeData.description} onChange={handleInputChange} rows={4} className="glass-input" placeholder="Tell customers about your store..." maxLength={500} />
                        <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>{storeData.description.length}/500 characters</p>
                    </div>

                    {/* Store Address */}
                    <div style={{ borderTop: '1px solid var(--glass-border)', paddingTop: '1.5rem' }}>
                        <h3 className="text-lg font-semibold mb-4" style={{ color: 'hsl(var(--foreground))' }}>Store Address (Optional)</h3>
                        <p className="text-sm mb-4" style={{ color: 'hsl(var(--muted-foreground))' }}>Add your store's physical address</p>
                        <div className="space-y-4">
                            <div>
                                <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'hsl(var(--muted-foreground))' }}>Street Address</label>
                                <input type="text" value={storeData.address.street} onChange={(e) => handleAddressChange('street', e.target.value)} className="glass-input" placeholder="123 Main Street" />
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <LocationAutocomplete
                                    type="country"
                                    label="Country"
                                    value={storeData.address.country}
                                    code={storeData.address.countryCode}
                                    placeholder="Select country"
                                    onSelect={(option) => setStoreData(prev => ({
                                        ...prev,
                                        address: {
                                            ...prev.address,
                                            country: option.name,
                                            countryCode: option.isoCode,
                                            state: '',
                                            stateCode: '',
                                            city: '',
                                        },
                                    }))}
                                    onClear={() => setStoreData(prev => ({
                                        ...prev,
                                        address: {
                                            ...prev.address,
                                            country: '',
                                            countryCode: '',
                                            state: '',
                                            stateCode: '',
                                            city: '',
                                        },
                                    }))}
                                />
                                <LocationAutocomplete
                                    type="state"
                                    label="State/Province"
                                    value={storeData.address.state}
                                    code={storeData.address.stateCode}
                                    countryCode={storeData.address.countryCode}
                                    countryName={storeData.address.country}
                                    placeholder="Select state"
                                    disabled={!storeData.address.country && !storeData.address.countryCode}
                                    onSelect={(option) => setStoreData(prev => ({
                                        ...prev,
                                        address: {
                                            ...prev.address,
                                            state: option.name,
                                            stateCode: option.isoCode,
                                            city: '',
                                        },
                                    }))}
                                    onClear={() => setStoreData(prev => ({
                                        ...prev,
                                        address: { ...prev.address, state: '', stateCode: '', city: '' },
                                    }))}
                                />
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <LocationAutocomplete
                                    type="city"
                                    label="City"
                                    value={storeData.address.city}
                                    code={storeData.address.stateCode}
                                    countryCode={storeData.address.countryCode}
                                    countryName={storeData.address.country}
                                    stateCode={storeData.address.stateCode}
                                    stateName={storeData.address.state}
                                    placeholder="Select city"
                                    disabled={!storeData.address.country && !storeData.address.countryCode}
                                    onSelect={(option) => setStoreData(prev => ({
                                        ...prev,
                                        address: {
                                            ...prev.address,
                                            city: option.name,
                                            stateCode: prev.address.stateCode || option.stateCode || '',
                                        },
                                    }))}
                                    onClear={() => handleAddressChange('city', '')}
                                />
                                <div>
                                    <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'hsl(var(--muted-foreground))' }}>Postal Code</label>
                                    <input type="text" value={storeData.address.postalCode} onChange={(e) => handleAddressChange('postalCode', e.target.value)} className="glass-input" placeholder="10001" />
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Logo Upload */}
                    <div>
                        <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'hsl(var(--muted-foreground))' }}>Store Logo</label>
                        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
                            {storeData.logo && (
                                <img src={storeData.logo} alt="Store logo" className="w-24 h-24 rounded-2xl object-cover" style={{ border: '3px solid var(--glass-border-strong)' }} />
                            )}
                            <div className="flex items-center gap-2">
                                <label className="cursor-pointer">
                                    <motion.div whileHover={{ scale: 1.02 }} className="px-4 py-2 rounded-xl flex items-center gap-2 text-sm font-semibold text-white"
                                        style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))' }}>
                                        {uploadingLogo ? <><Loader2 className="animate-spin" size={16} /><span className="hidden sm:inline">Uploading...</span></> : <><Upload size={16} /><span className="hidden sm:inline">Upload Logo</span><span className="sm:hidden">Upload</span></>}
                                    </motion.div>
                                    <input type="file" accept="image/*" onChange={handleLogoUpload} className="hidden" disabled={uploadingLogo} />
                                </label>
                                {storeData.logo && (
                                    <button onClick={() => setStoreData(prev => ({ ...prev, logo: '' }))} className="p-2 rounded-xl" style={{ color: 'hsl(0, 72%, 55%)', background: 'rgba(239, 68, 68, 0.1)' }}>
                                        <X size={20} />
                                    </button>
                                )}
                            </div>
                        </div>
                        <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>Max 5MB, square image recommended</p>
                    </div>

                    {/* Banner Upload */}
                    <div>
                        <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'hsl(var(--muted-foreground))' }}>Store Banner</label>
                        {storeData.banner && (
                            <div className="mb-3 relative">
                                <img src={storeData.banner} alt="Store banner" className="w-full h-40 object-cover rounded-2xl" style={{ border: '3px solid var(--glass-border-strong)' }} />
                                <button onClick={() => setStoreData(prev => ({ ...prev, banner: '' }))} className="absolute top-2 right-2 p-2 rounded-xl text-white" style={{ background: 'hsl(0, 72%, 55%)' }}>
                                    <X size={20} />
                                </button>
                            </div>
                        )}
                        <label className="cursor-pointer">
                            <motion.div whileHover={{ scale: 1.02 }} className="px-4 py-2 rounded-xl flex items-center gap-2 w-fit text-sm font-semibold text-white"
                                style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))' }}>
                                {uploadingBanner ? <><Loader2 className="animate-spin" size={16} /><span className="hidden sm:inline">Uploading...</span></> : <><Upload size={16} /><span className="hidden sm:inline">Upload Banner</span><span className="sm:hidden">Upload</span></>}
                            </motion.div>
                            <input type="file" accept="image/*" onChange={handleBannerUpload} className="hidden" disabled={uploadingBanner} />
                        </label>
                        <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>Max 5MB, wide image recommended (1200x400)</p>
                    </div>

                    {/* Return & Warranty Policy */}
                    <div style={{ borderTop: '1px solid var(--glass-border)', paddingTop: '1.5rem' }}>
                        <h3 className="text-lg font-semibold mb-4 flex items-center gap-2" style={{ color: 'hsl(var(--foreground))' }}>
                            🔄 Return & Warranty Policy
                        </h3>
                        <p className="text-sm mb-4" style={{ color: 'hsl(var(--muted-foreground))' }}>Set your store's default return and warranty policy. Products can override this individually.</p>
                        <div className="space-y-4">
                            <div className="flex items-center gap-3 glass-inner rounded-xl p-4">
                                <input type="checkbox" checked={storeData.returnPolicy.returnsEnabled} onChange={e => setStoreData(prev => ({ ...prev, returnPolicy: { ...prev.returnPolicy, returnsEnabled: e.target.checked } }))} className="h-4 w-4 rounded" style={{ accentColor: 'hsl(150, 60%, 45%)' }} />
                                <div><p className="text-sm font-medium" style={{ color: 'hsl(var(--foreground))' }}>Enable Returns</p><p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>Allow customers to return products</p></div>
                            </div>
                            {storeData.returnPolicy.returnsEnabled && (
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    <div>
                                        <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'hsl(var(--muted-foreground))' }}>Return Window (Days)</label>
                                        <input type="number" min={1} max={365} value={storeData.returnPolicy.returnDuration} onChange={e => setStoreData(prev => ({ ...prev, returnPolicy: { ...prev.returnPolicy, returnDuration: parseInt(e.target.value) || 0 } }))} className="glass-input" />
                                    </div>
                                    <div>
                                        <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'hsl(var(--muted-foreground))' }}>Refund Type</label>
                                        <select value={storeData.returnPolicy.refundType} onChange={e => setStoreData(prev => ({ ...prev, returnPolicy: { ...prev.returnPolicy, refundType: e.target.value } }))} className="glass-input cursor-pointer">
                                            <option value="none">No Refund</option>
                                            <option value="full_refund">Full Money Back</option>
                                            <option value="replacement_only">Replacement Only</option>
                                            <option value="store_credit">Store Credit</option>
                                        </select>
                                    </div>
                                </div>
                            )}
                            <div className="flex items-center gap-3 glass-inner rounded-xl p-4">
                                <input type="checkbox" checked={storeData.returnPolicy.warrantyEnabled} onChange={e => setStoreData(prev => ({ ...prev, returnPolicy: { ...prev.returnPolicy, warrantyEnabled: e.target.checked } }))} className="h-4 w-4 rounded" style={{ accentColor: 'hsl(45, 80%, 45%)' }} />
                                <div><p className="text-sm font-medium" style={{ color: 'hsl(var(--foreground))' }}>Enable Warranty</p><p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>Offer warranty on products</p></div>
                            </div>
                            {storeData.returnPolicy.warrantyEnabled && (
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    <div>
                                        <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'hsl(var(--muted-foreground))' }}>Warranty Duration (Months)</label>
                                        <input type="number" min={1} max={120} value={storeData.returnPolicy.warrantyDuration} onChange={e => setStoreData(prev => ({ ...prev, returnPolicy: { ...prev.returnPolicy, warrantyDuration: parseInt(e.target.value) || 0 } }))} className="glass-input" />
                                    </div>
                                    <div>
                                        <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'hsl(var(--muted-foreground))' }}>Warranty Description</label>
                                        <input type="text" value={storeData.returnPolicy.warrantyDescription} onChange={e => setStoreData(prev => ({ ...prev, returnPolicy: { ...prev.returnPolicy, warrantyDescription: e.target.value } }))} className="glass-input" placeholder="e.g. Covers manufacturing defects" maxLength={200} />
                                    </div>
                                </div>
                            )}
                            <div>
                                <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'hsl(var(--muted-foreground))' }}>Policy Description (Optional)</label>
                                <textarea value={storeData.returnPolicy.policyDescription} onChange={e => setStoreData(prev => ({ ...prev, returnPolicy: { ...prev.returnPolicy, policyDescription: e.target.value } }))} rows={2} className="glass-input" placeholder="Additional policy details..." maxLength={500} />
                            </div>
                        </div>
                    </div>

                    {/* Social Links */}
                    <div style={{ borderTop: '1px solid var(--glass-border)', paddingTop: '1.5rem' }}>
                        <h3 className="text-lg font-semibold mb-4 flex items-center gap-2" style={{ color: 'hsl(var(--foreground))' }}>
                            <ExternalLink size={20} /> Social Links & Website
                        </h3>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {[
                                { key: 'website', label: 'Website', placeholder: 'yourwebsite.com or full link' },
                                { key: 'facebook', label: 'Facebook', placeholder: 'page name or full link' },
                                { key: 'instagram', label: 'Instagram', placeholder: '@handle or full link' },
                                { key: 'twitter', label: 'Twitter/X', placeholder: '@handle or full link' },
                                { key: 'youtube', label: 'YouTube', placeholder: '@channel or full link' },
                                { key: 'tiktok', label: 'TikTok', placeholder: '@handle or full link' },
                            ].map(social => (
                                <div key={social.key}>
                                    <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'hsl(var(--muted-foreground))' }}>{social.label}</label>
                                    <input type="text" value={storeData.socialLinks[social.key]} onChange={(e) => handleSocialLinkChange(social.key, e.target.value)} className="glass-input" placeholder={social.placeholder} />
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* Action Buttons */}
                    <div className="flex flex-col sm:flex-row gap-3 sm:gap-4 pt-4" style={{ borderTop: '1px solid var(--glass-border)' }}>
                        <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} onClick={handleSave}
                            disabled={saving || uploadingLogo || uploadingBanner}
                            className="flex-1 px-4 sm:px-6 py-3 rounded-xl text-white font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 text-sm sm:text-base"
                            style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(200, 80%, 50%))', boxShadow: '0 0 20px -4px hsl(220, 70%, 55%, 0.3)' }}>
                            {saving ? <><Loader2 className="animate-spin" size={20} /> Saving...</> : <>{hasStore ? 'Update Store' : 'Create Store'}</>}
                        </motion.button>

                        {hasStore && storeData.storeSlug && (
                            <a href={`https://${storeData.storeSlug}.rozare.com`} target="_blank" rel="noreferrer"
                                className="px-4 sm:px-6 py-3 rounded-xl text-white font-semibold transition-all flex items-center justify-center gap-2 text-sm sm:text-base"
                                style={{ background: 'linear-gradient(135deg, hsl(260, 60%, 55%), hsl(280, 50%, 55%))', boxShadow: '0 0 20px -4px hsl(260, 60%, 55%, 0.3)' }}>
                                <Eye size={20} /><span className="hidden sm:inline">Preview Store</span><span className="sm:hidden">Preview</span>
                            </a>
                        )}

                        {/* Delete Store button hidden - sellers should not be able to delete their store */}
                        {/* {hasStore && (
                            <button onClick={() => setShowDeleteConfirm(true)}
                                className="px-4 sm:px-6 py-3 rounded-xl font-semibold transition-all flex items-center justify-center gap-2 text-sm sm:text-base"
                                style={{ background: 'rgba(239, 68, 68, 0.12)', color: 'hsl(0, 72%, 55%)' }}>
                                <Trash2 size={20} /><span>Delete</span>
                            </button>
                        )} */}
                    </div>
                </div>
            </div>
            )}


            {/* Delete Confirmation Modal */}
            {showDeleteConfirm && (
                <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
                    <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="glass-panel p-6 max-w-md w-full">
                        <h3 className="text-xl font-bold mb-4" style={{ color: 'hsl(var(--foreground))' }}>Delete Store?</h3>
                        <p className="mb-6 text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>Are you sure? This action cannot be undone. Products will remain but won't be associated with a store.</p>
                        <div className="flex gap-4">
                            <button onClick={() => setShowDeleteConfirm(false)} className="flex-1 px-4 py-2 rounded-xl glass-inner font-medium" style={{ color: 'hsl(var(--foreground))' }}>Cancel</button>
                            <button onClick={handleDelete} className="flex-1 px-4 py-2 rounded-xl text-white font-medium" style={{ background: 'hsl(0, 72%, 55%)' }}>Delete Store</button>
                        </div>
                    </motion.div>
                </div>
            )}

            {/* Verification Modal */}
            {showVerificationModal && (
                <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
                    <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="glass-panel p-6 max-w-md w-full">
                        <h3 className="text-xl font-bold mb-4 flex items-center gap-2" style={{ color: 'hsl(var(--foreground))' }}>
                            <CheckCircle size={22} style={{ color: 'hsl(var(--primary))' }} /> Apply for Verification
                        </h3>
                        <p className="text-sm mb-4" style={{ color: 'hsl(var(--muted-foreground))' }}>Tell us why your store should be verified.</p>

                        <div className="mb-4">
                            <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'hsl(var(--muted-foreground))' }}>Contact Email *</label>
                            <input type="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} className="glass-input" placeholder="your@email.com" required />
                        </div>
                        <div className="mb-4">
                            <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'hsl(var(--muted-foreground))' }}>Contact Phone *</label>
                            <PhoneField
                                value={contactPhone}
                                onChange={(v) => setContactPhone(v || '')}
                                required
                                placeholder="Contact phone"
                            />
                        </div>
                        <div className="mb-4">
                            <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'hsl(var(--muted-foreground))' }}>Application Message *</label>
                            <textarea value={applicationMessage} onChange={(e) => setApplicationMessage(e.target.value)} rows={4} className="glass-input" placeholder="Explain why your store should be verified..." maxLength={500} required />
                            <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>{applicationMessage.length}/500</p>
                        </div>
                        <div className="flex gap-4">
                            <button onClick={() => { setShowVerificationModal(false); setApplicationMessage(''); setContactEmail(''); setContactPhone(''); }}
                                className="flex-1 px-4 py-2 rounded-xl glass-inner font-medium" style={{ color: 'hsl(var(--foreground))' }} disabled={applyingVerification}>Cancel</button>
                            <button onClick={handleApplyVerification} disabled={applyingVerification || !applicationMessage.trim() || !contactEmail.trim() || !contactPhone.trim()}
                                className="flex-1 px-4 py-2 rounded-xl text-white font-medium disabled:opacity-50 flex items-center justify-center gap-2"
                                style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(200, 80%, 50%))' }}>
                                {applyingVerification ? <><Loader2 className="animate-spin" size={16} /> Submitting...</> : 'Submit Application'}
                            </button>
                        </div>
                    </motion.div>
                </div>
            )}

            {/* Cooldown Confirmation Modal */}
            {showCooldownModal && (
                <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
                    <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="glass-panel p-6 max-w-md w-full">
                        <h3 className="text-xl font-bold mb-3 flex items-center gap-2" style={{ color: 'hsl(var(--foreground))' }}>
                            <AlertTriangle size={22} style={{ color: 'hsl(45, 80%, 45%)' }} /> Heads up — change cooldown
                        </h3>
                        <p className="text-sm mb-4" style={{ color: 'hsl(var(--muted-foreground))' }}>
                            Once you save, you won't be able to change the following again for the time noted:
                        </p>
                        <ul className="space-y-2 mb-5">
                            {pendingChanges.map(c => (
                                <li key={c.field} className="glass-inner rounded-xl px-4 py-3 flex items-center justify-between">
                                    <span className="text-sm font-semibold capitalize" style={{ color: 'hsl(var(--foreground))' }}>{c.label}</span>
                                    <span className="text-xs font-bold px-2.5 py-1 rounded-full"
                                        style={{ background: 'rgba(234,179,8,0.12)', color: 'hsl(45, 80%, 40%)' }}>
                                        Locked for {c.days} day{c.days === 1 ? '' : 's'}
                                    </span>
                                </li>
                            ))}
                        </ul>
                        <div className="flex gap-3">
                            <button onClick={() => { setShowCooldownModal(false); setPendingChanges([]); }} disabled={saving}
                                className="flex-1 px-4 py-2.5 rounded-xl glass-inner font-medium" style={{ color: 'hsl(var(--foreground))' }}>
                                Cancel
                            </button>
                            <button onClick={doSave} disabled={saving}
                                className="flex-1 px-4 py-2.5 rounded-xl text-white font-semibold disabled:opacity-50 flex items-center justify-center gap-2"
                                style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(200, 80%, 50%))' }}>
                                {saving ? <><Loader2 size={14} className="animate-spin" /> Saving...</> : 'Confirm & Save'}
                            </button>
                        </div>
                    </motion.div>
                </div>
            )}
        </div>
    );
};

export default StoreSettings;
