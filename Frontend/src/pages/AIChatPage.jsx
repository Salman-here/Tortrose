import React, { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  MessageCircle, Plus, Trash2, Edit3, Check, X, ChevronLeft,
  Bot, Sparkles, Clock, Search, Menu, Zap, Star, ArrowRight, ShoppingBag
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import ChatBot from '../components/common/ChatBot';
import { getAuthToken } from "../utils/cookieHelper";
import { resilientFetch } from '../utils/httpResilience';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:5000/';
const readJsonResponse = async (response, message) => {
  if (!response.ok) throw new Error(`${message} (${response.status})`);
  return response.json();
};

// Brand gradient (matches Rozare logo: teal → sky → indigo)
const BRAND_GRADIENT = 'linear-gradient(135deg, #14B8A6 0%, #0EA5E9 50%, #6366F1 100%)';
const BRAND_PRIMARY = '#0EA5E9';

function AIChatPage() {
  const navigate = useNavigate();
  const { currentUser } = useAuth();
  const authToken = getAuthToken();
  const assistantRole = currentUser?.role === 'seller'
    ? 'seller'
    : currentUser?.role === 'admin'
      ? 'admin'
      : 'user';
  const welcomeContent = assistantRole === 'seller'
    ? {
        description: 'Your business assistant for products, orders, store settings, shipping, promotions, analytics, and more.',
        cards: [
          { icon: ShoppingBag, label: 'Catalog', desc: 'Create and manage products' },
          { icon: MessageCircle, label: 'Orders', desc: 'Review and fulfil orders' },
          { icon: Star, label: 'Promotions', desc: 'Manage coupons and featured items' },
          { icon: Zap, label: 'Business Insights', desc: 'Check sales, payments, and store data' },
        ],
      }
    : assistantRole === 'admin'
      ? {
          description: 'Your platform assistant for users, stores, orders, complaints, subscriptions, and operations.',
          cards: [
            { icon: Search, label: 'Platform Search', desc: 'Find users, stores, and orders' },
            { icon: MessageCircle, label: 'Support', desc: 'Review complaints and requests' },
            { icon: Star, label: 'Verification', desc: 'Manage store verification' },
            { icon: Zap, label: 'Operations', desc: 'Check analytics and platform data' },
          ],
        }
      : {
          description: 'Your personal shopping companion. Search products, manage orders, get style advice, and more.',
          cards: [
            { icon: Search, label: 'Smart Search', desc: 'Find products with AI-powered search' },
            { icon: Star, label: 'Style Advice', desc: 'Get personalized fashion tips' },
            { icon: MessageCircle, label: 'Order Help', desc: 'Track, cancel, or manage orders' },
            { icon: Zap, label: 'Quick Actions', desc: 'Add to cart, wishlist & more' },
          ],
        };

  const [conversations, setConversations] = useState([]);
  const [activeConvoId, setActiveConvoId] = useState(null);
  const [loadedMessages, setLoadedMessages] = useState(null);
  // Default sidebar: open on desktop, closed on mobile
  const [sidebarOpen, setSidebarOpen] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth >= 768 : true
  );
  const [editingId, setEditingId] = useState(null);
  const [editTitle, setEditTitle] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(false);

  const headers = { 'Content-Type': 'application/json', ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) };

  const loadConversations = useCallback(async () => {
    if (!authToken) return;
    try {
      const res = await resilientFetch(`${API_BASE}api/ai-chat/conversations`, { headers });
      const data = await readJsonResponse(res, 'Failed to load conversations');
      setConversations(data.conversations || []);
      if (data.activeConversationId && !activeConvoId) {
        setActiveConvoId(data.activeConversationId);
      }
    } catch (e) {
      console.error('Failed to load conversations:', e);
    }
  }, [authToken]);

  useEffect(() => { loadConversations(); }, [loadConversations]);

  const loadConversation = useCallback(async (convoId) => {
    if (!authToken || !convoId) return;
    setLoading(true);
    try {
      const res = await resilientFetch(`${API_BASE}api/ai-chat/conversations/${convoId}`, { headers });
      const data = await readJsonResponse(res, 'Failed to load conversation');
      setActiveConvoId(convoId);
      setLoadedMessages(data.messages || []);
      if (window.innerWidth < 768) setSidebarOpen(false);
    } catch (e) {
      console.error('Failed to load conversation:', e);
    } finally {
      setLoading(false);
    }
  }, [authToken]);

  const createNewChat = async () => {
    try {
      const res = await fetch(`${API_BASE}api/ai-chat/conversations`, {
        method: 'POST', headers, body: JSON.stringify({ title: 'New Chat' }),
      });
      const data = await res.json();
      setActiveConvoId(data._id);
      setLoadedMessages([]);
      await loadConversations();
    } catch (e) {
      console.error('Failed to create conversation:', e);
    }
  };

  const deleteConversation = async (convoId) => {
    try {
      await fetch(`${API_BASE}api/ai-chat/conversations/${convoId}`, { method: 'DELETE', headers });
      if (activeConvoId === convoId) {
        setActiveConvoId(null);
        setLoadedMessages(null);
      }
      await loadConversations();
    } catch (e) {
      console.error('Failed to delete conversation:', e);
    }
  };

  const saveRename = async (convoId) => {
    if (!editTitle.trim()) return;
    try {
      await fetch(`${API_BASE}api/ai-chat/conversations/${convoId}/rename`, {
        method: 'PATCH', headers, body: JSON.stringify({ title: editTitle }),
      });
      setEditingId(null);
      setEditTitle('');
      await loadConversations();
    } catch (e) {
      console.error('Failed to rename:', e);
    }
  };

  const filtered = conversations.filter(c =>
    !searchQuery || c.title?.toLowerCase().includes(searchQuery.toLowerCase()) ||
    c.preview?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const grouped = {};
  const order = ['Today', 'Yesterday', 'This Week', 'This Month', 'Older'];
  filtered.forEach(c => {
    const d = new Date(c.lastActive);
    const now = new Date();
    const diff = (now - d) / (1000 * 60 * 60 * 24);
    let label = 'Older';
    if (diff < 1) label = 'Today';
    else if (diff < 2) label = 'Yesterday';
    else if (diff < 7) label = 'This Week';
    else if (diff < 30) label = 'This Month';
    if (!grouped[label]) grouped[label] = [];
    grouped[label].push(c);
  });

  // Not logged in
  if (!currentUser) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center relative overflow-hidden p-6"
        style={{ background: 'hsl(var(--background))' }}>
        <div className="absolute top-10 left-10 w-72 h-72 rounded-full blur-[120px] opacity-25"
          style={{ background: '#14B8A6' }} />
        <div className="absolute bottom-10 right-10 w-80 h-80 rounded-full blur-[120px] opacity-20"
          style={{ background: '#6366F1' }} />
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
          className="text-center space-y-5 z-10 p-8 sm:p-10 rounded-3xl max-w-sm w-full"
          style={{ background: 'hsl(var(--muted) / 0.2)', border: '1px solid hsl(var(--border))', backdropFilter: 'blur(20px)' }}>
          <div className="w-16 h-16 mx-auto rounded-2xl flex items-center justify-center shadow-lg"
            style={{ background: BRAND_GRADIENT }}>
            <Bot size={32} className="text-white" />
          </div>
          <h2 className="text-2xl font-bold tracking-tight" style={{ color: 'hsl(var(--foreground))' }}>Sign in to Chat</h2>
          <p className="text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>
            Log in to start chatting with Rozare AI — your personal shopping assistant with saved conversations.
          </p>
          <button onClick={() => navigate('/login')}
            className="px-8 py-2.5 rounded-xl font-semibold text-white transition-all hover:scale-105 shadow-lg"
            style={{ background: BRAND_GRADIENT, boxShadow: '0 8px 24px -6px rgba(14,165,233,0.5)' }}>
            Sign In
          </button>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="flex h-[100dvh] overflow-hidden relative"
      style={{ background: 'hsl(var(--background))' }}>
      {/* Background decorative blobs */}
      <div className="fixed top-0 left-0 w-64 h-64 rounded-full blur-[150px] opacity-15 pointer-events-none"
        style={{ background: '#14B8A6' }} />
      <div className="fixed bottom-0 right-0 w-72 h-72 rounded-full blur-[150px] opacity-15 pointer-events-none"
        style={{ background: '#6366F1' }} />

      {/* Mobile sidebar backdrop */}
      <AnimatePresence>
        {sidebarOpen && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={() => setSidebarOpen(false)}
            className="fixed inset-0 bg-black/40 backdrop-blur-[2px] z-30 md:hidden"
            aria-hidden="true"
          />
        )}
      </AnimatePresence>

      {/* ─── Sidebar (overlay drawer on mobile, pushed panel on md+) ─── */}
      <AnimatePresence>
        {sidebarOpen && (
          <motion.aside
            initial={{ x: -320, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: -320, opacity: 0 }}
            transition={{ duration: 0.25, ease: 'easeInOut' }}
            className="flex flex-col overflow-hidden shrink-0 z-40 fixed md:static inset-y-0 left-0 w-[85vw] max-w-[320px] md:w-[300px]"
            style={{
              background: 'hsl(var(--background) / 0.96)',
              borderRight: '1px solid hsl(var(--border))',
              backdropFilter: 'blur(20px)',
            }}
          >
            {/* Sidebar Header */}
            <div className="p-3 space-y-3">
              <div className="flex items-center gap-2">
                <button onClick={() => navigate(-1)} className="p-1.5 rounded-lg transition-all hover:bg-white/10"
                  style={{ color: 'hsl(var(--muted-foreground))' }}>
                  <ChevronLeft size={18} />
                </button>
                <div className="flex-1 flex items-center gap-2">
                  <div className="w-7 h-7 rounded-lg flex items-center justify-center"
                    style={{ background: BRAND_GRADIENT }}>
                    <Bot size={14} className="text-white" />
                  </div>
                  <div>
                    <span className="text-sm font-bold block leading-tight" style={{ color: 'hsl(var(--foreground))' }}>AI Chat</span>
                    <span className="text-[9px]" style={{ color: 'hsl(var(--muted-foreground))' }}>Rozare Assistant</span>
                  </div>
                </div>
                <button onClick={() => setSidebarOpen(false)}
                  className="p-1.5 rounded-lg transition-all hover:bg-white/10 md:hidden"
                  style={{ color: 'hsl(var(--muted-foreground))' }}>
                  <X size={16} />
                </button>
              </div>

              {/* New Chat Button */}
              <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}
                onClick={createNewChat}
                className="w-full flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all"
                style={{
                  background: BRAND_GRADIENT,
                  color: 'white',
                  boxShadow: '0 4px 15px rgba(14,165,233,0.35)',
                }}>
                <Plus size={16} />
                New Chat
                <Zap size={12} className="ml-auto opacity-70" />
              </motion.button>

              {/* Search */}
              <div className="relative">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2"
                  style={{ color: 'hsl(var(--muted-foreground))' }} />
                <input
                  value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search conversations..."
                  className="w-full pl-9 pr-3 py-2 rounded-xl text-xs outline-none transition-all focus:ring-1"
                  style={{
                    background: 'hsl(var(--muted) / 0.15)',
                    color: 'hsl(var(--foreground))',
                    border: '1px solid hsl(var(--border))',
                    focusRingColor: 'rgba(14,165,233,0.40)',
                  }}
                />
              </div>
            </div>

            {/* Conversation List */}
            <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-2">
              {Object.keys(grouped).length === 0 && (
                <div className="text-center py-12">
                  <div className="w-12 h-12 mx-auto mb-3 rounded-2xl flex items-center justify-center"
                    style={{ background: 'hsl(var(--muted) / 0.2)', border: '1px dashed hsl(var(--border))' }}>
                    <Sparkles size={20} style={{ color: 'hsl(var(--muted-foreground))' }} />
                  </div>
                  <p className="text-xs font-medium" style={{ color: 'hsl(var(--muted-foreground))' }}>No conversations yet</p>
                  <p className="text-[10px] mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                    Start a new chat to begin
                  </p>
                </div>
              )}

              {order.filter(l => grouped[l]).map(label => (
                <div key={label}>
                  <div className="flex items-center gap-2 px-2 mb-1.5 mt-2">
                    <Clock size={10} style={{ color: 'hsl(var(--muted-foreground))' }} />
                    <p className="text-[10px] font-semibold uppercase tracking-wider"
                      style={{ color: 'hsl(var(--muted-foreground))' }}>{label}</p>
                    <div className="flex-1 h-px" style={{ background: 'hsl(var(--border))' }} />
                  </div>
                  {grouped[label].map(c => (
                    <motion.div key={c._id} whileHover={{ x: 2 }}
                      onClick={() => { if (editingId !== c._id) loadConversation(c._id); }}
                      className={`group flex items-center gap-2.5 px-3 py-2.5 rounded-xl cursor-pointer transition-all mb-1`}
                      style={{
                        background: activeConvoId === c._id
                          ? 'linear-gradient(135deg, rgba(20,184,166,0.15), rgba(99,102,241,0.10))'
                          : 'transparent',
                        border: activeConvoId === c._id
                          ? '1px solid rgba(14,165,233,0.30)'
                          : '1px solid transparent',
                      }}
                    >
                      <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
                        style={{
                          background: activeConvoId === c._id
                            ? 'linear-gradient(135deg, rgba(20,184,166,0.25), rgba(99,102,241,0.15))'
                            : 'hsl(var(--muted) / 0.2)',
                        }}>
                        <MessageCircle size={14}
                          style={{ color: activeConvoId === c._id ? '#0EA5E9' : 'hsl(var(--muted-foreground))' }} />
                      </div>
                      <div className="flex-1 min-w-0">
                        {editingId === c._id ? (
                          <div className="flex items-center gap-1">
                            <input value={editTitle} onChange={(e) => setEditTitle(e.target.value)}
                              className="flex-1 text-xs px-2 py-1 rounded-lg outline-none"
                              style={{ background: 'hsl(var(--muted) / 0.3)', color: 'hsl(var(--foreground))', border: '1px solid hsl(var(--border))' }}
                              onKeyDown={(e) => { if (e.key === 'Enter') saveRename(c._id); if (e.key === 'Escape') setEditingId(null); }}
                              autoFocus onClick={(e) => e.stopPropagation()}
                            />
                            <button onClick={(e) => { e.stopPropagation(); saveRename(c._id); }}
                              className="p-1 rounded-lg hover:bg-white/10"><Check size={12} style={{ color: 'hsl(150, 60%, 50%)' }} /></button>
                            <button onClick={(e) => { e.stopPropagation(); setEditingId(null); }}
                              className="p-1 rounded-lg hover:bg-white/10"><X size={12} style={{ color: 'hsl(0, 60%, 55%)' }} /></button>
                          </div>
                        ) : (
                          <>
                            <p className="text-xs font-medium truncate" style={{ color: 'hsl(var(--foreground))' }}>{c.title}</p>
                            <p className="text-[10px] truncate mt-0.5" style={{ color: 'hsl(var(--muted-foreground))' }}>
                              {c.preview || `${c.messageCount} messages`}
                            </p>
                          </>
                        )}
                      </div>
                      {editingId !== c._id && (
                        <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button onClick={(e) => { e.stopPropagation(); setEditingId(c._id); setEditTitle(c.title); }}
                            className="p-1.5 rounded-lg hover:bg-white/10 transition"><Edit3 size={11} style={{ color: 'hsl(var(--muted-foreground))' }} /></button>
                          <button onClick={(e) => { e.stopPropagation(); deleteConversation(c._id); }}
                            className="p-1.5 rounded-lg hover:bg-white/10 transition"><Trash2 size={11} style={{ color: 'hsl(0, 60%, 55%)' }} /></button>
                        </div>
                      )}
                    </motion.div>
                  ))}
                </div>
              ))}
            </div>

            {/* Sidebar Footer */}
            <div className="px-3 py-2 border-t" style={{ borderColor: 'hsl(var(--border))' }}>
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 rounded-full flex items-center justify-center"
                  style={{ background: BRAND_GRADIENT }}>
                  <Sparkles size={10} className="text-white" />
                </div>
                <span className="text-[10px]" style={{ color: 'hsl(var(--muted-foreground))' }}>
                  Powered by <span className="font-semibold" style={{ color: 'hsl(var(--foreground))' }}>Rozare AI</span>
                </span>
              </div>
            </div>
          </motion.aside>
        )}
      </AnimatePresence>

      {/* ─── Main Chat Area ─── */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar — always visible on mobile; only visible on desktop when sidebar is collapsed */}
        <div className={`${sidebarOpen ? 'flex md:hidden' : 'flex'} items-center gap-3 px-4 py-3 border-b shrink-0`}
          style={{ borderColor: 'hsl(var(--border))', background: 'hsl(var(--background) / 0.7)', backdropFilter: 'blur(8px)' }}>
          <button onClick={() => setSidebarOpen(s => !s)}
            className="p-2 rounded-xl transition-all hover:bg-white/5"
            style={{ color: 'hsl(var(--muted-foreground))' }}
            aria-label="Toggle sidebar">
            <Menu size={18} />
          </button>
          <div className="w-8 h-8 rounded-xl flex items-center justify-center shadow-sm"
            style={{ background: BRAND_GRADIENT }}>
            <Bot size={15} className="text-white" />
          </div>
          <span className="text-sm font-semibold truncate" style={{ color: 'hsl(var(--foreground))' }}>
            {conversations.find(c => c._id === activeConvoId)?.title || 'Rozare AI Chat'}
          </span>
        </div>

        {/* Chat or Welcome State */}
        {activeConvoId || loadedMessages !== null ? (
          <div className="flex-1 overflow-hidden">
            <ChatBot
              embedded={true}
              dashboardRole={assistantRole}
              conversationId={activeConvoId}
              initialMessages={loadedMessages}
              loadingHistory={loading}
              onConversationCreated={(convoId) => {
                setActiveConvoId(convoId);
                loadConversations();
              }}
            />
          </div>
        ) : (
          /* Welcome state */
          <div className="flex-1 flex items-center justify-center p-6">
            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
              className="text-center max-w-md space-y-6">
              <div className="w-20 h-20 mx-auto rounded-3xl flex items-center justify-center relative"
                style={{ background: BRAND_GRADIENT, boxShadow: '0 8px 30px rgba(14,165,233,0.35)' }}>
                <Bot size={36} className="text-white" />
                <div className="absolute -top-1 -right-1 w-5 h-5 rounded-full flex items-center justify-center"
                  style={{ background: 'hsl(150, 60%, 50%)' }}>
                  <Sparkles size={10} className="text-white" />
                </div>
              </div>
              <div>
                <h2 className="text-2xl font-bold" style={{ color: 'hsl(var(--foreground))' }}>Rozare AI Assistant</h2>
                <p className="text-sm mt-2" style={{ color: 'hsl(var(--muted-foreground))' }}>
                  {welcomeContent.description}
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                {welcomeContent.cards.map((item, i) => (
                  <motion.div key={i} whileHover={{ scale: 1.03 }}
                    className="p-3 rounded-xl text-left cursor-default transition-all"
                    style={{ background: 'hsl(var(--muted) / 0.15)', border: '1px solid hsl(var(--border))' }}>
                    <item.icon size={16} style={{ color: '#0EA5E9' }} />
                    <p className="text-xs font-semibold mt-1.5" style={{ color: 'hsl(var(--foreground))' }}>{item.label}</p>
                    <p className="text-[10px] mt-0.5" style={{ color: 'hsl(var(--muted-foreground))' }}>{item.desc}</p>
                  </motion.div>
                ))}
              </div>
              <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}
                onClick={createNewChat}
                className="px-6 py-3 rounded-xl font-semibold text-white inline-flex items-center gap-2 transition-all"
                style={{ background: BRAND_GRADIENT, boxShadow: '0 4px 15px rgba(14,165,233,0.35)' }}>
                <Plus size={16} /> Start a Conversation
                <ArrowRight size={14} />
              </motion.button>
            </motion.div>
          </div>
        )}
      </div>
    </div>
  );
}

export default AIChatPage;
