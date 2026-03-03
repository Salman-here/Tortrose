import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'react-toastify'
import {
  Search,
  Filter,
  ChevronLeft,
  ChevronRight,
  User,
  UserX,
  UserCheck,
  Shield,
  ShieldOff,
  Trash2,
  Edit3,
  MoreVertical,
  Users,
  UserCog,
  AlertCircle,
  LucideClipboardList
} from 'lucide-react';
import axios from 'axios';
import { useAuth } from '../../contexts/AuthContext'
import Loader from '../common/Loader';

// Mock data based on your schema

const UserManagement = () => {
  const {
    currentUser
  } = useAuth()


  const [users, setUsers] = useState([]);
  const [allUsers, setAllUsers] = useState([]);
  const [filteredUsers, setFilteredUsers] = useState([]);
  const [currentPage, setCurrentPage] = useState(1);
  const [searchTerm, setSearchTerm] = useState('');
  const [roleFilter, setRoleFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [usersPerPage] = useState(8);
  const [loading, setLoading] = useState(true)

  // Modals state
  const [showBlockModal, setShowBlockModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showRoleModal, setShowRoleModal] = useState(false);
  const [selectedUser, setSelectedUser] = useState(null);

  const serializeFilters = () => {
    let params = new URLSearchParams()
    if (searchTerm !== '') params.append('search', searchTerm)
    if (roleFilter !== 'all') params.append('role', roleFilter)
    if (statusFilter !== 'all') params.append('status', statusFilter)
    console.log(params.toString());
    return params.toString()
  }

  const fetchUsers = async () => {
    try {
      setLoading(true)
      const token = localStorage.getItem('jwtToken')
      const query = serializeFilters()
      const res = await axios.get(`${import.meta.env.VITE_API_URL}api/user/get?${query}`,
        {
          headers: {
            Authorization: `Bearer ${token}`
          }
        }
      )
      console.log(res.data);
      setUsers(res.data.users)
    } catch (error) {
      console.error(error || 'Server error while fetching users');
      toast.error(error.response?.data.msg || 'Server error while fetching users')
    }
    finally {
      setLoading(false)
    }
  }

  const fetchAllUsers = async () => {
    try {
      const token = localStorage.getItem('jwtToken')
      const res = await axios.get(`${import.meta.env.VITE_API_URL}api/user/get`,
        {
          headers: {
            Authorization: `Bearer ${token}`
          }
        }
      )
      console.log(res.data);
      setAllUsers(res.data.users)
    } catch (error) {
      console.error(error || 'Server error while fetching users');
      toast.error(error.response?.data.msg || 'Server error while fetching users')
    }
  }

  useEffect(() => {
    fetchAllUsers()
  }, []);
  
  useEffect(() => {
    fetchUsers()
  }, [searchTerm, roleFilter, statusFilter]);

  // Handle user actions
  const handleBlockUser = (user) => {
    setSelectedUser(user);
    setShowBlockModal(true);
  };

  const handleDeleteUser = (user) => {
    setSelectedUser(user);
    setShowDeleteModal(true);
  };

  const handleChangeRole = (user) => {
    setSelectedUser(user);
    setShowRoleModal(true);
  };

  const confirmBlockUser = async () => {


    try {
      const token = localStorage.getItem('jwtToken')
      const res = await axios.patch(`${import.meta.env.VITE_API_URL}api/user/block-toggle/${selectedUser._id}`,
        {

        },
        {
          headers: {
            Authorization: `Bearer ${token}`
          }
        }
      )
      console.log(res.data);
      toast.success(res.data?.msg || 'User status updated successfully.')
      fetchUsers()
      fetchAllUsers()
    } catch (error) {
      console.error(error || 'Server error while updating user status.');
      toast.error('Server error while updating user status.')
    }


    setShowBlockModal(false);
    setSelectedUser(null);
  };

  const confirmDeleteUser = async () => {

    try {
      const token = localStorage.getItem('jwtToken')
      const res = await axios.delete(`${import.meta.env.VITE_API_URL}api/user/delete/${selectedUser._id}`,
        {
          headers: {
            Authorization: `Bearer ${token}`
          }
        }
      )
      console.log(res.data);
      toast.success(res.data?.msg || "User has been successfully deleted.")
      fetchUsers()
      fetchAllUsers()
    } catch (error) {
      console.error(error);
      toast.error('Server error while deleting user.')
    }

    setShowDeleteModal(false);
    setSelectedUser(null);
  };

  const confirmChangeRole = async () => {
    try {
      const token = localStorage.getItem('jwtToken')
      const res = await axios.patch(`${import.meta.env.VITE_API_URL}api/user/admin-toggle/${selectedUser._id}`,
        {
          newRole: selectedUser.targetRole
        },
        {
          headers: {
            Authorization: `Bearer ${token}`
          }
        }
      )
      console.log(res.data);
      toast.success(res.data?.msg || "User's role successfully updated.")
      fetchUsers()
      fetchAllUsers()
    } catch (error) {
      console.error(error);
      toast.error('Server error while updating user role.')
    }

    setShowRoleModal(false);
    setSelectedUser(null);
  };

  // Stats calculation
  const totalUsers = allUsers.length;
  const activeUsers = allUsers.filter(user => user.status === 'active').length;
  const adminUsers = allUsers.filter(user => user.role === 'admin').length;
  const sellerUsers = allUsers.filter(user => user.role === 'seller').length;

  return (
    <div className="min-h-screen bg-gray-50 p-6 mt-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-8">
          <motion.h1
            className="text-3xl font-bold text-gray-800 flex items-center gap-2"
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
          >
            <UserCog className="w-8 h-8" />
            User Management
          </motion.h1>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
          <motion.div
            className="bg-white rounded-xl shadow-sm p-6 flex justify-between items-center"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.1 }}
          >
            <div>
              <h3 className="text-lg font-medium text-gray-600">Total Users</h3>
              <p className="text-3xl font-bold text-gray-800">{totalUsers}</p>
            </div>
            <div className="bg-blue-100 p-3 rounded-full">
              <Users className="w-8 h-8 text-blue-600" />
            </div>
          </motion.div>

          <motion.div
            className="bg-white rounded-xl shadow-sm p-6 flex justify-between items-center"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.2 }}
          >
            <div>
              <h3 className="text-lg font-medium text-gray-600">Active Users</h3>
              <p className="text-3xl font-bold text-green-600">{activeUsers}</p>
            </div>
            <div className="bg-green-100 p-3 rounded-full">
              <UserCheck className="w-8 h-8 text-green-600" />
            </div>
          </motion.div>

          <motion.div
            className="bg-white rounded-xl shadow-sm p-6 flex justify-between items-center"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.3 }}
          >
            <div>
              <h3 className="text-lg font-medium text-gray-600">Sellers</h3>
              <p className="text-3xl font-bold text-emerald-600">{sellerUsers}</p>
            </div>
            <div className="bg-emerald-100 p-3 rounded-full">
              <Shield className="w-8 h-8 text-emerald-600" />
            </div>
          </motion.div>

          <motion.div
            className="bg-white rounded-xl shadow-sm p-6 flex justify-between items-center"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.4 }}
          >
            <div>
              <h3 className="text-lg font-medium text-gray-600">Admins</h3>
              <p className="text-3xl font-bold text-sky-600">{adminUsers}</p>
            </div>
            <div className="bg-sky-100 p-3 rounded-full">
              <Shield className="w-8 h-8 text-sky-600" />
            </div>
          </motion.div>
        </div>

        {/* Filters and Search */}
        <motion.div
          className="bg-white rounded-xl shadow-sm p-6 mb-6"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.4 }}
        >
          <div className="flex flex-col md:flex-row gap-4 justify-between">
            <div className="relative flex-1 max-w-md">
              <Search className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
              <input
                type="text"
                placeholder="Search by username or email..."
                className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>

            <div className="flex gap-4">
              <div className="flex items-center gap-2">
                <Filter className="text-gray-400 w-5 h-5" />
                <select
                  className="border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  value={roleFilter}
                  onChange={(e) => setRoleFilter(e.target.value)}
                >
                  <option value="all">All Roles</option>
                  <option value="admin">Admin</option>
                  <option value="seller">Seller</option>
                  <option value="user">User</option>
                </select>
              </div>

              <div className="flex items-center gap-2">
                <Filter className="text-gray-400 w-5 h-5" />
                <select
                  className="border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                >
                  <option value="all">All Status</option>
                  <option value="active">Active</option>
                  <option value="blocked">Blocked</option>
                </select>
              </div>
            </div>
          </div>
        </motion.div>

        {/* Users Table */}
        <motion.div
          className="bg-white rounded-xl shadow-sm overflow-hidden"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.5 }}
        >

          {users.length === 0 ? (
            <div className="w-full py-12 flex flex-col justify-center items-center">
              <AlertCircle className="w-12 h-12 text-gray-400 mx-auto mb-4" />
              <p className="text-gray-500">No users found matching your criteria</p>
            </div>
          )
            :
            (
              <div className=" overflow-x-auto">
                {
                  loading ? <div className='flex justify-center items-center min-h-[250px]'>
                    <Loader />
                  </div> : (
                    <table className="w-full">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="py-3 px-6 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">User</th>
                          <th className="py-3 px-6 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Email</th>
                          <th className="py-3 px-6 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Role</th>
                          <th className="py-3 px-6 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                          <th className="py-3 px-6 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-200">



                        <AnimatePresence>
                          {
                            users.length > 0 && users.map((user, index) => (
                              <motion.tr
                                key={user._id}
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                exit={{ opacity: 0 }}
                                transition={{ duration: 0.3, delay: index * 0.05 }}
                              >
                                <td className="py-4 px-6 whitespace-nowrap">
                                  <div className="flex items-center">
                                    <div className="flex-shrink-0 h-10 w-10 bg-blue-100 rounded-full flex items-center justify-center">
                                      <User className="h-5 w-5 text-blue-600" />
                                    </div>
                                    <div className="ml-4">
                                      <div className="text-sm font-medium text-gray-900">{user.username}</div>
                                    </div>
                                  </div>
                                </td>
                                <td className="py-4 px-6 whitespace-nowrap">
                                  <div className="text-sm text-gray-900">{user.email}</div>
                                </td>
                                <td className="py-4 px-6 whitespace-nowrap">
                                  <span className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${
                                    user.role === 'admin' ? 'bg-indigo-100 text-indigo-800' :
                                    user.role === 'seller' ? 'bg-green-100 text-green-800' : 
                                    'bg-gray-100 text-gray-800'
                                  }`}>
                                    {user.role}
                                  </span>
                                </td>
                                <td className="py-4 px-6 whitespace-nowrap">
                                  <span className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${user.status === 'active' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
                                    {user.status}
                                  </span>
                                </td>
                                <td className="py-4 px-6 whitespace-nowrap text-sm font-medium">
                                  <div className="flex space-x-2">
                                    {
                                      currentUser.email === user.email ? 'You' : (
                                        <>

                                          <button
                                            onClick={() => handleBlockUser(user)}
                                            className={`p-2 rounded-lg ${user.status === 'active' ? 'text-red-600 hover:bg-red-100' : 'text-green-600 hover:bg-green-100'}`}
                                            title={user.status === 'active' ? 'Block User' : 'Unblock User'}
                                          >
                                            {user.status === 'active' ? <UserX className="w-4 h-4" /> : <UserCheck className="w-4 h-4" />}
                                          </button>
                                          <button
                                            onClick={() => handleChangeRole(user)}
                                            className={`p-2 rounded-lg ${
                                              user.role === 'admin' ? 'text-gray-600 hover:bg-gray-100' : 
                                              user.role === 'seller' ? 'text-indigo-600 hover:bg-indigo-100' :
                                              'text-green-600 hover:bg-green-100'
                                            }`}
                                            title={
                                              user.role === 'admin' ? 'Change to User' : 
                                              user.role === 'seller' ? 'Change to Admin' :
                                              'Change to Seller'
                                            }
                                          >
                                            {user.role === 'admin' ? <ShieldOff className="w-4 h-4" /> : <Shield className="w-4 h-4" />}
                                          </button>
                                          <button
                                            onClick={() => handleDeleteUser(user)}
                                            className="p-2 text-red-600 rounded-lg hover:bg-red-100"
                                            title="Delete User"
                                          >
                                            <Trash2 className="w-4 h-4" />
                                          </button>
                                        </>

                                      )
                                    }
                                  </div>
                                </td>
                              </motion.tr>
                            ))}
                        </AnimatePresence>
                      </tbody>
                    </table>

                  )
                }
              </div>

            )
          }


          {/* Pagination */}
          {/* {users.length > 0 && (
            <div className="px-6 py-4 flex items-center justify-between border-t border-gray-200">
              <div className="text-sm text-gray-700">
                Showing <span className="font-medium">{indexOfFirstUser + 1}</span> to{' '}
                <span className="font-medium">
                  {indexOfLastUser > filteredUsers.length ? filteredUsers.length : indexOfLastUser}
                </span> of{' '}
                <span className="font-medium">{filteredUsers.length}</span> users
              </div>
              <div className="flex space-x-2">
                <button
                  onClick={() => paginate(currentPage - 1)}
                  disabled={currentPage === 1}
                  className={`p-2 rounded-lg ${currentPage === 1 ? 'text-gray-400 cursor-not-allowed' : 'text-gray-700 hover:bg-gray-100'}`}
                >
                  <ChevronLeft className="w-5 h-5" />
                </button>

                {Array.from({ length: totalPages }, (_, i) => i + 1).map(page => (
                  <button
                    key={page}
                    onClick={() => paginate(page)}
                    className={`px-3 py-1 rounded-lg ${currentPage === page ? 'bg-indigo-600 text-white' : 'text-gray-700 hover:bg-gray-100'}`}
                  >
                    {page}
                  </button>
                ))}

                <button
                  onClick={() => paginate(currentPage + 1)}
                  disabled={currentPage === totalPages}
                  className={`p-2 rounded-lg ${currentPage === totalPages ? 'text-gray-400 cursor-not-allowed' : 'text-gray-700 hover:bg-gray-100'}`}
                >
                  <ChevronRight className="w-5 h-5" />
                </button>
              </div>
            </div>
          )} */}


        </motion.div>
      </div>

      {/* Block/Unblock User Modal */}
      <AnimatePresence>
        {showBlockModal && selectedUser && (
          <motion.div
            className="fixed inset-0 bg-black/60 bg-opacity-50 flex items-center justify-center p-4 z-50"
            onClick={() => setShowBlockModal(false)}

            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.div
              className="bg-white rounded-xl shadow-lg max-w-md w-full p-6"
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
            >
              <h3 className="text-lg font-medium text-gray-900 mb-4">
                {selectedUser.status === 'active' ? 'Block User' : 'Unblock User'}
              </h3>
              <p className="text-gray-600 mb-6">
                Are you sure you want to {selectedUser.status === 'active' ? 'block' : 'unblock'} {selectedUser.username}?
              </p>
              <div className="flex justify-end space-x-3">
                <button
                  onClick={() => setShowBlockModal(false)}
                  className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  onClick={confirmBlockUser}
                  className={`px-4 py-2 rounded-lg text-white ${selectedUser.status === 'active' ? 'bg-red-600 hover:bg-red-700' : 'bg-green-600 hover:bg-green-700'}`}
                >
                  Confirm
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Delete User Modal */}
      <AnimatePresence>
        {showDeleteModal && selectedUser && (
          <motion.div
            className="fixed inset-0 bg-black/60 bg-opacity-50 flex items-center justify-center p-4 z-50"
            onClick={() => setShowDeleteModal(false)}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}

          >
            <motion.div
              className="bg-white rounded-xl shadow-lg max-w-md w-full p-6"
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
            >
              <h3 className="text-lg font-medium text-gray-900 mb-4">Delete User</h3>
              <p className="text-gray-600 mb-6">
                Are you sure you want to delete {selectedUser.username}? This action cannot be undone.
              </p>
              <div className="flex justify-end space-x-3">
                <button
                  onClick={() => setShowDeleteModal(false)}
                  className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  onClick={confirmDeleteUser}
                  className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700"
                >
                  Delete
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Change Role Modal */}
      <AnimatePresence>
        {showRoleModal && selectedUser && (
          <motion.div
            className="fixed inset-0 bg-black/60 bg-opacity-50 flex items-center justify-center p-4 z-50"
            onClick={() => setShowRoleModal(false)}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.div
              className="bg-white rounded-xl shadow-lg max-w-md w-full p-6"
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
            >
              <h3 className="text-lg font-medium text-gray-900 mb-4">Change User Role</h3>
              <p className="text-gray-600 mb-4">
                Current role: <span className="font-semibold">{selectedUser.role}</span>
              </p>
              <p className="text-gray-600 mb-6">
                Change {selectedUser.username}'s role to:
              </p>
              <div className="space-y-2 mb-6">
                <button
                  onClick={() => {
                    selectedUser.targetRole = 'user';
                    confirmChangeRole();
                  }}
                  disabled={selectedUser.role === 'user'}
                  className={`w-full px-4 py-2 rounded-lg text-left ${
                    selectedUser.role === 'user'
                      ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                      : 'bg-gray-50 hover:bg-gray-100 text-gray-700'
                  }`}
                >
                  👤 User {selectedUser.role === 'user' && '(Current)'}
                </button>
                <button
                  onClick={() => {
                    selectedUser.targetRole = 'seller';
                    confirmChangeRole();
                  }}
                  disabled={selectedUser.role === 'seller'}
                  className={`w-full px-4 py-2 rounded-lg text-left ${
                    selectedUser.role === 'seller'
                      ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                      : 'bg-green-50 hover:bg-green-100 text-green-700'
                  }`}
                >
                  🏪 Seller {selectedUser.role === 'seller' && '(Current)'}
                </button>
                <button
                  onClick={() => {
                    selectedUser.targetRole = 'admin';
                    confirmChangeRole();
                  }}
                  disabled={selectedUser.role === 'admin'}
                  className={`w-full px-4 py-2 rounded-lg text-left ${
                    selectedUser.role === 'admin'
                      ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                      : 'bg-indigo-50 hover:bg-indigo-100 text-indigo-700'
                  }`}
                >
                  👑 Admin {selectedUser.role === 'admin' && '(Current)'}
                </button>
              </div>
              <div className="flex justify-end">
                <button
                  onClick={() => setShowRoleModal(false)}
                  className="px-6 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50"
                >
                  Cancel
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default UserManagement;