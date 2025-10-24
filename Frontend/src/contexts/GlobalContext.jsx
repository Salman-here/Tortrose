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
            const res = await axios.get(`http://localhost:5000/api/products/get-wishlist`, {
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
                `http://localhost:5000/api/products/add-to-wishlist/${id}`,
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
                `http://localhost:5000/api/products/delete-from-wishlist/${id}`,
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
            const isInCart = cartItems.cart.some(item => item.product._id === id);
            
            if (isInCart) {
                // Remove from cart
                await handleRemoveCartItem(id);
                setIsCartLoading(false);
                setLoadingProductId(null);
                return;
            }
            
            // Check spin product limit (only if spin is active and not checked out)
            const spinResultStr = localStorage.getItem('spinResult');
            const spinResult = spinResultStr ? JSON.parse(spinResultStr) : null;
            const spinSelectedProducts = JSON.parse(localStorage.getItem('spinSelectedProducts') || '[]');
            
            // Only enforce 3-product limit if spin is active and not checked out
            if (spinResult && !spinResult.hasCheckedOut && spinSelectedProducts.length >= 3 && !spinSelectedProducts.includes(id)) {
                toast.error('You can only select 3 products with your spin discount!');
                setIsCartLoading(false);
                setLoadingProductId(null);
                return;
            }
            
            const token = localStorage.getItem('jwtToken')
            const res = await axios.post(`http://localhost:5000/api/cart/add/${id}`, {
            },
                {
                    headers: {
                        Authorization: `Bearer ${token}`
                    }
                })
            console.log(res.data.msg);
            toast.success(res.data.msg)
            
            // Track spin selected products (only if spin is active and not checked out)
            if (spinResult && !spinResult.hasCheckedOut && !spinSelectedProducts.includes(id)) {
                spinSelectedProducts.push(id);
                localStorage.setItem('spinSelectedProducts', JSON.stringify(spinSelectedProducts));
            }
            
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
            const res = await axios.get(`http://localhost:5000/api/cart/get`,
                {
                    headers: {
                        Authorization: `Bearer ${token}`
                    }
                })
            console.log(res.data);
            // toast.success(res.data.msg)
            setCartItems((prev) => ({ ...prev, cart: res.data.cart, totalCartPrice: res.data.totalCartPrice }))
        } catch (error) {
            console.error(error);
            toast.error(error.response?.data?.msg || 'Failed to fetch cart')
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
            const res = await axios.patch(`http://localhost:5000/api/cart/qty-inc/${id}`,
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
            const res = await axios.patch(`http://localhost:5000/api/cart/qty-dec/${id}`,
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
            const res = await axios.delete(`http://localhost:5000/api/cart/remove/${id}`,
                {
                    headers: {
                        Authorization: `Bearer ${token}`
                    }
                }
            )
            
            // Remove from spinSelectedProducts if it exists
            const spinSelectedProducts = JSON.parse(localStorage.getItem('spinSelectedProducts') || '[]');
            const updatedSpinProducts = spinSelectedProducts.filter(productId => productId !== id);
            localStorage.setItem('spinSelectedProducts', JSON.stringify(updatedSpinProducts));
            
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

export const useGlobal = () => useContext(GlobalContext);
