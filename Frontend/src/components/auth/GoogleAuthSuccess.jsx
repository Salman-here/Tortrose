import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'react-toastify';

const GoogleAuthSuccess = () => {
    const [searchParams] = useSearchParams();
    const navigate = useNavigate();

    useEffect(() => {
        const token = searchParams.get('token');
        
        if (token) {
            // Store token
            localStorage.setItem('jwtToken', token);
            
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
        <div className="min-h-screen flex items-center justify-center bg-gray-50">
            <div className="text-center">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-green-600 mx-auto"></div>
                <p className="mt-4 text-gray-600">Completing sign in...</p>
            </div>
        </div>
    );
};

export default GoogleAuthSuccess;
