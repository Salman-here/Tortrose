import { createContext, useContext, useEffect, useRef, useState, useCallback } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import { useAuth } from "./AuthContext";
import { useBuyerLocation } from "./BuyerLocationContext";
import { setCrossDomainCookie, getCookie, deleteCookie, getAuthToken } from "../utils/cookieHelper";
import { trackAddToCart, trackAddToWishlist } from "../utils/tiktokPixel";
import {
    guestCartPresentationTotal,
    normalizeServerCartPayload,
} from "../utils/cartPresentation";
import {
    decrementGuestCartLine,
    guestCartPayload,
    incrementGuestCartLine,
    normalizeGuestCart,
    optionsKeyOf,
    parseStoredGuestCart,
    serializeGuestCart,
} from "../utils/guestCart";

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
    const cookieData = getCookie(GUEST_CART_COOKIE);
    let cookieError = null;
    if (cookieData) {
        try {
            return parseStoredGuestCart(cookieData);
        } catch (error) {
            cookieError = error;
        }
    }

    const localData = localStorage.getItem(GUEST_CART_KEY);
    if (localData) {
        const cart = parseStoredGuestCart(localData);
        saveGuestCart(cart);
        return cart;
    }
    if (cookieError) throw cookieError;
    return [];
};

const saveGuestCart = (cart) => {
    const normalized = normalizeGuestCart(cart);
    const cartData = serializeGuestCart(normalized);
    setCrossDomainCookie(GUEST_CART_COOKIE, cartData, 30);
    localStorage.setItem(GUEST_CART_KEY, cartData);
    if (localStorage.getItem(GUEST_CART_KEY) !== cartData) {
        const error = new Error('The guest cart could not be persisted safely.');
        error.code = 'CART_PRESENTATION_DATA_INVALID';
        throw error;
    }
    return normalized;
};

const clearGuestCart = () => {
    deleteCookie(GUEST_CART_COOKIE);
    localStorage.removeItem(GUEST_CART_KEY);
};

const guestCartState = (cart) => ({ cart, ...guestCartPresentationTotal(cart) });




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
        totalCartCurrency: null,
        cart: []
    })

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
    const [cartHydrationStatus, setCartHydrationStatus] = useState('hydrating')
    const [cartHydrationError, setCartHydrationError] = useState(null)
    const [hydratedCartOwner, setHydratedCartOwner] = useState(null)
    const cartOwner = String(currentUser?._id || currentUser?.id || 'guest')
    const cartOwnerRef = useRef(cartOwner)
    const cartReadRequestRef = useRef(0)
    const cartHydrationRequestRef = useRef(0)
    const cartHydrationOwnerRef = useRef(null)
    const cartHydrationPromiseRef = useRef(null)
    const cartHydrationStatusRef = useRef(cartHydrationStatus)
    const hydratedCartOwnerRef = useRef(hydratedCartOwner)
    cartOwnerRef.current = cartOwner
    cartHydrationStatusRef.current = cartHydrationStatus
    hydratedCartOwnerRef.current = hydratedCartOwner
    const isCartReady = cartHydrationStatus === 'ready' && hydratedCartOwner === cartOwner


    // ===================================
    // CART LOGIC
    // ===================================
    const [loadingProductId, setLoadingProductId] = useState(null)
    
    const handleAddToCart = async (id, selectedColor = null, selectedOptions = null) => {
        try {
            setIsCartLoading(true)
            setLoadingProductId(id)
            const myKey = optionsKeyOf(selectedOptions);

            const existingCartItem = cartItems?.cart?.find(item =>
                item?.product?._id === id &&
                item?.selectedColor === selectedColor &&
                optionsKeyOf(item?.selectedOptions) === myKey
            ) || null;

            if (existingCartItem) {
                await handleRemoveCartItem(existingCartItem._id);
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
                    if (!Number.isSafeInteger(pData?.stock) || pData.stock < 1) {
                        throw new Error('This product is currently out of stock.');
                    }
                    const gc = getGuestCart();
                    const nextCart = saveGuestCart([
                        ...gc,
                        { product: pData, qty: 1, selectedColor, selectedOptions: selectedOptions || undefined },
                    ]);
                    setCartItems(guestCartState(nextCart));
                    trackAddToCart(pData, 1);
                    toast.success('Added to cart');
                } catch (error) { toast.error(error?.message || 'Failed to add to cart'); }
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
            setCartItems(normalizeServerCartPayload(res.data))

        } catch (error) {
            console.error(error);
            toast.error(error.response?.data?.msg || 'Failed to add to cart')
        }
        finally {
            setIsCartLoading(false)
            setLoadingProductId(null)
        }
    }

    const fetchAuthoritativeCart = useCallback(async (owner, reportError = true) => {
        const requestId = ++cartReadRequestRef.current
        try {
            setIsCartLoading(true)
            if (owner === 'guest') {
                const guestCart = getGuestCart()
                if (requestId === cartReadRequestRef.current && cartOwnerRef.current === owner) {
                    setCartItems(guestCartState(guestCart))
                }
                return guestCartState(guestCart)
            }

            const token = getAuthToken()
            if (!token) {
                throw new Error('Your authenticated cart session is unavailable.')
            }
            const res = await axios.get(`${import.meta.env.VITE_API_URL}api/cart/get`,
                {
                    headers: {
                        Authorization: `Bearer ${token}`
                    }
                })
            const nextCart = normalizeServerCartPayload(res.data)
            if (requestId === cartReadRequestRef.current && cartOwnerRef.current === owner) {
                setCartItems(nextCart)
            }
            return nextCart
        } catch (error) {
            if (reportError && error.response?.status !== 403) {
                console.error(error);
                if (!isTransientReadError(error)) {
                    toast.error(error.response?.data?.msg || 'Failed to fetch cart')
                }
            }
            throw error
        }
        finally {
            if (requestId === cartReadRequestRef.current) setIsCartLoading(false)
        }
    }, [])

    const synchronizeCart = useCallback(async () => {
        const owner = cartOwnerRef.current
        const hydrationId = ++cartHydrationRequestRef.current
        cartHydrationOwnerRef.current = owner
        cartHydrationStatusRef.current = 'hydrating'
        setCartHydrationStatus('hydrating')
        setCartHydrationError(null)
        setIsCartLoading(true)

        try {
            if (owner === 'guest') {
                // Invalidate an authenticated read that may have started before logout.
                ++cartReadRequestRef.current
                const guestCart = getGuestCart()
                if (hydrationId !== cartHydrationRequestRef.current || cartOwnerRef.current !== owner) return null
                setWishlistItems([])
                setCartItems(guestCartState(guestCart))
            } else {
                const guestCart = getGuestCart()
                if (guestCart.length > 0) {
                    const token = getAuthToken()
                    if (!token) throw new Error('Your authenticated cart session is unavailable.')
                    await axios.post(
                        `${import.meta.env.VITE_API_URL}api/cart/merge`,
                        {
                            items: guestCartPayload(guestCart),
                        },
                        { headers: { Authorization: `Bearer ${token}` } }
                    )
                    // Clear only after the server accepted the full persisted bag.
                    // The subsequent GET is still required: merge output is not used
                    // as the checkout-authoritative cart snapshot.
                    clearGuestCart()
                }
                await fetchAuthoritativeCart(owner, false)
            }

            if (hydrationId !== cartHydrationRequestRef.current || cartOwnerRef.current !== owner) return null
            hydratedCartOwnerRef.current = owner
            cartHydrationStatusRef.current = 'ready'
            setHydratedCartOwner(owner)
            setCartHydrationStatus('ready')
            return true
        } catch (error) {
            if (hydrationId !== cartHydrationRequestRef.current || cartOwnerRef.current !== owner) return null
            const message = error.response?.data?.msg || error.message || 'Your cart could not be synchronized.'
            console.error('Guest cart synchronization failed:', error)
            cartHydrationStatusRef.current = 'error'
            setCartHydrationError(message)
            setCartHydrationStatus('error')
            return false
        } finally {
            if (hydrationId === cartHydrationRequestRef.current) setIsCartLoading(false)
        }
    }, [fetchAuthoritativeCart])

    const retryCartHydration = useCallback(() => {
        const owner = cartOwnerRef.current
        if (
            cartHydrationStatusRef.current === 'hydrating'
            && cartHydrationOwnerRef.current === owner
            && cartHydrationPromiseRef.current
        ) return cartHydrationPromiseRef.current
        const operation = synchronizeCart()
        cartHydrationPromiseRef.current = operation
        return operation
    }, [synchronizeCart])

    const fetchCart = useCallback(() => {
        const owner = cartOwnerRef.current
        if (
            cartHydrationStatusRef.current !== 'ready'
            || hydratedCartOwnerRef.current !== owner
        ) {
            // A settled hydration promise may belong to the guest or another
            // signed-in account. Route every non-ready refresh through the
            // owner-aware coalescer so it cannot resolve until this owner's
            // merge and authoritative fetch have completed.
            return retryCartHydration()
        }
        return fetchAuthoritativeCart(owner)
    }, [fetchAuthoritativeCart, retryCartHydration])

    useEffect(() => {
        retryCartHydration()
    }, [cartOwner, retryCartHydration])

    const handleQtyInc = async (id) => {
        try {
            setQtyUpdateId(id)

            if (!currentUser) {
                const gc = getGuestCart();
                const item = gc.find(cartItem => cartItem._id === id);
                if (!item) return;
                const result = incrementGuestCartLine(gc, id);
                if (result.reachedStockLimit) {
                    toast.error('You have reached stock limit');
                    return;
                }
                const nextCart = saveGuestCart(result.cart);
                setCartItems(guestCartState(nextCart));
                return;
            }

            const token = getAuthToken()
            const res = await axios.patch(`${import.meta.env.VITE_API_URL}api/cart/qty-inc/${id}`,
                {},
                {
                    headers: {
                        Authorization: `Bearer ${token}`
                    }
                }
            )
            setCartItems(normalizeServerCartPayload(res.data))
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

            const cartItem = cartItems?.cart?.find(item => item._id === id);
            if (!cartItem) return;

            if (!Number.isSafeInteger(cartItem.qty) || cartItem.qty < 1) {
                const error = new Error('The cart quantity could not be verified.');
                error.code = 'CART_PRESENTATION_DATA_INVALID';
                throw error;
            }
            if (cartItem.qty <= 1) {
                await handleRemoveCartItem(id);
                return;
            }

            if (!currentUser) {
                const gc = getGuestCart();
                const item = gc.find(guestItem => guestItem._id === id);
                if (!item) return;
                const nextCart = saveGuestCart(decrementGuestCartLine(gc, id));
                setCartItems(guestCartState(nextCart));
                return;
            }

            const token = getAuthToken()
            const res = await axios.patch(`${import.meta.env.VITE_API_URL}api/cart/qty-dec/${id}`,
                {},
                {
                    headers: {
                        Authorization: `Bearer ${token}`
                    }
                }
            )
            setCartItems(normalizeServerCartPayload(res.data))
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
                const gc = normalizeGuestCart(getGuestCart()).filter(item => {
                    if (item._id === id) return false;
                    return !(item.product?._id === id && item.selectedColor === selectedColor);
                });
                const nextCart = saveGuestCart(gc);
                setCartItems(guestCartState(nextCart));
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
            

            setCartItems(normalizeServerCartPayload(res.data))
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
    
    // Action functions close over the latest cart/auth state. Building the
    // value directly avoids retaining an old function through incomplete memo
    // dependencies during account or cart transitions.
    const contextValue = {
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
        isCartReady,
        cartHydrationStatus,
        cartHydrationError,
        retryCartHydration,
        loadingProductId,

        qtyUpdateId
    };
    
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
