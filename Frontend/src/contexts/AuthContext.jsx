// src/context/AuthContext.js
import { createContext, useContext, useEffect, useState } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import { useNavigate } from "react-router-dom";
import { useGlobal } from "./GlobalContext";

const AuthContext = createContext();

export const AuthProvider = ({ children }) => {

    // const {
    //     fetchCart
    // } = useGlobal()

    const [currentUser, setCurrentUser] = useState(() => {
        let user = localStorage.getItem('currentUser')
        if (user && user !== 'undefined' && user !== 'null') {
            try {
                return JSON.parse(user)
            } catch (error) {
                console.error('Error parsing currentUser:', error);
                localStorage.removeItem('currentUser');
                return null;
            }
        }
        return null;
    });

    const navigate = useNavigate()

    const fetchAndUpdateCurrentUser = async () => {
        try {
            const token = localStorage.getItem('jwtToken')
            if (!token) {
                // No token, user not logged in - this is normal
                return;
            }
            const res = await axios.get(`${import.meta.env.VITE_API_URL}api/user/single`,
                {
                    headers: {
                        Authorization: `Bearer ${token}`
                    }
                }
            )
            setCurrentUser(res.data?.user)
        } catch (error) {
            // Only log error if it's not a 403 (unauthorized)
            if (error.response?.status !== 403) {
                console.error(error);
            }
        }
    }

    useEffect(() => {
        fetchAndUpdateCurrentUser()
    }, [])
    useEffect(() => {
        localStorage.setItem('currentUser', JSON.stringify(currentUser))
    }, [currentUser])

    // SIGNUP FUNCTION
    const signup = async (data, reset, setIsLoginActive) => {
        try {
            const res = await axios.post(`${import.meta.env.VITE_API_URL}api/auth/registerr`, data);
            toast.success(res.data.msg);
            reset();
            setIsLoginActive(true); // Switch to login form after successful signup
        } catch (error) {
            console.error(error);
            toast.error(error.response?.data?.msg || "Signup failed");
        }
    };

    // LOGIN FUNCTION
    const login = async (data, reset) => {
        try {
            const res = await axios.post(`${import.meta.env.VITE_API_URL}api/auth/login`, data);
            toast.success(res.data.msg);
            localStorage.setItem("jwtToken", res.data.token);
            setCurrentUser(res.data.user);
            reset();
            navigate('/')
            location.reload()
        } catch (error) {
            console.error(error);
            // Re-throw so Login component can catch and show inline error
            throw error;
        }
    };

    // ✅ LOGOUT FUNCTION
    const logout = () => {
        localStorage.removeItem("jwtToken");
        setCurrentUser(null);
        toast.info("Logged out successfully");
        navigate('/')
    };

    return (
        <AuthContext.Provider value={{ currentUser, setCurrentUser, fetchAndUpdateCurrentUser , signup, login, logout }}>
            {children}
        </AuthContext.Provider>
    );
};

export const useAuth = () => useContext(AuthContext);
