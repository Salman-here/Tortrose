import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
    User, Mail, Lock, Eye, EyeOff, Edit3, Save, X, Loader as LucideLoader,
    Camera, User as UserIcon, Shield, Sparkles, CheckCircle, AlertCircle,
    MapPin, Phone, Home, Ban
} from 'lucide-react';
import { Link } from 'react-router-dom';
import Loader from '../common/Loader';
import PhoneField from '../common/PhoneField';
import { useAuth } from '../../contexts/AuthContext';
import axios from 'axios';
import { toast } from 'react-toastify';
import { getAuthToken } from "../../utils/cookieHelper";

const UserProfile = () => {
    const { currentUser, fetchAndUpdateCurrentUser } = useAuth();
    const [userData, setUserData] = useState(currentUser);
    const [isEditing, setIsEditing] = useState(false);
    const [showPasswordFields, setShowPasswordFields] = useState(false);
    const [showCurrentPassword, setShowCurrentPassword] = useState(false);
    const [showNewPassword, setShowNewPassword] = useState(false);
    const [showConfirmPassword, setShowConfirmPassword] = useState(false);
    const [loading, setLoading] = useState(true);
    const [formData, setFormData] = useState({
        username: currentUser?.username || '', email: currentUser?.email || '',
        currentPassword: '', newPassword: '', confirmPassword: ''
    });
    const [isUploading, setIsUploading] = useState(false);
    const [isWaiting, setIsWaiting] = useState(false);

    // Shipping info state
    const [shippingInfo, setShippingInfo] = useState(null);
    const [isEditingShipping, setIsEditingShipping] = useState(false);
    const [shippingForm, setShippingForm] = useState({
        fullName: '', email: '', phone: '', address: '', city: '', state: '', postalCode: '', country: 'Pakistan'
    });
    const [savingShipping, setSavingShipping] = useState(false);

    const handleInputChange = (e) => { const { name, value } = e.target; setFormData(prev => ({ ...prev, [name]: value })); };

    const fetchUser = async () => {
        try {
            setLoading(true);
            const token = getAuthToken();
            const res = await axios.get(`${import.meta.env.VITE_API_URL}api/user/single`, { headers: { Authorization: `Bearer ${token}` } });
            setUserData(res.data?.user);
            setFormData(prev => ({ ...prev, username: res.data?.user?.username || '', email: res.data?.user?.email || '' }));
            fetchAndUpdateCurrentUser();
        } catch (error) { console.error(error); }
        finally { setIsWaiting(false); setLoading(false); }
    };

    useEffect(() => { fetchUser(); fetchShippingInfo(); }, []);

    const fetchShippingInfo = async () => {
        try {
            const token = getAuthToken();
            const res = await axios.get(`${import.meta.env.VITE_API_URL}api/user/shipping-info`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            const info = res.data.shippingInfo;
            if (info && info.fullName) {
                setShippingInfo(info);
                setShippingForm(info);
            }
        } catch (e) { console.error(e); }
    };

    const handleShippingChange = (e) => {
        const { name, value } = e.target;
        setShippingForm(prev => ({ ...prev, [name]: value }));
    };

    const handleSaveShipping = async (e) => {
        e.preventDefault();
        setSavingShipping(true);
        try {
            const token = getAuthToken();
            await axios.patch(`${import.meta.env.VITE_API_URL}api/user/shipping-info`,
                { shippingInfo: shippingForm },
                { headers: { Authorization: `Bearer ${token}` } }
            );
            toast.success('Shipping info saved!');
            setShippingInfo(shippingForm);
            setIsEditingShipping(false);
        } catch (e) { toast.error('Failed to save shipping info'); }
        finally { setSavingShipping(false); }
    };

    const handleImageUpload = async (e) => {
        const file = e.target.files[0];
        if (file) {
            setIsUploading(true);
            try {
                const fd = new FormData();
                fd.append('profileImage', file);
                const token = getAuthToken();
                await axios.post(`${import.meta.env.VITE_API_URL}api/upload/profile-image`, fd, { headers: { 'Content-Type': 'multipart/form-data', Authorization: `Bearer ${token}` } });
                setIsWaiting(true);
                fetchUser();
            } catch (error) { console.error(error); toast.error('Failed to upload profile picture.'); }
            finally { setIsUploading(false); }
        }
    };

    const handleSave = async (e) => {
        e.preventDefault();
        if (userData.username === formData.username) return toast.error('Username is same as before!');
        try {
            const token = getAuthToken();
            const res = await axios.patch(`${import.meta.env.VITE_API_URL}api/user/update`, { username: formData.username }, { headers: { Authorization: `Bearer ${token}` } });
            toast.success(res?.data?.msg || 'Username updated successfully');
            fetchUser();
        } catch (error) { console.error(error); toast.error(error.response?.data?.msg || 'Server error'); }
        setIsEditing(false);
    };

    const handleCancel = () => {
        setFormData(prev => ({ ...prev, username: userData.username, email: userData.email, currentPassword: '', newPassword: '', confirmPassword: '' }));
        setIsEditing(false);
        setShowPasswordFields(false);
    };

    const handlePasswordUpdate = async (e) => {
        e.preventDefault();
        try {
            const token = getAuthToken();
            const res = await axios.patch(`${import.meta.env.VITE_API_URL}api/password/change`, {
                currentPassword: formData.currentPassword, newPassword: formData.newPassword, confirmPassword: formData.confirmPassword
            }, { headers: { Authorization: `Bearer ${token}` } });
            toast.success(res.data?.msg || 'Password updated successfully.');
            setShowPasswordFields(false);
            setFormData(prev => ({ ...prev, currentPassword: '', newPassword: '', confirmPassword: '' }));
        } catch (error) { console.error(error); toast.error(error.response?.data?.msg || 'Server error'); }
    };

    if (loading) {
        return (
            <div className="min-h-screen flex items-center justify-center">
                <Loader />
            </div>
        );
    }

    const avatarUrl = userData?.avatar || userData?.profilePicture;
    const memberSince = userData?.createdAt
        ? new Date(userData.createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long' })
        : 'Recently';

    return (
        <div className="min-h-screen p-4 sm:p-6 lg:p-8">
            <motion.div className="max-w-4xl mx-auto space-y-6"
                initial={{ opacity: 0 }} animate={{ opacity: 1 }}>

                {/* Header */}
                <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
                    <div className="tag-pill mb-3"><Sparkles size={12} /> Profile</div>
                    <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight" style={{ color: 'hsl(var(--foreground))' }}>
                        Profile Settings
                    </h1>
                    <p className="text-sm mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                        Manage your account information and security
                    </p>
                </motion.div>

                {/* Profile Hero Card */}
                <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }}
                    className="glass-panel-strong water-shimmer p-6 sm:p-8">
                    <div className="flex flex-col sm:flex-row items-center gap-6">
                        {/* Avatar */}
                        <div className="relative group">
                            <div className="w-28 h-28 sm:w-32 sm:h-32 rounded-2xl overflow-hidden"
                                style={{ border: '3px solid var(--glass-border-strong)', boxShadow: 'var(--glass-shadow-lg)' }}>
                                {(isWaiting || isUploading) && (
                                    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center rounded-2xl"
                                        style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)' }}>
                                        <LucideLoader className="animate-spin" size={24} style={{ color: 'white' }} />
                                        <p className="text-[10px] mt-1 text-white/80">Updating</p>
                                    </div>
                                )}
                                {avatarUrl ? (
                                    <img src={avatarUrl} alt="Profile" className="w-full h-full object-cover" />
                                ) : (
                                    <div className="w-full h-full glass-inner flex items-center justify-center">
                                        <UserIcon size={48} style={{ color: 'hsl(var(--muted-foreground))' }} />
                                    </div>
                                )}
                            </div>
                            <label htmlFor="profile-upload"
                                className="absolute -bottom-2 -right-2 p-2.5 rounded-xl cursor-pointer shadow-lg transition-all hover:scale-110"
                                style={{
                                    background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))',
                                    color: 'white', boxShadow: '0 0 20px -4px hsl(220, 70%, 55%, 0.4)'
                                }}>
                                {isUploading
                                    ? <div className="h-4 w-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                                    : <Camera size={16} />}
                                <input id="profile-upload" type="file" accept="image/*" onChange={handleImageUpload} className="hidden" disabled={isUploading} />
                            </label>
                        </div>

                        {/* User Info Summary */}
                        <div className="flex-1 text-center sm:text-left">
                            <h2 className="text-xl sm:text-2xl font-bold" style={{ color: 'hsl(var(--foreground))' }}>
                                {userData?.username || 'User'}
                            </h2>
                            <p className="text-sm mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                {userData?.email}
                            </p>
                            <div className="flex flex-wrap items-center justify-center sm:justify-start gap-2 mt-3">
                                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium capitalize"
                                    style={{ background: 'rgba(99, 102, 241, 0.12)', color: 'hsl(220, 70%, 55%)', border: '1px solid rgba(99, 102, 241, 0.2)' }}>
                                    <Shield size={12} /> {userData?.role || 'User'}
                                </span>
                                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium"
                                    style={{ background: 'rgba(16, 185, 129, 0.12)', color: 'hsl(150, 60%, 45%)', border: '1px solid rgba(16, 185, 129, 0.2)' }}>
                                    <CheckCircle size={12} /> Since {memberSince}
                                </span>
                            </div>
                        </div>
                    </div>
                </motion.div>

                {/* Personal Information Card */}
                <motion.form onSubmit={handleSave}
                    initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}
                    className="glass-panel water-shimmer p-6">
                    <div className="flex items-center justify-between mb-6">
                        <div className="flex items-center gap-3">
                            <div className="p-2.5 rounded-xl" style={{ background: 'rgba(99, 102, 241, 0.12)', color: 'hsl(220, 70%, 55%)' }}>
                                <User size={18} />
                            </div>
                            <div>
                                <h3 className="text-base font-semibold" style={{ color: 'hsl(var(--foreground))' }}>Personal Information</h3>
                                <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>Update your display name</p>
                            </div>
                        </div>
                        {!isEditing ? (
                            <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.97 }} type="button"
                                onClick={() => setIsEditing(true)}
                                className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all text-white"
                                style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))', boxShadow: '0 0 20px -4px hsl(220, 70%, 55%, 0.3)' }}>
                                <Edit3 size={14} /> <span className="hidden sm:inline">Edit</span>
                            </motion.button>
                        ) : (
                            <div className="flex gap-2">
                                <motion.button whileTap={{ scale: 0.97 }} type="submit"
                                    className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold"
                                    style={{ background: 'rgba(16, 185, 129, 0.15)', color: 'hsl(150, 60%, 40%)', border: '1px solid rgba(16, 185, 129, 0.25)' }}>
                                    <Save size={14} /> Save
                                </motion.button>
                                <motion.button whileTap={{ scale: 0.97 }} type="button" onClick={handleCancel}
                                    className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold glass-inner"
                                    style={{ color: 'hsl(var(--foreground))' }}>
                                    <X size={14} /> Cancel
                                </motion.button>
                            </div>
                        )}
                    </div>

                    <div className="space-y-4">
                        {/* Username */}
                        <div>
                            <label className="block text-xs font-semibold uppercase tracking-wider mb-2 flex items-center gap-2"
                                style={{ color: 'hsl(var(--muted-foreground))' }}>
                                <User size={12} /> Username
                            </label>
                            {isEditing ? (
                                <input type="text" name="username" value={formData.username} onChange={handleInputChange}
                                    required className="glass-input" placeholder="Enter username" />
                            ) : (
                                <div className="px-4 py-3 glass-inner rounded-xl text-sm font-medium"
                                    style={{ color: 'hsl(var(--foreground))' }}>{userData?.username}</div>
                            )}
                        </div>

                        {/* Email */}
                        <div>
                            <label className="block text-xs font-semibold uppercase tracking-wider mb-2 flex items-center gap-2"
                                style={{ color: 'hsl(var(--muted-foreground))' }}>
                                <Mail size={12} /> Email Address
                            </label>
                            <div className="px-4 py-3 glass-inner rounded-xl text-sm font-medium flex items-center justify-between"
                                style={{ color: 'hsl(var(--foreground))' }}>
                                {userData?.email}
                                <span className="text-[10px] px-2 py-0.5 rounded-full"
                                    style={{ background: 'rgba(16,185,129,0.12)', color: 'hsl(150,60%,45%)' }}>Verified</span>
                            </div>
                        </div>

                        {/* Role */}
                        <div>
                            <label className="block text-xs font-semibold uppercase tracking-wider mb-2 flex items-center gap-2"
                                style={{ color: 'hsl(var(--muted-foreground))' }}>
                                <Shield size={12} /> Account Role
                            </label>
                            <div className="px-4 py-3 glass-inner rounded-xl text-sm font-medium capitalize"
                                style={{ color: 'hsl(var(--foreground))' }}>{userData?.role}</div>
                        </div>
                    </div>
                </motion.form>

                {/* Password Card */}
                <motion.form onSubmit={handlePasswordUpdate}
                    initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }}
                    className="glass-panel water-shimmer p-6">
                    <div className="flex items-center justify-between mb-6">
                        <div className="flex items-center gap-3">
                            <div className="p-2.5 rounded-xl" style={{ background: 'rgba(239, 68, 68, 0.12)', color: 'hsl(0, 72%, 55%)' }}>
                                <Lock size={18} />
                            </div>
                            <div>
                                <h3 className="text-base font-semibold" style={{ color: 'hsl(var(--foreground))' }}>Security</h3>
                                <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>Manage your password</p>
                            </div>
                        </div>
                        {!showPasswordFields ? (
                            <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.97 }} type="button"
                                onClick={() => setShowPasswordFields(true)}
                                className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all text-white"
                                style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))', boxShadow: '0 0 20px -4px hsl(220, 70%, 55%, 0.3)' }}>
                                <Lock size={14} /> <span className="hidden sm:inline">Change Password</span><span className="sm:hidden">Change</span>
                            </motion.button>
                        ) : (
                            <div className="flex gap-2">
                                <motion.button whileTap={{ scale: 0.97 }} type="submit"
                                    className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold"
                                    style={{ background: 'rgba(16, 185, 129, 0.15)', color: 'hsl(150, 60%, 40%)', border: '1px solid rgba(16, 185, 129, 0.25)' }}>
                                    <Save size={14} /> Update
                                </motion.button>
                                <motion.button whileTap={{ scale: 0.97 }} type="button"
                                    onClick={() => { setShowPasswordFields(false); setFormData(prev => ({ ...prev, currentPassword: '', newPassword: '', confirmPassword: '' })); }}
                                    className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold glass-inner"
                                    style={{ color: 'hsl(var(--foreground))' }}>
                                    <X size={14} /> Cancel
                                </motion.button>
                            </div>
                        )}
                    </div>

                    <AnimatePresence>
                        {showPasswordFields && (
                            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
                                className="space-y-4 overflow-hidden">
                                {[
                                    { label: 'Current Password', name: 'currentPassword', show: showCurrentPassword, toggle: () => setShowCurrentPassword(!showCurrentPassword) },
                                    { label: 'New Password', name: 'newPassword', show: showNewPassword, toggle: () => setShowNewPassword(!showNewPassword) },
                                    { label: 'Confirm New Password', name: 'confirmPassword', show: showConfirmPassword, toggle: () => setShowConfirmPassword(!showConfirmPassword) },
                                ].map((field, i) => (
                                    <motion.div key={field.name}
                                        initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
                                        transition={{ delay: i * 0.05 }}>
                                        <label className="block text-xs font-semibold uppercase tracking-wider mb-2"
                                            style={{ color: 'hsl(var(--muted-foreground))' }}>{field.label}</label>
                                        <div className="relative">
                                            <input type={field.show ? 'text' : 'password'} name={field.name}
                                                value={formData[field.name]} onChange={handleInputChange}
                                                required className="glass-input pr-10" placeholder={`Enter ${field.label.toLowerCase()}`} />
                                            <button type="button" onClick={field.toggle}
                                                className="absolute inset-y-0 right-0 pr-3 flex items-center"
                                                style={{ color: 'hsl(var(--muted-foreground))' }}>
                                                {field.show ? <EyeOff size={16} /> : <Eye size={16} />}
                                            </button>
                                        </div>
                                    </motion.div>
                                ))}

                                {/* Password Tips */}
                                <div className="glass-inner rounded-xl p-4 mt-2" style={{ borderLeft: '3px solid hsl(220, 70%, 55%)' }}>
                                    <p className="text-xs font-semibold mb-2 flex items-center gap-2" style={{ color: 'hsl(var(--foreground))' }}>
                                        <AlertCircle size={14} /> Password Requirements
                                    </p>
                                    <ul className="text-[11px] space-y-1 list-disc list-inside" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                        <li>At least 8 characters long</li>
                                        <li>Include uppercase and lowercase letters</li>
                                        <li>Include at least one number</li>
                                    </ul>
                                </div>
                            </motion.div>
                        )}
                    </AnimatePresence>

                    {!showPasswordFields && (
                        <div className="glass-inner rounded-xl p-4 flex items-center gap-3">
                            <div className="p-2 rounded-lg" style={{ background: 'rgba(16,185,129,0.12)', color: 'hsl(150,60%,45%)' }}>
                                <CheckCircle size={16} />
                            </div>
                            <div>
                                <p className="text-sm font-medium" style={{ color: 'hsl(var(--foreground))' }}>Password is set</p>
                                <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>Last updated recently</p>
                            </div>
                        </div>
                    )}
                </motion.form>

                {/* Shipping Info Card */}
                <motion.form onSubmit={handleSaveShipping}
                    initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}
                    className="glass-panel water-shimmer p-6">
                    <div className="flex items-center justify-between mb-6">
                        <div className="flex items-center gap-3">
                            <div className="p-2.5 rounded-xl" style={{ background: 'rgba(14, 165, 233, 0.12)', color: 'hsl(200, 80%, 50%)' }}>
                                <MapPin size={18} />
                            </div>
                            <div>
                                <h3 className="text-base font-semibold" style={{ color: 'hsl(var(--foreground))' }}>Shipping Address</h3>
                                <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>Used for auto-fill at checkout</p>
                            </div>
                        </div>
                        {!isEditingShipping ? (
                            <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.97 }} type="button"
                                onClick={() => setIsEditingShipping(true)}
                                className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all text-white"
                                style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))', boxShadow: '0 0 20px -4px hsl(220, 70%, 55%, 0.3)' }}>
                                <Edit3 size={14} /> <span className="hidden sm:inline">{shippingInfo ? 'Edit' : 'Add'}</span>
                            </motion.button>
                        ) : (
                            <div className="flex gap-2">
                                <motion.button whileTap={{ scale: 0.97 }} type="submit" disabled={savingShipping}
                                    className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold"
                                    style={{ background: 'rgba(16, 185, 129, 0.15)', color: 'hsl(150, 60%, 40%)', border: '1px solid rgba(16, 185, 129, 0.25)' }}>
                                    <Save size={14} /> Save
                                </motion.button>
                                <motion.button whileTap={{ scale: 0.97 }} type="button"
                                    onClick={() => { setIsEditingShipping(false); setShippingForm(shippingInfo || { fullName: '', email: '', phone: '', address: '', city: '', state: '', postalCode: '', country: 'Pakistan' }); }}
                                    className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold glass-inner"
                                    style={{ color: 'hsl(var(--foreground))' }}>
                                    <X size={14} /> Cancel
                                </motion.button>
                            </div>
                        )}
                    </div>

                    {isEditingShipping ? (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            {[
                                { label: 'Full Name', name: 'fullName', icon: <User size={12} /> },
                                { label: 'Email', name: 'email', icon: <Mail size={12} />, type: 'email' },
                                { label: 'Phone', name: 'phone', icon: <Phone size={12} />, custom: 'phone' },
                                { label: 'Address', name: 'address', icon: <Home size={12} /> },
                                { label: 'City', name: 'city' },
                                { label: 'State', name: 'state' },
                                { label: 'Postal Code', name: 'postalCode' },
                                { label: 'Country', name: 'country' },
                            ].map((field) => (
                                <div key={field.name}>
                                    <label className="block text-xs font-semibold uppercase tracking-wider mb-2 flex items-center gap-2"
                                        style={{ color: 'hsl(var(--muted-foreground))' }}>
                                        {field.icon} {field.label}
                                    </label>
                                    {field.custom === 'phone' ? (
                                        <PhoneField
                                            name="phone"
                                            value={shippingForm.phone || ''}
                                            onChange={(v) => setShippingForm((prev) => ({ ...prev, phone: v || '' }))}
                                            profileCountry={shippingForm.country}
                                            placeholder="Phone (used for WhatsApp order updates)"
                                        />
                                    ) : (
                                        <input type={field.type || 'text'} name={field.name}
                                            value={shippingForm[field.name] || ''} onChange={handleShippingChange}
                                            className="glass-input" placeholder={`Enter ${field.label.toLowerCase()}`} />
                                    )}
                                </div>
                            ))}
                        </div>
                    ) : shippingInfo ? (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            {[
                                { label: 'Full Name', value: shippingInfo.fullName },
                                { label: 'Email', value: shippingInfo.email },
                                { label: 'Phone', value: shippingInfo.phone },
                                { label: 'Address', value: shippingInfo.address },
                                { label: 'City', value: shippingInfo.city },
                                { label: 'State', value: shippingInfo.state },
                                { label: 'Postal Code', value: shippingInfo.postalCode },
                                { label: 'Country', value: shippingInfo.country },
                            ].map((field) => (
                                <div key={field.label}>
                                    <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>{field.label}</p>
                                    <p className="text-sm font-medium" style={{ color: 'hsl(var(--foreground))' }}>{field.value || '—'}</p>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div className="glass-inner rounded-xl p-4 text-center">
                            <MapPin size={28} className="mx-auto mb-2 opacity-40" style={{ color: 'hsl(var(--muted-foreground))' }} />
                            <p className="text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>No shipping address saved yet</p>
                            <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>Add one to auto-fill at checkout</p>
                        </div>
                    )}
                </motion.form>
            </motion.div>
            <Link to="/settings/blocked-accounts" className="mt-4 glass-panel p-4 flex items-center gap-3 transition-transform hover:scale-[1.005]">
                <span className="w-10 h-10 rounded-xl inline-flex items-center justify-center" style={{ background: 'rgba(245,158,11,.12)', color: 'hsl(45,80%,40%)' }}><Ban size={18} /></span>
                <span><strong className="block text-sm" style={{ color: 'hsl(var(--foreground))' }}>Blocked accounts</strong><span className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>Manage hidden sellers and reviewers</span></span>
            </Link>
        </div>
    );
};

export default UserProfile;
