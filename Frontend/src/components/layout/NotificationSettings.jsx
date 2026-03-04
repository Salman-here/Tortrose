import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import {
    Bell, Package, ShoppingBag, Store, Shield,
    Settings, Save, CheckCircle, Loader2
} from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { toast } from 'react-toastify';
import axios from 'axios';

const defaultPrefs = {
    stockAlerts: true,
    lowStockAlerts: true,
    orderAlerts: true,
    paymentAlerts: true,
    deliveryAlerts: true,
    storeCreation: true,
    storeVerification: true,
};

const NotificationSettings = () => {
    const location = useLocation();
    const isAdmin = location.pathname.includes('admin-dashboard');

    const [prefs, setPrefs] = useState(defaultPrefs);
    const [saved, setSaved] = useState(false);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    // Fetch prefs from backend
    useEffect(() => {
        const fetchPrefs = async () => {
            const token = localStorage.getItem('jwtToken');
            try {
                const res = await axios.get(`${import.meta.env.VITE_API_URL}api/analytics/notification-prefs`, {
                    headers: { Authorization: `Bearer ${token}` }
                });
                setPrefs({ ...defaultPrefs, ...res.data.prefs });
            } catch {
                // Fallback to defaults
            } finally {
                setLoading(false);
            }
        };
        fetchPrefs();
    }, []);

    const handleToggle = (key) => {
        setPrefs(prev => ({ ...prev, [key]: !prev[key] }));
        setSaved(false);
    };

    const handleSave = async () => {
        setSaving(true);
        const token = localStorage.getItem('jwtToken');
        try {
            await axios.put(`${import.meta.env.VITE_API_URL}api/analytics/notification-prefs`,
                { prefs },
                { headers: { Authorization: `Bearer ${token}` } }
            );
            setSaved(true);
            toast.success('Notification preferences saved');
            setTimeout(() => setSaved(false), 2000);
        } catch {
            toast.error('Failed to save preferences');
        } finally {
            setSaving(false);
        }
    };

    const handleResetDefaults = async () => {
        setPrefs(defaultPrefs);
        const token = localStorage.getItem('jwtToken');
        try {
            await axios.put(`${import.meta.env.VITE_API_URL}api/analytics/notification-prefs`,
                { prefs: defaultPrefs },
                { headers: { Authorization: `Bearer ${token}` } }
            );
            toast.info('Reset to defaults');
        } catch {
            toast.error('Failed to reset');
        }
    };

    const sections = [
        {
            title: 'Stock Alerts',
            description: 'Get notified about inventory changes',
            items: [
                { key: 'stockAlerts', label: 'Out of stock alerts', description: 'When a product runs out of stock', icon: <Package size={16} /> },
                { key: 'lowStockAlerts', label: 'Low stock warnings', description: 'When stock drops below 10 units', icon: <Package size={16} /> },
            ]
        },
        {
            title: 'Order Alerts',
            description: 'Stay updated on order activity',
            items: [
                { key: 'orderAlerts', label: 'New order notifications', description: 'When new orders are placed', icon: <ShoppingBag size={16} /> },
                { key: 'paymentAlerts', label: 'Payment confirmations', description: 'When payments are received', icon: <CheckCircle size={16} /> },
                { key: 'deliveryAlerts', label: 'Delivery updates', description: 'When orders are delivered', icon: <ShoppingBag size={16} /> },
            ]
        },
        ...(isAdmin ? [{
            title: 'Store Alerts',
            description: 'Admin-specific store notifications',
            items: [
                { key: 'storeCreation', label: 'New store creation', description: 'When sellers create new stores', icon: <Store size={16} /> },
                { key: 'storeVerification', label: 'Store verification requests', description: 'When stores need verification review', icon: <Shield size={16} /> },
            ]
        }] : []),
    ];

    if (loading) {
        return (
            <div className="flex items-center justify-center min-h-[60vh]">
                <Loader2 size={32} className="animate-spin" style={{ color: 'hsl(var(--muted-foreground))' }} />
            </div>
        );
    }

    return (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="p-4 sm:p-6 max-w-3xl mx-auto space-y-6">
            {/* Header */}
            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
                <div className="tag-pill mb-2"><Settings size={12} /> Settings</div>
                <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight" style={{ color: 'hsl(var(--foreground))' }}>
                    Notification Settings
                </h1>
                <p className="text-sm mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                    Choose which notifications you want to receive
                </p>
            </motion.div>

            {/* Sections */}
            {sections.map((section, si) => (
                <motion.div key={section.title} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: si * 0.1 }}
                    className="glass-panel water-shimmer overflow-hidden">
                    <div className="p-5 sm:p-6" style={{ borderBottom: '1px solid var(--glass-border)' }}>
                        <h3 className="text-base font-semibold" style={{ color: 'hsl(var(--foreground))' }}>{section.title}</h3>
                        <p className="text-xs mt-0.5" style={{ color: 'hsl(var(--muted-foreground))' }}>{section.description}</p>
                    </div>
                    <div className="divide-y" style={{ borderColor: 'var(--glass-border-subtle)' }}>
                        {section.items.map(item => (
                            <div key={item.key} className="flex items-center justify-between px-5 sm:px-6 py-4">
                                <div className="flex items-center gap-3">
                                    <div className="p-2 rounded-xl" style={{
                                        background: prefs[item.key] ? 'rgba(99,102,241,0.12)' : 'rgba(255,255,255,0.05)',
                                        color: prefs[item.key] ? 'hsl(220,70%,55%)' : 'hsl(var(--muted-foreground))'
                                    }}>
                                        {item.icon}
                                    </div>
                                    <div>
                                        <p className="text-sm font-medium" style={{ color: 'hsl(var(--foreground))' }}>{item.label}</p>
                                        <p className="text-[11px]" style={{ color: 'hsl(var(--muted-foreground))' }}>{item.description}</p>
                                    </div>
                                </div>
                                <motion.button
                                    whileTap={{ scale: 0.9 }}
                                    onClick={() => handleToggle(item.key)}
                                    className="relative w-12 h-7 rounded-full transition-all duration-300"
                                    style={{
                                        background: prefs[item.key]
                                            ? 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(200, 80%, 50%))'
                                            : 'rgba(255,255,255,0.1)',
                                        border: `1px solid ${prefs[item.key] ? 'rgba(99,102,241,0.4)' : 'rgba(255,255,255,0.15)'}`,
                                    }}>
                                    <motion.div
                                        animate={{ x: prefs[item.key] ? 22 : 2 }}
                                        transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                                        className="absolute top-1 w-5 h-5 rounded-full"
                                        style={{
                                            background: prefs[item.key] ? 'white' : 'hsl(var(--muted-foreground))',
                                            boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                                        }}
                                    />
                                </motion.button>
                            </div>
                        ))}
                    </div>
                </motion.div>
            ))}

            {/* Actions */}
            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }}
                className="flex items-center justify-between gap-3">
                <motion.button whileTap={{ scale: 0.95 }} onClick={handleResetDefaults}
                    className="px-4 py-2.5 rounded-xl text-sm font-medium glass-inner"
                    style={{ color: 'hsl(var(--muted-foreground))' }}>
                    Reset to defaults
                </motion.button>
                <motion.button whileTap={{ scale: 0.95 }} onClick={handleSave} disabled={saving}
                    className="px-6 py-2.5 rounded-xl text-sm font-semibold text-white flex items-center gap-2 disabled:opacity-60"
                    style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(200, 80%, 50%))', boxShadow: '0 0 20px -4px hsl(220, 70%, 55%, 0.3)' }}>
                    {saving ? <><Loader2 size={16} className="animate-spin" /> Saving...</> : saved ? <><CheckCircle size={16} /> Saved!</> : <><Save size={16} /> Save Preferences</>}
                </motion.button>
            </motion.div>
        </motion.div>
    );
};

export default NotificationSettings;
