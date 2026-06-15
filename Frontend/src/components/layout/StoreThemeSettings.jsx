import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Check, Crown, Eye, LayoutTemplate, Lock, Palette, Save, SlidersHorizontal } from 'lucide-react';
import axios from 'axios';
import { toast } from 'react-toastify';
import { Link } from 'react-router-dom';
import { getAuthToken } from '../../utils/cookieHelper';
import {
    CUSTOM_STORE_THEME_ID,
    DEFAULT_STORE_THEME_ID,
    STORE_THEME_LAYOUTS,
    STORE_THEMES,
    getStoreTheme,
    makeCustomThemeDraft,
} from '../../utils/storeThemes';

const colorFields = [
    { key: 'primary', label: 'Primary' },
    { key: 'secondary', label: 'Secondary' },
    { key: 'accent', label: 'Accent' },
    { key: 'background', label: 'Background' },
    { key: 'surface', label: 'Surface' },
    { key: 'text', label: 'Text' },
];

const isEliteThemeEligible = (subscription) => (
    subscription?.plan === 'elite' && ['active', 'free_period'].includes(subscription?.status)
);

const THEMES_COMING_SOON = true;

const ThemePreview = ({ theme, selected, saving, onSelect, disabled = false }) => (
    <motion.button
        type="button"
        whileHover={disabled ? {} : { y: -3 }}
        whileTap={disabled ? {} : { scale: 0.98 }}
        onClick={disabled ? undefined : onSelect}
        disabled={saving || disabled}
        className={`text-left rounded-2xl p-3 border transition-all overflow-hidden relative ${disabled ? 'cursor-not-allowed opacity-90' : ''}`}
        style={{
            background: theme.palette.panel || 'rgba(255,255,255,0.68)',
            borderColor: selected ? theme.palette.primary : 'var(--glass-border)',
            boxShadow: selected ? `0 18px 45px -28px ${theme.colors.primary}` : '0 18px 45px -34px rgba(15,23,42,0.45)',
        }}
    >
        {disabled && (
            <span className="absolute right-3 top-3 z-10 px-2 py-1 rounded-full text-[10px] font-bold"
                style={{ background: 'rgba(15,23,42,0.72)', color: 'white' }}>
                Coming soon
            </span>
        )}
        <div className="h-24 rounded-xl overflow-hidden relative mb-3" style={{ background: theme.palette.pageBackground || theme.palette.heroGradient }}>
            <div className="absolute inset-x-3 top-3 h-8 rounded-xl backdrop-blur-md" style={{ background: 'rgba(255,255,255,0.52)', border: '1px solid rgba(255,255,255,0.4)' }} />
            <div className="absolute left-5 top-5 h-4 w-16 rounded-full" style={{ background: theme.palette.heroGradient }} />
            <div className="absolute right-5 top-5 h-4 w-10 rounded-full" style={{ background: theme.palette.accent }} />
            <div className="absolute left-4 bottom-4 right-4 grid grid-cols-3 gap-2">
                {[0, 1, 2].map(i => (
                    <div key={i} className="h-9 rounded-lg backdrop-blur-md" style={{ background: 'rgba(255,255,255,0.6)', border: '1px solid rgba(255,255,255,0.36)' }}>
                        <div className="h-2 rounded-full mt-5 mx-2" style={{ background: i === 1 ? theme.palette.accent : theme.palette.primary, opacity: 0.55 }} />
                    </div>
                ))}
            </div>
        </div>
        <div className="flex items-start justify-between gap-2">
            <div>
                <h3 className="text-sm font-bold" style={{ color: theme.palette.text }}>{theme.name}</h3>
                <p className="text-[11px] mt-1 leading-relaxed" style={{ color: theme.palette.muted }}>{theme.tagline}</p>
            </div>
            {selected && (
                <span className="shrink-0 inline-flex items-center justify-center w-6 h-6 rounded-full text-white" style={{ background: theme.palette.accentGradient }}>
                    <Check size={13} />
                </span>
            )}
        </div>
        <div className="mt-3 flex items-center justify-between gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: theme.palette.muted }}>
                {theme.layout}
            </span>
            <span className="inline-flex gap-1">
                {Object.values(theme.colors).slice(0, 4).map(color => (
                    <span key={color} className="w-4 h-4 rounded-full border" style={{ background: color, borderColor: 'rgba(0,0,0,0.08)' }} />
                ))}
            </span>
        </div>
    </motion.button>
);

const StoreThemeSettings = ({ storeData, setStoreData, hasStore, blockedInfo }) => {
    const [subscription, setSubscription] = useState(null);
    const [subscriptionLoading, setSubscriptionLoading] = useState(true);
    const [savingThemeId, setSavingThemeId] = useState(null);
    const activeTheme = useMemo(() => getStoreTheme(storeData.storeTheme), [storeData.storeTheme]);
    const [customDraft, setCustomDraft] = useState(() => makeCustomThemeDraft(activeTheme));

    const selectedThemeId = storeData.storeTheme?.themeId || DEFAULT_STORE_THEME_ID;
    const canUseCustomTheme = isEliteThemeEligible(subscription);
    const themeActionsDisabled = THEMES_COMING_SOON;
    const customPreview = useMemo(() => getStoreTheme({
        themeId: CUSTOM_STORE_THEME_ID,
        customTheme: customDraft,
    }), [customDraft]);

    useEffect(() => {
        const fetchSubscription = async () => {
            try {
                setSubscriptionLoading(true);
                const token = getAuthToken();
                const res = await axios.get(`${import.meta.env.VITE_API_URL}api/subscription/status`, {
                    headers: { Authorization: `Bearer ${token}` },
                });
                setSubscription(res.data.subscription);
            } catch (error) {
                console.error('Error fetching subscription for theme settings:', error);
                setSubscription(null);
            } finally {
                setSubscriptionLoading(false);
            }
        };
        fetchSubscription();
    }, []);

    useEffect(() => {
        if (selectedThemeId === CUSTOM_STORE_THEME_ID) {
            setCustomDraft(makeCustomThemeDraft(activeTheme));
        }
    }, [selectedThemeId]);

    const saveTheme = async (payload, savingId) => {
        if (themeActionsDisabled) {
            toast.info('Store themes are coming soon. You can preview them here for now.');
            return;
        }
        if (!hasStore) {
            toast.error('Create your store before selecting a theme.');
            return;
        }
        if (blockedInfo?.blocked) {
            toast.error('Reactivate your subscription before changing the store theme.');
            return;
        }

        try {
            setSavingThemeId(savingId);
            const token = getAuthToken();
            const res = await axios.put(
                `${import.meta.env.VITE_API_URL}api/stores/update`,
                { storeTheme: payload },
                { headers: { Authorization: `Bearer ${token}` } }
            );
            const savedTheme = res.data.store?.storeTheme || payload;
            setStoreData(prev => ({ ...prev, storeTheme: savedTheme }));
            toast.success('Store theme updated');
        } catch (error) {
            toast.error(error.response?.data?.msg || 'Failed to update store theme');
        } finally {
            setSavingThemeId(null);
        }
    };

    const selectPreset = (themeId) => {
        saveTheme({ themeId, customTheme: null }, themeId);
    };

    const saveCustomTheme = () => {
        if (!canUseCustomTheme) {
            toast.error('Custom themes are available on Rozare Elite only.');
            return;
        }
        saveTheme({ themeId: CUSTOM_STORE_THEME_ID, customTheme: customDraft }, CUSTOM_STORE_THEME_ID);
    };

    const startFromSelectedTheme = () => {
        setCustomDraft(makeCustomThemeDraft(activeTheme));
    };

    return (
        <div className="space-y-6">
            <div className="glass-panel p-6 md:p-8">
                <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-6">
                    <div>
                        <h2 className="text-xl font-bold flex items-center gap-2" style={{ color: 'hsl(var(--foreground))' }}>
                            <Palette size={22} style={{ color: 'hsl(220, 70%, 55%)' }} />
                            Professional Store Themes
                        </h2>
                        <p className="text-sm mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                            Preview 10 polished glass storefronts. Theme switching is coming soon.
                        </p>
                    </div>
                    {hasStore && storeData.storeSlug && (
                        <span
                            className="px-4 py-2.5 rounded-xl text-sm font-semibold inline-flex items-center justify-center gap-2 cursor-not-allowed"
                            style={{ background: 'rgba(255,255,255,0.08)', color: 'hsl(var(--muted-foreground))', border: '1px solid var(--glass-border)' }}>
                            <Lock size={16} /> Coming Soon
                        </span>
                    )}
                </div>

                <div className="rounded-2xl p-4 mb-5 flex items-start gap-3"
                    style={{ background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.20)' }}>
                    <Lock size={18} className="mt-0.5 shrink-0" style={{ color: 'hsl(220, 70%, 55%)' }} />
                    <p className="text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>
                        Theme selection and custom theme editing are preview-only for now. Sellers cannot change or save themes until this feature is released.
                    </p>
                </div>

                <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    {STORE_THEMES.map(theme => (
                        <ThemePreview
                            key={theme.id}
                            theme={theme}
                            selected={selectedThemeId === theme.id}
                            saving={savingThemeId === theme.id}
                            onSelect={() => selectPreset(theme.id)}
                            disabled={themeActionsDisabled}
                        />
                    ))}
                </div>
            </div>

            <div className="glass-panel p-6 md:p-8 relative overflow-hidden">
                <div className="flex flex-col lg:flex-row gap-6">
                    <div className="lg:w-[330px] shrink-0">
                        <div className="flex items-center gap-2 mb-2">
                            <SlidersHorizontal size={20} style={{ color: 'hsl(270, 60%, 55%)' }} />
                            <h2 className="text-xl font-bold" style={{ color: 'hsl(var(--foreground))' }}>Custom Theme</h2>
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold"
                                style={{ background: 'rgba(139,92,246,0.12)', color: 'hsl(270, 60%, 55%)' }}>
                                <Crown size={10} /> Elite
                            </span>
                        </div>
                        <p className="text-sm leading-relaxed mb-4" style={{ color: 'hsl(var(--muted-foreground))' }}>
                            Create your own soft-color storefront by adjusting colors and layout from any existing theme.
                        </p>
                        <ThemePreview
                            theme={customPreview}
                            selected={selectedThemeId === CUSTOM_STORE_THEME_ID}
                            saving={savingThemeId === CUSTOM_STORE_THEME_ID}
                            onSelect={() => {}}
                            disabled={themeActionsDisabled}
                        />
                    </div>

                    <div className="flex-1 min-w-0">
                        {themeActionsDisabled ? (
                            <div className="rounded-2xl p-5 h-full flex flex-col justify-center" style={{ background: 'rgba(139,92,246,0.07)', border: '1px solid rgba(139,92,246,0.2)' }}>
                                <div className="w-11 h-11 rounded-2xl flex items-center justify-center mb-3" style={{ background: 'rgba(139,92,246,0.14)', color: 'hsl(270, 60%, 55%)' }}>
                                    <Lock size={20} />
                                </div>
                                <h3 className="text-base font-bold" style={{ color: 'hsl(var(--foreground))' }}>Custom themes are coming soon</h3>
                                <p className="text-sm mt-2" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                    Elite sellers will be able to customize colors and layouts when the theme builder is released.
                                </p>
                            </div>
                        ) : !canUseCustomTheme ? (
                            <div className="rounded-2xl p-5 h-full flex flex-col justify-center" style={{ background: 'rgba(139,92,246,0.07)', border: '1px solid rgba(139,92,246,0.2)' }}>
                                <div className="w-11 h-11 rounded-2xl flex items-center justify-center mb-3" style={{ background: 'rgba(139,92,246,0.14)', color: 'hsl(270, 60%, 55%)' }}>
                                    <Lock size={20} />
                                </div>
                                <h3 className="text-base font-bold" style={{ color: 'hsl(var(--foreground))' }}>Custom themes unlock with Rozare Elite</h3>
                                <p className="text-sm mt-2 mb-4" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                    All sellers can use the 10 professional themes. Elite subscribers can customize colors and layouts or save a custom theme.
                                </p>
                                {!subscriptionLoading && (
                                    <Link to="/seller-dashboard/subscription"
                                        className="w-fit px-4 py-2.5 rounded-xl text-white text-sm font-semibold inline-flex items-center gap-2"
                                        style={{ background: 'linear-gradient(135deg, hsl(270, 60%, 55%), hsl(290, 50%, 50%))' }}>
                                        <Crown size={16} /> Upgrade to Elite
                                    </Link>
                                )}
                            </div>
                        ) : (
                            <div className="space-y-4">
                                <div className="grid md:grid-cols-2 gap-4">
                                    <div>
                                        <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'hsl(var(--muted-foreground))' }}>Theme Name</label>
                                        <input
                                            type="text"
                                            maxLength={40}
                                            value={customDraft.name}
                                            onChange={(e) => setCustomDraft(prev => ({ ...prev, name: e.target.value }))}
                                            className="glass-input"
                                            placeholder="My custom theme"
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'hsl(var(--muted-foreground))' }}>Layout</label>
                                        <select
                                            value={customDraft.layout}
                                            onChange={(e) => setCustomDraft(prev => ({ ...prev, layout: e.target.value }))}
                                            className="glass-input cursor-pointer"
                                        >
                                            {STORE_THEME_LAYOUTS.map(layout => (
                                                <option key={layout.id} value={layout.id}>{layout.label}</option>
                                            ))}
                                        </select>
                                    </div>
                                </div>

                                <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-4">
                                    {colorFields.map(field => (
                                        <label key={field.key} className="glass-inner rounded-xl p-3 flex items-center gap-3 cursor-pointer">
                                            <input
                                                type="color"
                                                value={customDraft.colors[field.key]}
                                                onChange={(e) => setCustomDraft(prev => ({
                                                    ...prev,
                                                    colors: { ...prev.colors, [field.key]: e.target.value },
                                                }))}
                                                className="w-11 h-11 rounded-xl border-0 bg-transparent cursor-pointer"
                                            />
                                            <span>
                                                <span className="block text-xs font-bold" style={{ color: 'hsl(var(--foreground))' }}>{field.label}</span>
                                                <span className="block text-[11px] font-mono mt-0.5" style={{ color: 'hsl(var(--muted-foreground))' }}>{customDraft.colors[field.key]}</span>
                                            </span>
                                        </label>
                                    ))}
                                </div>

                                <div className="flex flex-col sm:flex-row gap-3 pt-2">
                                    <button type="button" onClick={startFromSelectedTheme}
                                        className="px-4 py-2.5 rounded-xl text-sm font-semibold inline-flex items-center justify-center gap-2"
                                        style={{ background: 'var(--glass-inner)', color: 'hsl(var(--foreground))', border: '1px solid var(--glass-border)' }}>
                                        <LayoutTemplate size={16} /> Start from selected theme
                                    </button>
                                    <button type="button" onClick={saveCustomTheme} disabled={savingThemeId === CUSTOM_STORE_THEME_ID}
                                        className="px-4 py-2.5 rounded-xl text-white text-sm font-semibold inline-flex items-center justify-center gap-2 disabled:opacity-60"
                                        style={{ background: customPreview.palette.accentGradient }}>
                                        <Save size={16} /> {savingThemeId === CUSTOM_STORE_THEME_ID ? 'Saving...' : 'Save Custom Theme'}
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};

export default StoreThemeSettings;
