
const User = require('../models/User')

exports.getUsers = async (req, res) => {
    const { role: userRole, id: _id } = req.user
    const { role, status, search } = req.query
    if (userRole !== 'admin') return res.status(403).json({ msg: 'Admin access only.' })


    let query = {}
    try {
        if (role) query.role = role
        if (status) query.status = status
        if (search) {
            query.$or = [
                { username: { $regex: search, $options: 'i' } },
                { email: { $regex: search, $options: 'i' } }
            ]
        }
        const users = await User.find(query)
        res.status(200).json({ msg: 'Users fetched succcessfully.', users: users })
    } catch (error) {
        console.error(error);
        res.status(500).json({ msg: 'Server error while fetching users.' })
    }
}


exports.toggleBlockUser = async (req, res) => {
    const { role } = req.user
    const { id } = req.params
    if (role !== 'admin') return res.status(403).json({ msg: 'Admin access only.' })
    try {
        const user = await User.findById(id)

        if (!user) res.status(404).json({ msg: "User not found." })

        user.status = user.status === 'blocked' ? 'active' : 'blocked'
        await user.save()
        res.status(200).json({ msg: `${user.username} status updated to ${user.status}.` })
    } catch (error) {
        console.error(error);
        res.status(500).json({ msg: 'Server error while updating user status.' })
    }
}


exports.toggleAdminUser = async (req, res) => {
    const { role } = req.user
    const { id } = req.params
    const { newRole } = req.body // Accept specific role from request
    if (role !== 'admin') return res.status(403).json({ msg: 'Admin access only.' })
    try {
        const user = await User.findById(id)

        if (!user) return res.status(404).json({ msg: "User not found." })

        // If newRole is provided, use it; otherwise cycle through roles
        if (newRole && ['user', 'admin', 'seller'].includes(newRole)) {
            user.role = newRole
        } else {
            // Cycle: user -> seller -> admin -> user
            if (user.role === 'user') {
                user.role = 'seller'
            } else if (user.role === 'seller') {
                user.role = 'admin'
            } else {
                user.role = 'user'
            }
        }
        
        await user.save()
        res.status(200).json({ msg: `${user.username}'s role updated to ${user.role}.` })
    } catch (error) {
        console.error(error);
        res.status(500).json({ msg: 'Server error while updating user role.' })
    }
}


exports.deleteUser = async (req, res) => {
    const { role } = req.user
    const { id } = req.params
    if (role !== 'admin') return res.status(403).json({ msg: 'Admin access only.' })
    try {
        const user = await User.findByIdAndDelete(id)

        // if (!user) res.status(404).json({ msg: "User not found." })

        // user.role = user.role === 'admin' ? 'user' : 'admin'
        // await user.save()
        res.status(200).json({ msg: `User has been successfully deleted.` })
    } catch (error) {
        console.error(error);
        res.status(500).json({ msg: 'Server error while deleting user.' })
    }
}

exports.deleteOwnAccount = async (req, res) => {
    const { id: _id } = req.user
    try {
        const user = await User.findByIdAndDelete(_id)
        if (!user) return res.status(404).json({ msg: 'User not found.' })
        res.status(200).json({ msg: 'Your account has been successfully deleted.' })
    } catch (error) {
        console.error(error);
        res.status(500).json({ msg: 'Server error while deleting account.' })
    }
}

exports.getSingle = async (req, res) => {
    const { id: _id } = req.user
    const { role, status, search } = req.query
    // if (userRole !== 'admin') return res.status(403).json({ msg: 'Admin access only.' })


    // let query = {}
    try {
        // if (role) query.role = role
        // if (status) query.status = status
        // if (search) query.username = { $regex: search, $options: 'i' }
        const user = await User.findById(_id).select('-password')
        res.status(200).json({ msg: 'User fetched succcessfully.', user: user })
    } catch (error) {
        console.error(error);
        res.status(500).json({ msg: 'Server error while fetching user.' })
    }
}


exports.updateUser = async (req, res) => {
    const { id: _id } = req.user
    const { username } = req.body

    try {
        if (!username) return res.status(401).json({ msg: 'Provide new username' })
        const user = await User.findByIdAndUpdate(_id, { username: username })
        if (!user) return res.status(404).json({ msg: 'User not found!' })
        await user.save()

        res.status(200).json({ msg: 'Your username has been updated successfully' })
    } catch (error) {
        console.error(error);
        res.status(500).json({ msg: 'Server error while updating username.' })
    }
}

// SPIN WHEEL DISABLED
// // Save spin result to user account
// exports.saveSpinResult = async (req, res) => {
//     const { id: _id } = req.user
//     const { spinResult, spinTimestamp, spinSelectedProducts } = req.body
//     try {
//         const user = await User.findById(_id)
//         if (!user) return res.status(404).json({ msg: 'User not found!' })
//         user.spinResult = spinResult
//         user.spinTimestamp = spinTimestamp
//         user.spinSelectedProducts = spinSelectedProducts || []
//         await user.save()
//         res.status(200).json({ msg: 'Spin result saved successfully', spinData: { spinResult: user.spinResult, spinTimestamp: user.spinTimestamp, spinSelectedProducts: user.spinSelectedProducts } })
//     } catch (error) { console.error(error); res.status(500).json({ msg: 'Server error while saving spin result.' }) }
// }
// // Get spin result from user account
// exports.getSpinResult = async (req, res) => {
//     const { id: _id } = req.user
//     try {
//         const user = await User.findById(_id).select('spinResult spinTimestamp spinSelectedProducts')
//         if (!user) return res.status(404).json({ msg: 'User not found!' })
//         res.status(200).json({ msg: 'Spin data fetched successfully', spinData: { spinResult: user.spinResult, spinTimestamp: user.spinTimestamp, spinSelectedProducts: user.spinSelectedProducts } })
//     } catch (error) { console.error(error); res.status(500).json({ msg: 'Server error while fetching spin result.' }) }
// }
// // Update spin selected products
// exports.updateSpinProducts = async (req, res) => {
//     const { id: _id } = req.user
//     const { spinSelectedProducts } = req.body
//     try {
//         const user = await User.findById(_id)
//         if (!user) return res.status(404).json({ msg: 'User not found!' })
//         user.spinSelectedProducts = spinSelectedProducts
//         await user.save()
//         res.status(200).json({ msg: 'Spin products updated successfully', spinSelectedProducts: user.spinSelectedProducts })
//     } catch (error) { console.error(error); res.status(500).json({ msg: 'Server error while updating spin products.' }) }
// }
// // Mark spin as checked out
// exports.markSpinCheckedOut = async (req, res) => {
//     const { id: _id } = req.user
//     try {
//         const user = await User.findById(_id)
//         if (!user) return res.status(404).json({ msg: 'User not found!' })
//         if (user.spinResult) { user.spinResult.hasCheckedOut = true; await user.save() }
//         res.status(200).json({ msg: 'Spin marked as checked out', spinResult: user.spinResult })
//     } catch (error) { console.error(error); res.status(500).json({ msg: 'Server error while marking spin as checked out.' }) }
// }

// Become a seller - update user role and save seller information
exports.becomeSeller = async (req, res) => {
    const { id: _id } = req.user
    const { phoneNumber, address, city, country, businessName } = req.body

    try {
        // Check if user exists
        const user = await User.findById(_id)
        if (!user) return res.status(404).json({ message: 'User not found!' })

        // Check if user is already a seller or admin
        if (user.role === 'seller' || user.role === 'admin') {
            return res.status(400).json({ message: 'You are already a seller or admin' })
        }

        // Validate required fields
        if (!phoneNumber || phoneNumber.trim().length < 10) {
            return res.status(400).json({ message: 'Please provide a valid phone number (at least 10 digits)' })
        }
        if (!address || address.trim().length < 5) {
            return res.status(400).json({ message: 'Please provide a valid address' })
        }
        if (!city || city.trim().length < 2) {
            return res.status(400).json({ message: 'Please provide your city' })
        }
        if (!country || country.trim().length < 2) {
            return res.status(400).json({ message: 'Please provide your country' })
        }

        // Update user role to seller and save seller information
        user.role = 'seller'
        user.sellerInfo = {
            phoneNumber: phoneNumber.trim(),
            address: address.trim(),
            city: city.trim(),
            country: country.trim(),
            businessName: businessName?.trim() || ''
        }
        
        await user.save()

        // Generate new JWT token with updated role
        const jwt = require('jsonwebtoken')
        const token = jwt.sign(
            { id: user._id, role: user.role },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        )

        res.status(200).json({ 
            message: 'Congratulations! You are now a seller',
            token: token, // New token with seller role
            user: {
                id: user._id,
                username: user.username,
                email: user.email,
                role: user.role,
                sellerInfo: user.sellerInfo
            }
        })
    } catch (error) {
        console.error('Error in becomeSeller:', error);
        res.status(500).json({ message: 'Server error while creating seller account.' })
    }
}