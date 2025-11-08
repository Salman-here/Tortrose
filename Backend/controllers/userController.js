
const User = require('../models/User')

exports.getUsers = async (req, res) => {
    const { role: userRole, id: _id } = req.user
    const { role, status, search } = req.query
    if (userRole !== 'admin') return res.status(403).json({ msg: 'Admin access only.' })


    let query = {}
    try {
        if (role) query.role = role
        if (status) query.status = status
        if (search) query.username = { $regex: search, $options: 'i' }
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

// Save spin result to user account
exports.saveSpinResult = async (req, res) => {
    const { id: _id } = req.user
    const { spinResult, spinTimestamp, spinSelectedProducts } = req.body

    try {
        const user = await User.findById(_id)
        if (!user) return res.status(404).json({ msg: 'User not found!' })

        user.spinResult = spinResult
        user.spinTimestamp = spinTimestamp
        user.spinSelectedProducts = spinSelectedProducts || []
        
        await user.save()

        res.status(200).json({ 
            msg: 'Spin result saved successfully',
            spinData: {
                spinResult: user.spinResult,
                spinTimestamp: user.spinTimestamp,
                spinSelectedProducts: user.spinSelectedProducts
            }
        })
    } catch (error) {
        console.error(error);
        res.status(500).json({ msg: 'Server error while saving spin result.' })
    }
}

// Get spin result from user account
exports.getSpinResult = async (req, res) => {
    const { id: _id } = req.user

    try {
        const user = await User.findById(_id).select('spinResult spinTimestamp spinSelectedProducts')
        if (!user) return res.status(404).json({ msg: 'User not found!' })

        res.status(200).json({ 
            msg: 'Spin data fetched successfully',
            spinData: {
                spinResult: user.spinResult,
                spinTimestamp: user.spinTimestamp,
                spinSelectedProducts: user.spinSelectedProducts
            }
        })
    } catch (error) {
        console.error(error);
        res.status(500).json({ msg: 'Server error while fetching spin result.' })
    }
}

// Update spin selected products
exports.updateSpinProducts = async (req, res) => {
    const { id: _id } = req.user
    const { spinSelectedProducts } = req.body

    try {
        const user = await User.findById(_id)
        if (!user) return res.status(404).json({ msg: 'User not found!' })

        user.spinSelectedProducts = spinSelectedProducts
        await user.save()

        res.status(200).json({ 
            msg: 'Spin products updated successfully',
            spinSelectedProducts: user.spinSelectedProducts
        })
    } catch (error) {
        console.error(error);
        res.status(500).json({ msg: 'Server error while updating spin products.' })
    }
}

// Mark spin as checked out
exports.markSpinCheckedOut = async (req, res) => {
    const { id: _id } = req.user

    try {
        const user = await User.findById(_id)
        if (!user) return res.status(404).json({ msg: 'User not found!' })

        if (user.spinResult) {
            user.spinResult.hasCheckedOut = true
            await user.save()
        }

        res.status(200).json({ 
            msg: 'Spin marked as checked out',
            spinResult: user.spinResult
        })
    } catch (error) {
        console.error(error);
        res.status(500).json({ msg: 'Server error while marking spin as checked out.' })
    }
}