import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'react-toastify';
import Loader from '../common/Loader';
import { setCrossDomainCookie } from '../../utils/cookieHelper';
import { consumePostAuthRedirect, sanitizePostAuthRedirect } from '../../utils/postAuthRedirect';

const GoogleAuthSuccess = () => {
    const [searchParams] = useSearchParams();
    const navigate = useNavigate();

    useEffect(() => {
        const token = searchParams.get('token');
        const redirect = sanitizePostAuthRedirect(searchParams.get('redirect'));
        
        if (token) {
            // Store token
            localStorage.setItem('jwtToken', token);
            setCrossDomainCookie('rozare_jwt_token', token, 30);
            
            // Decode JWT to get user info
            const payload = JSON.parse(atob(token.split('.')[1]));
            
            // Store user info in localStorage
            localStorage.setItem('currentUser', JSON.stringify({
                id: payload.id,
                username: payload.username,
                email: payload.email,
                role: payload.role,
                avatar: payload.avatar
            }));
            
            toast.success('Signed in successfully with Google!');
            
            // If there's a redirect param (e.g., from seller signup flow), go there
            if (redirect) {
                window.location.href = redirect;
                return;
            }

            // Also check localStorage for seller signup redirect flag (with 10-min expiry)
            const sellerRedirect = localStorage.getItem('sellerSignupRedirect');
            if (sellerRedirect) {
                localStorage.removeItem('sellerSignupRedirect');
                try {
                    const { timestamp } = JSON.parse(sellerRedirect);
                    if (timestamp && Date.now() - timestamp < 10 * 60 * 1000) {
                        window.location.href = '/become-seller?from=google';
                        return;
                    }
                } catch {
                    // Invalid JSON, ignore stale flag
                }
            }

            const rememberedRedirect = consumePostAuthRedirect('');
            if (rememberedRedirect) {
                window.location.href = rememberedRedirect;
                return;
            }
            
            // Redirect based on role
            if (payload.role === 'admin') {
                window.location.href = '/admin-dashboard/store-overview';
            } else if (payload.role === 'seller') {
                window.location.href = '/seller-dashboard/store-overview';
            } else {
                window.location.href = '/';
            }
        } else {
            toast.error('Authentication failed');
            navigate('/login?error=auth_failed');
        }
    }, [searchParams, navigate]);

    return (
        <div className="min-h-screen flex items-center justify-center">
            <Loader text="Completing sign in..." />
        </div>
    );
};

export default GoogleAuthSuccess;
