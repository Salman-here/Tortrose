// src/context/GlobalContext.js
import { createContext, useContext, useEffect, useRef, useState } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import { useAuth } from "./AuthContext";

const GlobalContext = createContext();




export const GlobalProvider = ({ children }) => {

    const {
        currentUser
    } = useAuth()


    const [isWishlistOpen, setIsWishlistOpen] = useState(false);
    const [wishlistItems, setWishlistItems] = useState([])
    // const [isCartFetched, setIsCartFetched] = useState(false)
    const [cartItems, setCartItems] = useState({
        totalCartPrice: 0,
        cart: []
    })

    useEffect(() => {
        if (!currentUser) {
            setCartItems({
                totalCartPrice: 0,
                cart: []
            })
            setWishlistItems([])
        }
    }, [currentUser])

    // useEffect(() => {
    //     fetchCart()
    // }, [])

    const fetchWishlist = async () => {

        try {
            let token = localStorage.getItem('jwtToken')
            const res = await axios.get(`${import.meta.env.VITE_API_URL}api/products/get-wishlist`, {
                headers: {
                    Authorization: `Bearer ${token}`
                }
            })
            console.log(res.data);
            setWishlistItems(res.data.wishlist)

        } catch (error) {
            console.error(error.response?.data.msg);
            toast.error(error.response?.data.msg)
        }
    }

    const handleAddToWishlist = async (id) => {
        try {
            if (!currentUser) {
                toast.info('Please login to add items to wishlist');
                return;
            }
            const token = localStorage.getItem('jwtToken');
            const res = await axios.get(
                `${import.meta.env.VITE_API_URL}api/products/add-to-wishlist/${id}`,
                { headers: { Authorization: `Bearer ${token}` } }
            );
            toast.success(res.data.msg);
            fetchWishlist();
        } catch (err) {
            toast.error(err.response?.data?.msg || 'Error adding to wishlist');
        }
    };

    const handleDeleteFromWishlist = async (id) => {
        try {
            if (!currentUser) {
                toast.info('Please login to manage wishlist');
                return;
            }
            const token = localStorage.getItem('jwtToken');
            const res = await axios.delete(
                `${import.meta.env.VITE_API_URL}api/products/delete-from-wishlist/${id}`,
                { headers: { Authorization: `Bearer ${token}` } }
            );
            toast.info(res.data.msg);
            fetchWishlist();
        } catch (err) {
            toast.error(err.response?.data?.msg || 'Error removing from wishlist');
        }

    }
    const [isCartLoading, setIsCartLoading] = useState(false)
    const [qtyUpdateId, setQtyUpdateId] = useState(null)


    // ===================================
    // CART LOGIC
    // ===================================
    const [loadingProductId, setLoadingProductId] = useState(null)
    
    const handleAddToCart = async (id) => {
        try {
            // Check if user is logged in
            if (!currentUser) {
                toast.info('Please login to add items to cart');
                return;
            }
            
            setIsCartLoading(true)
            setLoadingProductId(id)
            
            // Check if product is already in cart - if yes, remove it
            const isInCart = cartItems?.cart?.some(item => item?.product?._id === id) || false;
            
            if (isInCart) {
                // Remove from cart
                await handleRemoveCartItem(id);
                setIsCartLoading(false);
                setLoadingProductId(null);
                return;
            }
            

            const token = localStorage.getItem('jwtToken')
            const token = localStorage.getItem('jwtToken')
            const res = await axios.post(`${import.meta.env.VITE_API_URL}api/cart/add/${id}`, {
            },
                {
                    headers: {
                        Authorization: `Bearer ${token}`
                    }
                })
            console.log(res.data.msg);
            toast.success(res.data.msg)
            

            // Update cart items with fresh data from backend
            // Update cart items with fresh data from backend
            setCartItems((prev) => ({ ...prev, cart: res.data.cart, totalCartPrice: res.data.totalCartPrice }))

        } catch (error) {
            console.error(error);
            toast.error(error.response?.data?.msg || 'Failed to add to cart')
        }
        finally {
            setIsCartLoading(false)
            setLoadingProductId(null)
        }
    }

    const fetchCart = async () => {
        try {
            setIsCartLoading(true)
            const token = localStorage.getItem('jwtToken')
            if (!token) {
                // No token, user not logged in - this is normal
                setIsCartLoading(false)
                return;
            }
            const res = await axios.get(`${import.meta.env.VITE_API_URL}api/cart/get`,
                {
                    headers: {
                        Authorization: `Bearer ${token}`
                    }
                })
            console.log(res.data);
            // toast.success(res.data.msg)
            setCartItems((prev) => ({ ...prev, cart: res.data.cart, totalCartPrice: res.data.totalCartPrice }))
        } catch (error) {
            // Only log error if it's not a 403 (unauthorized)
            if (error.response?.status !== 403) {
                console.error(error);
                toast.error(error.response?.data?.msg || 'Failed to fetch cart')
            }
        }
        finally {
            setIsCartLoading(false)
        }
    }

    useEffect(() => {
        // console.log("isCartLoading:::", isCartLoading);
        console.log("qtyUpdateId:::", qtyUpdateId);

    }, [qtyUpdateId])

    const handleQtyInc = async (id) => {
        try {
            console.log('id::::', id);
            
            // Completely block quantity increase for ALL products
            toast.error('Quantity increase is disabled. Only 1 item per product allowed.');
            return;
            
            /* Old code - keeping for reference
            setQtyUpdateId(id)
            const token = localStorage.getItem('jwtToken')
            const res = await axios.patch(`${import.meta.env.VITE_API_URL}api/cart/qty-inc/${id}`,
                {},
                {
                    headers: {
                        Authorization: `Bearer ${token}`
                    }
                }
            )
            setCartItems((prev) => ({ ...prev, cart: res.data.cart, totalCartPrice: res.data.totalCartPrice }))
            console.log(res.data.msg);
            */
        } catch (error) {
            console.error(error?.response?.data?.msg || 'Failed to increase quantity');
            toast.error(error?.response?.data?.msg || 'Failed to increase quantity');
        }
        finally {
            setQtyUpdateId(null)
        }

    }

    const handleQtyDec = async (id) => {
        try {
            setQtyUpdateId(id)

            const token = localStorage.getItem('jwtToken')
            const res = await axios.patch(`${import.meta.env.VITE_API_URL}api/cart/qty-dec/${id}`,
                {},
                {
                    headers: {
                        Authorization: `Bearer ${token}`
                    }
                }
            )
            setCartItems((prev) => ({ ...prev, cart: res.data.cart, totalCartPrice: res.data.totalCartPrice }))
            console.log(res.data.msg);
        } catch (error) {
            console.error(error?.response?.data?.msg || 'Failed to decrease quantity');
            toast.error(error?.response?.data?.msg || 'Failed to decrease quantity');
        }
        finally {
            setQtyUpdateId(null)
        }
    }

    const handleRemoveCartItem = async (id) => {
        try {
            setQtyUpdateId(id)
            const token = localStorage.getItem('jwtToken')
            const res = await axios.delete(`${import.meta.env.VITE_API_URL}api/cart/remove/${id}`,
                {
                    headers: {
                        Authorization: `Bearer ${token}`
                    }
                }
            )
            

            setCartItems((prev) => ({ ...prev, cart: res.data.cart, totalCartPrice: res.data.totalCartPrice }))
            setCartItems((prev) => ({ ...prev, cart: res.data.cart, totalCartPrice: res.data.totalCartPrice }))
            console.log(res.data.msg);
            toast.info(res.data?.msg || 'Item removed from your cart')
        } catch (error) {
            console.log(error);
        }
        finally {
            setQtyUpdateId(null)
        }
    }

    // /////////////
    const [isOpen, setIsOpen] = useState(false);

    const dropdownRef = useRef(null);
    // Close dropdown when clicked outside

    const cartBtn = useRef(null)
    const toggleCart = () => setIsOpen((prev) => !prev);

    const [isOverlayOpen, setIsOverlayOpen] = useState(false)
    return (
        <GlobalContext.Provider value={{
            isWishlistOpen,
            setIsWishlistOpen,
            fetchWishlist,
            wishlistItems,
            handleAddToWishlist,
            handleDeleteFromWishlist,
            fetchCart,
            handleAddToCart,
            cartItems,

            handleQtyInc,
            handleQtyDec,
            handleRemoveCartItem,

            isOpen,
            setIsOpen,
            toggleCart,
            dropdownRef,

            isOverlayOpen,
            setIsOverlayOpen,
            cartBtn,
            isCartLoading,
            loadingProductId,

            qtyUpdateId
        }}>
            {children}
        </GlobalContext.Provider>
    );
};

export const useGlobal = () => {
  const context = useContext(GlobalContext);
  if (context === undefined) {
    throw new Error('useGlobal must be used within a GlobalProvider');
  }
  return context;
};
