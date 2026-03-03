import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence, useTransform } from 'framer-motion';
import {
  User,
  Mail,
  Phone,
  Lock,
  Eye,
  EyeOff,
  CheckCircle,
  Edit3,
  Save,
  X,
  Loader as LucideLoader,
  Camera,
  User as UserIcon,

} from 'lucide-react';
import Loader from '../common/Loader'
import { useAuth } from '../../contexts/AuthContext';
import axios from 'axios';
import { toast } from 'react-toastify';

// Animation variants
const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.1
    }
  }
};

const itemVariants = {
  hidden: { y: 20, opacity: 0 },
  visible: {
    y: 0,
    opacity: 1,
    transition: {
      type: "spring",
      stiffness: 100
    }
  }
};

const cardVariants = {
  hidden: { scale: 0.9, opacity: 0 },
  visible: {
    scale: 1,
    opacity: 1,
    transition: {
      type: "spring",
      stiffness: 100
    }
  }
};

const UserProfile = () => {
  const { currentUser, fetchAndUpdateCurrentUser } = useAuth();
  const [userData, setUserData] = useState(currentUser);
  const [isEditing, setIsEditing] = useState(false);
  const [showPasswordFields, setShowPasswordFields] = useState(false);
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [loading, setLoading] = useState(true)

  const [formData, setFormData] = useState({
    username: userData.username,
    email: userData.email,
    currentPassword: '',
    newPassword: '',
    confirmPassword: ''
  });


  const [isUploading, setIsUploading] = useState(false);
  const [isWaiting, setIsWaiting] = useState(false);

  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: value
    }));
  };


  const fetchUser = async () => {
    try {
      setLoading(true)
      const token = localStorage.getItem('jwtToken')
      const res = await axios.get(`${import.meta.env.VITE_API_URL}api/user/single`,
        {
          headers: {
            Authorization: `Bearer ${token}`
          }
        }
      )
      console.log(res.data);
      setUserData(res.data?.user)
      fetchAndUpdateCurrentUser()
    } catch (error) {
      console.error(error);
    }
    finally {
      setIsWaiting(false)
      setLoading(false)

    }

  }


  useEffect(() => {
    fetchUser()
  }, [])

  const handleImageUpload = async (e) => {
    const file = e.target.files[0];
    if (file) {
      setIsUploading(true);
      try {
        // Create form data to send the file
        const formData = new FormData();

        formData.append('profileImage', file);
        console.log(formData);

        // Call the API to upload the image
        const token = localStorage.getItem('jwtToken')
        const res = await axios.post(
          `${import.meta.env.VITE_API_URL}api/upload/profile-image`,
          formData,
          {
            headers: {
              'Content-Type': 'multipart/form-data',
              Authorization: `Bearer ${token}`
            }
          }
        );
        console.log(res.data);
        setIsWaiting(true)
        fetchUser()

      } catch (error) {
        console.error(error);
        toast.error('Failed to upload profile picture. Please try again.')
      } finally {
        setIsUploading(false);
      }
    }
  };

  const handleSave = async (e) => {
    e.preventDefault()
    // In a real app, this would call an API
    if (userData.username === formData.username) return toast.error('Username is same as before!')
    try {
      const token = localStorage.getItem('jwtToken')
      const res = await axios.patch(`${import.meta.env.VITE_API_URL}api/user/update`,
        {
          username: formData.username,
        },
        {
          headers: {
            Authorization: `Bearer ${token}`
          }
        }
      )
      console.log(res.data);
      toast.success(res?.data?.msg || 'Username updated successfully')
      fetchUser()
    } catch (error) {
      console.error(error);
      toast.error(error.response?.data?.msg || 'Server error while updating username')

    }
    setIsEditing(false);



  };

  const handleCancel = () => {
    setFormData({
      username: userData.username,
      email: userData.email,
      currentPassword: '',
      newPassword: '',
      confirmPassword: ''
    });
    setIsEditing(false);
    setShowPasswordFields(false);
  };

  const handlePasswordUpdate = async (e) => {
    e.preventDefault()

    try {
      const token = localStorage.getItem('jwtToken')
      const res = await axios.patch(`${import.meta.env.VITE_API_URL}api/password/change`,
        {
          currentPassword: formData.currentPassword,
          newPassword: formData.newPassword,
          confirmPassword: formData.confirmPassword,
        },
        {
          headers: {
            Authorization: `Bearer ${token}`
          }
        }
      )
      console.log(res.data);
      toast.success(res.data?.msg || 'Password updated successfully.')
      setShowPasswordFields(false);
    } catch (error) {
      console.error(error);
      toast.error(error.response?.data?.msg || 'Server error while updating password.')
    }


  };


  return (
    <div className="min-h-screen bg-gray-50 p-4 md:p-6">
      <motion.div
        className="max-w-4xl mx-auto"
        variants={containerVariants}
        initial="hidden"
        animate="visible"
      >
        {/* Header */}
        <motion.div
          className="flex items-center justify-between mb-8"
          variants={itemVariants}
        >
          <div>
            <h1 className="text-2xl md:text-3xl font-bold text-gray-800">
              Profile Settings
            </h1>
            <p className="text-gray-600">Manage your account information</p>
          </div>


        </motion.div>

        {
          loading ? (
            <div className='w-full flex justify-center items-center h-[250px]'>
              <Loader />
            </div>
          )
            :
            <>
              {/* Profile Card */}
              <motion.form
              onSubmit={handleSave}
                variants={cardVariants}
                className="bg-white rounded-xl p-6 shadow-md border border-gray-100 mb-6"
              >
                <div className="flex justify-between items-center mb-6">
                  <h2 className="text-xl font-semibold text-gray-800">Personal Information</h2>

                  {!isEditing ? (
                    <motion.button
                      whileHover={{ scale: 1.05 }}
                      whileTap={{ scale: 0.95 }}
                      onClick={() => setIsEditing(true)}
                      className="flex items-center bg-linear-to-r from-indigo-600 to-sky-500 hover:from-indigo-700 hover:to-sky-600 text-white px-3 py-2 text-sm md:px-4 md:text-base rounded-lg transition-colors"
                    >
                      <Edit3 className="h-4 w-4 mr-1 md:mr-2" />
                      <span className="hidden sm:inline">Edit Username</span>
                      <span className="sm:hidden">Edit</span>
                    </motion.button>
                  ) : (
                    <div className="flex flex-col sm:flex-row gap-2">
                      <motion.button
                        whileHover={{ scale: 1.05 }}
                        whileTap={{ scale: 0.95 }}
                        onClick={handleSave}
                        className="flex items-center justify-center bg-green-600 text-white px-3 py-2 text-sm md:px-4 md:text-base rounded-lg"
                      >
                        <Save className="h-4 w-4 mr-1 md:mr-2" />
                        <span className="hidden sm:inline">Save Changes</span>
                        <span className="sm:hidden">Save</span>
                      </motion.button>
                      <motion.button
                        whileHover={{ scale: 1.05 }}
                        whileTap={{ scale: 0.95 }}
                        onClick={handleCancel}
                        className="flex items-center justify-center bg-gray-200 text-gray-800 px-3 py-2 text-sm md:px-4 md:text-base rounded-lg"
                      >
                        <X className="h-4 w-4 mr-1 md:mr-2" />
                        Cancel
                      </motion.button>
                    </div>
                  )}
                </div>

                <div className="flex flex-col md:flex-row gap-6">
                  {/* Profile Picture Section */}
                  <div className="flex flex-col items-center">
                    <div className="relative mb-4">
                      {(userData.avatar || userData.profilePicture) ? (
                        <>
                          <div className={`flex ${isWaiting || isUploading ? 'flex' : 'hidden'} bg-gray-100 z-1  flex-col justify-center items-center  absolute top-0 left-0 w-32 h-32 rounded-full`}>
                            <p className='animate-spin'>
                              <LucideLoader />
                            </p>
                            <p className='text-sm'>
                              Updating
                            </p>
                          </div>
                          <img
                            src={userData.avatar || userData.profilePicture || 'https://res.cloudinary.com/dus5sac8g/image/upload/v1756983317/Profile_Picture_dxq4w8.jpg'}
                            alt="Profile"
                            className="w-32 h-32 rounded-full object-cover border-4 border-gray-200"
                          />
                        </>

                      ) : (
                        <div className="w-32 h-32 rounded-full bg-gray-200 flex items-center justify-center border-4 border-gray-200">
                          <UserIcon className="h-16 w-16 text-gray-400" />
                        </div>
                      )}
                      <label
                        htmlFor="profile-upload"
                        className="absolute z-2 bottom-0 right-0 bg-linear-to-br from-indigo-600 to-sky-500 text-white p-2 rounded-full cursor-pointer shadow-md"
                      >
                        {isUploading ? (
                          <div className="h-5 w-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                        ) : (
                          <Camera className="h-5 w-5" />
                        )}
                        <input
                          id="profile-upload"
                          type="file"
                          accept="image/*"
                          onChange={handleImageUpload}
                          className="hidden"
                          disabled={isUploading}
                        />
                      </label>
                    </div>
                    <p className="text-sm text-gray-600">Click camera to upload</p>
                  </div>

                  <div className="flex-1 space-y-4">
                    {/* Username Field */}
                    <div>
                      <label className="text-sm font-medium text-gray-700 mb-1 flex items-center">
                        <User className="h-4 w-4 mr-2" />
                        Username
                      </label>
                      {isEditing ? (
                        <input
                          type="text"
                          name="username"
                          value={formData.username}
                          onChange={handleInputChange}
                          required
                          className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                        />
                      ) : (
                        <p className="px-4 py-2 bg-gray-50 rounded-lg">{userData.username}</p>
                      )}
                    </div>

                    {/* Email Field */}
                    <div>
                      <label className="text-sm font-medium text-gray-700 mb-1 flex items-center">
                        <Mail className="h-4 w-4 mr-2" />
                        Email Address
                      </label>
                      <p className="px-4 py-2 bg-gray-50 rounded-lg">{userData.email}</p>
                    </div>

                    {/* Role Field (readonly) */}
                    <div>
                      <label className="text-sm font-medium text-gray-700 mb-1">
                        Account Role
                      </label>
                      <p className="px-4 py-2 bg-gray-50 rounded-lg capitalize">{userData.role}</p>
                    </div>
                  </div>
                </div>
              </motion.form>

              {/* Password Update Card */}
              <motion.form
                onSubmit={(e) => { handlePasswordUpdate(e) }}

                variants={cardVariants}
                className="bg-white rounded-xl p-6 shadow-md border border-gray-100"
              >
                <div
                  className="flex justify-between items-center mb-6">
                  <h2 className="text-xl font-semibold text-gray-800">Password Settings</h2>

                  {!showPasswordFields ? (
                    <motion.button
                      whileHover={{ scale: 1.05 }}
                      whileTap={{ scale: 0.95 }}
                      onClick={() => setShowPasswordFields(true)}
                      className="flex items-center bg-linear-to-r from-indigo-600 to-sky-500 hover:from-indigo-700 hover:to-sky-600 text-white px-3 py-2 text-sm md:px-4 md:text-base rounded-lg transition-colors"
                    >
                      <Lock className="h-4 w-4 mr-1 md:mr-2" />
                      <span className="hidden sm:inline">Change Password</span>
                      <span className="sm:hidden">Change</span>
                    </motion.button>
                  ) : (
                    <div className="flex flex-col sm:flex-row gap-2">
                      <motion.button
                        whileHover={{ scale: 1.05 }}
                        whileTap={{ scale: 0.95 }}
                        type='submit'
                        className="flex items-center justify-center bg-green-600 text-white px-3 py-2 text-sm md:px-4 md:text-base rounded-lg"
                      >
                        <Save className="h-4 w-4 mr-1 md:mr-2" />
                        <span className="hidden sm:inline">Update Password</span>
                        <span className="sm:hidden">Update</span>
                      </motion.button>
                      <motion.button
                        whileHover={{ scale: 1.05 }}
                        whileTap={{ scale: 0.95 }}
                        onClick={() => {
                          setShowPasswordFields(false);
                          setFormData(prev => ({
                            ...prev,
                            currentPassword: '',
                            newPassword: '',
                            confirmPassword: ''
                          }));
                        }}
                        className="flex items-center justify-center bg-gray-200 text-gray-800 px-3 py-2 text-sm md:px-4 md:text-base rounded-lg"
                      >
                        <X className="h-4 w-4 mr-1 md:mr-2" />
                        Cancel
                      </motion.button>
                    </div>
                  )}
                </div>

                {showPasswordFields && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    className="space-y-4"

                  >
                    {/* Current Password */}
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Current Password
                      </label>
                      <div className="relative">
                        <input
                          type={showCurrentPassword ? "text" : "password"}
                          name="currentPassword"
                          value={formData.currentPassword}
                          onChange={handleInputChange}
                          required
                          className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 pr-10"
                        />
                        <button
                          type="button"
                          onClick={() => setShowCurrentPassword(!showCurrentPassword)}
                          className="absolute inset-y-0 right-0 pr-3 flex items-center"
                        >
                          {showCurrentPassword ? (
                            <EyeOff className="h-5 w-5 text-gray-500" />
                          ) : (
                            <Eye className="h-5 w-5 text-gray-500" />
                          )}
                        </button>
                      </div>
                    </div>

                    {/* New Password */}
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        New Password
                      </label>
                      <div className="relative">
                        <input
                          type={showNewPassword ? "text" : "password"}
                          name="newPassword"
                          value={formData.newPassword}
                          onChange={handleInputChange}
                          required
                          className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 pr-10"
                        />
                        <button
                          type="button"
                          onClick={() => setShowNewPassword(!showNewPassword)}
                          className="absolute inset-y-0 right-0 pr-3 flex items-center"
                        >
                          {showNewPassword ? (
                            <EyeOff className="h-5 w-5 text-gray-500" />
                          ) : (
                            <Eye className="h-5 w-5 text-gray-500" />
                          )}
                        </button>
                      </div>
                    </div>

                    {/* Confirm Password */}
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Confirm New Password
                      </label>
                      <div className="relative">
                        <input
                          type={showConfirmPassword ? "text" : "password"}
                          name="confirmPassword"
                          value={formData.confirmPassword}
                          onChange={handleInputChange}
                          required
                          className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 pr-10"
                        />
                        <button
                          type="button"
                          onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                          className="absolute inset-y-0 right-0 pr-3 flex items-center"
                        >
                          {showConfirmPassword ? (
                            <EyeOff className="h-5 w-5 text-gray-500" />
                          ) : (
                            <Eye className="h-5 w-5 text-gray-500" />
                          )}
                        </button>
                      </div>
                    </div>
                  </motion.div>
                )}
              </motion.form>
            </>
        }


      </motion.div>
    </div>
  );
};

export default UserProfile;