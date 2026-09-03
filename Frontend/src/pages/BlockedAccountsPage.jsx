import { useEffect, useState } from 'react';
import axios from 'axios';
import { Ban, Loader2, ShieldCheck } from 'lucide-react';
import { toast } from 'react-toastify';
import SEOHead from '../components/common/SEOHead';
import { getAuthToken } from '../utils/cookieHelper';

const API = `${import.meta.env.VITE_API_URL}api/safety/blocks`;

export default function BlockedAccountsPage() {
  const [blocks, setBlocks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState('');

  useEffect(() => {
    axios.get(API, { headers: { Authorization: `Bearer ${getAuthToken()}` } })
      .then(response => setBlocks(response.data?.blocks || []))
      .catch(error => toast.error(error.response?.data?.msg || 'Could not load blocked accounts.'))
      .finally(() => setLoading(false));
  }, []);

  const unblock = async (userId) => {
    setBusyId(String(userId));
    try {
      await axios.delete(`${API}/${userId}`, { headers: { Authorization: `Bearer ${getAuthToken()}` } });
      setBlocks(previous => previous.filter(row => String(row.blocked?._id || row.blocked?.id) !== String(userId)));
      toast.success('Account unblocked.');
    } catch (error) { toast.error(error.response?.data?.msg || 'Could not unblock account.'); }
    finally { setBusyId(''); }
  };

  return <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12"><SEOHead title="Blocked Accounts" description="Manage the sellers and accounts you have blocked on Rozare." canonical="/settings/blocked-accounts" noindex /><div className="flex items-start gap-3 mb-7"><div className="w-12 h-12 rounded-2xl text-white flex items-center justify-center" style={{ background: 'linear-gradient(135deg,#14B8A6,#0EA5E9,#6366F1)' }}><ShieldCheck size={22} /></div><div><h1 className="text-2xl sm:text-3xl font-extrabold" style={{ color: 'hsl(var(--foreground))' }}>Blocked accounts</h1><p className="text-sm mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>Manage sellers and people whose content you have hidden.</p></div></div>{loading ? <div className="py-20 flex justify-center"><Loader2 className="animate-spin" /></div> : blocks.length === 0 ? <div className="glass-panel p-10 text-center"><ShieldCheck size={40} className="mx-auto mb-3" style={{ color: 'hsl(var(--primary))' }} /><h2 className="font-bold" style={{ color: 'hsl(var(--foreground))' }}>No blocked accounts</h2><p className="text-sm mt-2" style={{ color: 'hsl(var(--muted-foreground))' }}>Accounts you block will appear here. You can unblock them whenever you choose.</p></div> : <div className="space-y-3">{blocks.map(row => { const user = row.blocked || {}; const userId = user._id || user.id; const label = user.store?.storeName || user.username || 'Account'; return <div key={row._id} className="glass-card p-4 flex items-center gap-3">{user.avatar ? <img src={user.avatar} alt="" className="w-12 h-12 rounded-2xl object-cover" /> : <div className="w-12 h-12 rounded-2xl text-white font-bold flex items-center justify-center" style={{ background: 'hsl(var(--primary))' }}>{label.charAt(0).toUpperCase()}</div>}<div className="flex-1 min-w-0"><p className="font-bold truncate" style={{ color: 'hsl(var(--foreground))' }}>{label}</p><p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>{user.role === 'seller' ? 'Seller and store content hidden' : 'Account content hidden'}</p></div><button type="button" onClick={() => unblock(userId)} disabled={busyId === String(userId)} className="glass-button px-3 py-2 rounded-xl text-xs font-bold inline-flex items-center gap-2 disabled:opacity-50">{busyId === String(userId) ? <Loader2 size={14} className="animate-spin" /> : <Ban size={14} />} Unblock</button></div>; })}</div>}</div>;
}
