import { createContext, useContext, useEffect, useRef, useState, useCallback, useMemo } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import { useAuth } from "./AuthContext";
import { useBuyerLocation } from "./BuyerLocationContext";
import { setCrossDomainCookie, getCookie, deleteCookie, migrateLocalStorageToCookie, getAuthToken } from "../utils/cookieHelper";
import { trackAddToCart, trackAddToWishlist } from "../utils/tiktokPixel";

const GlobalContext = createContext();

const GUEST_CART_KEY = 'guestCart';
const GUEST_CART_COOKIE = 'rozare_guest_cart';
const TRANSIENT_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

const isTransientReadError = (error) => (
    error?.code === 'ERR_NETWORK' ||
    error?.code === 'ECONNABORTED' ||
    TRANSIENT_STATUSES.has(error?.response?.status)
);

// Helper functions for guest cart - now using cookies for cross-subdomain support
const getGuestCart = () => { 
    try {
        // Try cookie first (new method)
        const cookieData = getCookie(GUEST_CART_COOKIE);
        if (cookieData) {
            return JSON.parse(cookieData);
        }
        
        // Fallback to localStorage (old method) and migrate
        const localData = localStorage.getItem(GUEST_CART_KEY);
        if (localData) {
            const cart = JSON.parse(localData);
            // Migrate to cookie
            saveGuestCart(cart);
            return cart;
        }
        
        return [];
    } catch { 
        return []; 
    } 
};

const saveGuestCart = (cart) => {
    try {
        const cartData = JSON.stringify(cart);
        // Save to cookie (primary storage)
        setCrossDomainCookie(GUEST_CART_COOKIE, cartData, 30);
        // Also save to localStorage as backup
        localStorage.setItem(GUEST_CART_KEY, cartData);
    } catch (error) {
        console.error('Error saving guest cart:', error);
    }
};

const clearGuestCart = () => {
    deleteCookie(GUEST_CART_COOKIE);
    localStorage.removeItem(GUEST_CART_KEY);
};

const effectiveProductPrice = (product) => {
    const price = Number(product?.price || 0);
    const discountedPrice = Number(product?.discountedPrice || 0);
    return discountedPrice > 0 && discountedPrice < price ? discountedPrice : price;
};

const calcGuestTotal = (cart) => cart.reduce((s, i) => s + (effectiveProductPrice(i.product) * i.qty), 0);




export const GlobalProvider = ({ children }) => {

    const {
        currentUser
    } = useAuth()
    const { appendLocationParams } = useBuyerLocation()


    const [isWishlistOpen, setIsWishlistOpen] = useState(false);
    const [wishlistItems, setWishlistItems] = useState([])
    // const [isCartFetched, setIsCartFetched] = useState(false)
    const [cartItems, setCartItems] = useState({
        totalCartPrice: 0,
        cart: []
    })

    useEffect(() => {
        if (!currentUser) {
            const gc = getGuestCart();
            setCartItems({ cart: gc, totalCartPrice: calcGuestTotal(gc) });
            setWishlistItems([]);
        }
    }, [currentUser])

    useEffect(() => {
        if (currentUser) {
            (async () => {
                const gc = getGuestCart();
                if (gc.length > 0) {
                    try {
                        const token = getAuthToken();
                        const res = await axios.post(
                            `${import.meta.env.VITE_API_URL}api/cart/merge`,
                            {
                                items: gc.map((item) => ({
                                    productId: item.product?._id,
                                    qty: item.qty,
                                    selectedColor: item.selectedColor || null,
                                    selectedOptions: item.selectedOptions || undefined,
                                })),
                            },
                            { headers: { Authorization: `Bearer ${token}` } }
                        );
                        clearGuestCart();
                        setCartItems({
                            cart: res.data.cart || [],
                            totalCartPrice: res.data.totalCartPrice || 0,
                        });
                    } catch (e) { console.error('Guest cart sync failed:', e); }
                }
                fetchCart();
            })();
        }
    }, [currentUser])

    const fetchWishlist = async () => {

        try {
            let token = getAuthToken()
            const res = await axios.get(`${import.meta.env.VITE_API_URL}api/products/get-wishlist`, {
                headers: {
                    Authorization: `Bearer ${token}`
                }
            })
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
            const token = getAuthToken();
            const res = await axios.get(
                `${import.meta.env.VITE_API_URL}api/products/add-to-wishlist/${id}`,
                { headers: { Authorization: `Bearer ${token}` } }
            );
            toast.success(res.data.msg);
            if (res.data.product) {
                trackAddToWishlist(res.data.product);
            }
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
            const token = getAuthToken();
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
    
    const optionsKeyOf = (opts) => opts ? Object.keys(opts).filter(k => opts[k]).sort().map(k => `${k}:${opts[k]}`).join('|') : '';

    const handleAddToCart = async (id, selectedColor = null, selectedOptions = null) => {
        try {
            setIsCartLoading(true)
            setLoadingProductId(id)
            const myKey = optionsKeyOf(selectedOptions);

            const isInCart = cartItems?.cart?.some(item =>
                item?.product?._id === id &&
                item?.selectedColor === selectedColor &&
                optionsKeyOf(item?.selectedOptions) === myKey
            ) || false;

            if (isInCart) {
                await handleRemoveCartItem(id, selectedColor);
                setIsCartLoading(false);
                setLoadingProductId(null);
                return;
            }

            if (!currentUser) {
                try {
                    const params = new URLSearchParams();
                    appendLocationParams(params);
                    const suffix = params.toString();
                    const pRes = await axios.get(`${import.meta.env.VITE_API_URL}api/products/get-single-product/${id}${suffix ? `?${suffix}` : ''}`);
                    const pData = pRes.data.product || pRes.data;
                    const gc = getGuestCart();
                    gc.push({ product: pData, qty: 1, selectedColor, selectedOptions: selectedOptions || undefined, _id: `guest_${Date.now()}` });
                    saveGuestCart(gc);
                    setCartItems({ cart: gc, totalCartPrice: calcGuestTotal(gc) });
                    trackAddToCart(pData, 1);
                    toast.success('Added to cart');
                } catch { toast.error('Failed to add to cart'); }
                setIsCartLoading(false);
                setLoadingProductId(null);
                return;
            }

            const token = getAuthToken()
            const res = await axios.post(`${import.meta.env.VITE_API_URL}api/cart/add/${id}`,
                { selectedColor, selectedOptions: selectedOptions || undefined },
                { headers: { Authorization: `Bearer ${token}` } })
            toast.success(res.data.msg)

            const addedItem = res.data.cart?.find(item =>
                item?.product?._id === id &&
                item?.selectedColor === selectedColor &&
                optionsKeyOf(item?.selectedOptions) === myKey
            );
            if (addedItem?.product) trackAddToCart(addedItem.product, 1);

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
            const token = getAuthToken()
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
            // toast.success(res.data.msg)
            setCartItems((prev) => ({ ...prev, cart: res.data.cart, totalCartPrice: res.data.totalCartPrice }))
        } catch (error) {
            // Only log error if it's not a 403 (unauthorized)
            if (error.response?.status !== 403) {
                console.error(error);
                if (!isTransientReadError(error)) {
                    toast.error(error.response?.data?.msg || 'Failed to fetch cart')
                }
            }
        }
        finally {
            setIsCartLoading(false)
        }
    }

    const handleQtyInc = async (id) => {
        try {
            setQtyUpdateId(id)
            const token = getAuthToken()
            const res = await axios.patch(`${import.meta.env.VITE_API_URL}api/cart/qty-inc/${id}`,
                {},
                {
                    headers: {
                        Authorization: `Bearer ${token}`
                    }
                }
            )
            setCartItems((prev) => ({ ...prev, cart: res.data.cart, totalCartPrice: res.data.totalCartPrice }))
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

            const token = getAuthToken()
            const res = await axios.patch(`${import.meta.env.VITE_API_URL}api/cart/qty-dec/${id}`,
                {},
                {
                    headers: {
                        Authorization: `Bearer ${token}`
                    }
                }
            )
            setCartItems((prev) => ({ ...prev, cart: res.data.cart, totalCartPrice: res.data.totalCartPrice }))
        } catch (error) {
            console.error(error?.response?.data?.msg || 'Failed to decrease quantity');
            toast.error(error?.response?.data?.msg || 'Failed to decrease quantity');
        }
        finally {
            setQtyUpdateId(null)
        }
    }

    const handleRemoveCartItem = async (id, selectedColor = null) => {
        try {
            setQtyUpdateId(id)

            if (!currentUser) {
                const gc = getGuestCart().filter(i => !(i.product._id === id && i.selectedColor === selectedColor));
                saveGuestCart(gc);
                setCartItems({ cart: gc, totalCartPrice: calcGuestTotal(gc) });
                toast.info('Item removed from your cart');
                setQtyUpdateId(null);
                return;
            }

            const token = getAuthToken()
            const res = await axios.delete(`${import.meta.env.VITE_API_URL}api/cart/remove/${id}`,
                {
                    headers: {
                        Authorization: `Bearer ${token}`
                    }
                }
            )
            

            setCartItems((prev) => ({ ...prev, cart: res.data.cart, totalCartPrice: res.data.totalCartPrice }))
            toast.info(res.data?.msg || 'Item removed from your cart')
        } catch (error) {
            console.error(error);
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
    
    // Memoize context value to prevent unnecessary re-renders
    const contextValue = useMemo(() => ({
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
    }), [
        isWishlistOpen,
        wishlistItems,
        cartItems,
        isOpen,
        isOverlayOpen,
        isCartLoading,
        loadingProductId,
        qtyUpdateId
    ]);
    
    return (
        <GlobalContext.Provider value={contextValue}>
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
