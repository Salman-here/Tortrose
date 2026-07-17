import { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { motion, AnimatePresence } from 'framer-motion';
import {
  CheckCircle2,
  Loader2,
  MessageSquare,
  Pencil,
  Star,
  ThumbsUp,
  Trash2,
  X,
} from 'lucide-react';
import { toast } from 'react-toastify';
import { useAuth } from '../../contexts/AuthContext';
import { getAuthToken } from '../../utils/cookieHelper';

const API = `${import.meta.env.VITE_API_URL}api/store-reviews`;
const EMPTY_SUMMARY = {
  average: 0,
  count: 0,
  distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
};

const entityId = (value) => String(value?._id || value?.id || value || '');

const Stars = ({ value = 0, size = 16, interactive = false, onChange }) => (
  <div className="flex items-center gap-1" aria-label={`${value} out of 5 stars`}>
    {[1, 2, 3, 4, 5].map((star) => {
      const icon = (
        <Star
          size={size}
          style={{
            color: star <= Math.round(value) ? 'hsl(45, 93%, 47%)' : 'hsl(var(--muted-foreground))',
            fill: star <= Math.round(value) ? 'hsl(45, 93%, 47%)' : 'none',
          }}
        />
      );
      return interactive ? (
        <button
          type="button"
          key={star}
          onClick={() => onChange(star)}
          className="w-9 h-9 inline-flex items-center justify-center rounded-lg hover:bg-white/10"
          aria-label={`Rate ${star} out of 5`}
        >
          {icon}
        </button>
      ) : <span key={star}>{icon}</span>;
    })}
  </div>
);

const eligibilityMessage = (reason) => {
  if (reason === 'order_not_delivered') return 'You can rate this store after its part of your order is delivered.';
  if (reason === 'not_ordered') return 'Buy from this store and receive the order before leaving a rating.';
  if (reason === 'own_store') return 'Store owners cannot rate their own store.';
  return 'Only buyers with a delivered order from this store can leave a rating.';
};

export default function StoreReviews({ storeId, storeOwnerId, onSummaryChange }) {
  const { currentUser } = useAuth();
  const currentUserId = entityId(currentUser);
  const isStoreOwner = Boolean(currentUserId && currentUserId === entityId(storeOwnerId));
  const [reviews, setReviews] = useState([]);
  const [summary, setSummary] = useState(EMPTY_SUMMARY);
  const [pagination, setPagination] = useState({ skip: 0, limit: 20, hasMore: false });
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [eligibility, setEligibility] = useState(null);
  const [eligibilityLoading, setEligibilityLoading] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({ rating: 5, title: '', comment: '' });
  const [replyingTo, setReplyingTo] = useState('');
  const [replyText, setReplyText] = useState('');

  const myReview = useMemo(() => {
    if (eligibility?.review) return eligibility.review;
    return reviews.find((review) => entityId(review.user) === currentUserId) || null;
  }, [eligibility, reviews, currentUserId]);

  const fetchReviews = useCallback(async ({ append = false } = {}) => {
    if (!storeId) return;
    const skip = append ? reviews.length : 0;
    append ? setLoadingMore(true) : setLoading(true);
    try {
      const response = await axios.get(`${API}/${storeId}`, { params: { limit: 20, skip } });
      const nextReviews = response.data?.reviews || [];
      setReviews((previous) => append ? [...previous, ...nextReviews] : nextReviews);
      setSummary(response.data?.summary || EMPTY_SUMMARY);
      setPagination(response.data?.pagination || { skip, limit: 20, hasMore: false });
    } catch (error) {
      if (!append) toast.error(error.response?.data?.msg || 'Failed to load store ratings.');
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [storeId, reviews.length]);

  const fetchEligibility = useCallback(async () => {
    if (!storeId || !currentUserId || isStoreOwner) {
      setEligibility(isStoreOwner ? { eligible: false, reason: 'own_store', review: null } : null);
      return;
    }
    setEligibilityLoading(true);
    try {
      const response = await axios.get(`${API}/${storeId}/eligibility`, {
        headers: { Authorization: `Bearer ${getAuthToken()}` },
      });
      setEligibility({ ...(response.data?.eligibility || {}), review: response.data?.review || null });
    } catch (error) {
      setEligibility({ eligible: false, reason: 'unavailable', review: null });
      console.error('Failed to load store review eligibility:', error);
    } finally {
      setEligibilityLoading(false);
    }
  }, [storeId, currentUserId, isStoreOwner]);

  useEffect(() => { fetchReviews(); }, [storeId]);
  useEffect(() => { fetchEligibility(); }, [fetchEligibility]);
  useEffect(() => { onSummaryChange?.(summary); }, [summary, onSummaryChange]);

  const openReviewForm = () => {
    if (!currentUserId) {
      toast.info('Log in to rate a store after your order is delivered.');
      return;
    }
    if (!eligibility?.eligible) {
      toast.info(eligibilityMessage(eligibility?.reason));
      return;
    }
    setForm({
      rating: myReview?.rating || 5,
      title: myReview?.title || '',
      comment: myReview?.comment || '',
    });
    setFormOpen(true);
  };

  const submitReview = async (event) => {
    event.preventDefault();
    setSubmitting(true);
    try {
      const response = await axios.post(`${API}/${storeId}`, form, {
        headers: { Authorization: `Bearer ${getAuthToken()}` },
      });
      toast.success(response.data?.msg || 'Store rating saved.');
      setFormOpen(false);
      await Promise.all([fetchReviews(), fetchEligibility()]);
    } catch (error) {
      toast.error(error.response?.data?.msg || 'Failed to save store rating.');
    } finally {
      setSubmitting(false);
    }
  };

  const deleteReview = async (reviewId) => {
    if (!window.confirm('Delete this store review?')) return;
    try {
      await axios.delete(`${API}/${reviewId}`, {
        headers: { Authorization: `Bearer ${getAuthToken()}` },
      });
      toast.success('Store review deleted.');
      await Promise.all([fetchReviews(), fetchEligibility()]);
    } catch (error) {
      toast.error(error.response?.data?.msg || 'Failed to delete review.');
    }
  };

  const toggleHelpful = async (reviewId) => {
    if (!currentUserId) {
      toast.info('Log in to mark a review as helpful.');
      return;
    }
    try {
      const response = await axios.post(`${API}/${reviewId}/helpful`, {}, {
        headers: { Authorization: `Bearer ${getAuthToken()}` },
      });
      setReviews((previous) => previous.map((review) => review._id === reviewId
        ? { ...review, helpfulCount: response.data.helpfulCount }
        : review));
    } catch (error) {
      toast.error(error.response?.data?.msg || 'Failed to update helpful vote.');
    }
  };

  const submitReply = async (reviewId) => {
    const text = replyText.trim();
    if (!text) return;
    try {
      const response = await axios.post(`${API}/${reviewId}/reply`, { text }, {
        headers: { Authorization: `Bearer ${getAuthToken()}` },
      });
      setReviews((previous) => previous.map((review) => review._id === reviewId
        ? { ...review, reply: response.data.review.reply }
        : review));
      setReplyingTo('');
      setReplyText('');
      toast.success('Reply posted.');
    } catch (error) {
      toast.error(error.response?.data?.msg || 'Failed to post reply.');
    }
  };

  const total = summary.count || 0;
  const distribution = summary.distribution || EMPTY_SUMMARY.distribution;

  return (
    <section id="store-reviews" className="mt-10 scroll-mt-24">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 mb-5">
        <div>
          <h2 className="text-xl md:text-2xl font-extrabold" style={{ color: 'hsl(var(--foreground))' }}>Store Ratings</h2>
          <p className="text-sm mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>Ratings from buyers after delivery.</p>
        </div>
        {!isStoreOwner && (
          <button
            type="button"
            onClick={openReviewForm}
            disabled={eligibilityLoading}
            className="glass-button px-4 py-2.5 rounded-xl text-sm font-semibold inline-flex items-center justify-center gap-2 disabled:opacity-60"
          >
            {eligibilityLoading ? <Loader2 size={15} className="animate-spin" /> : myReview ? <Pencil size={15} /> : <Star size={15} />}
            {myReview ? 'Edit Rating' : 'Rate Store'}
          </button>
        )}
      </div>

      <div className="glass-panel p-5 grid sm:grid-cols-[180px_minmax(0,1fr)] gap-5 items-center">
        <div className="text-center sm:border-r sm:pr-5" style={{ borderColor: 'var(--glass-border-subtle)' }}>
          <p className="text-4xl font-extrabold" style={{ color: 'hsl(var(--foreground))' }}>{Number(summary.average || 0).toFixed(1)}</p>
          <div className="flex justify-center mt-2"><Stars value={summary.average} /></div>
          <p className="text-xs mt-2" style={{ color: 'hsl(var(--muted-foreground))' }}>{total} verified {total === 1 ? 'rating' : 'ratings'}</p>
        </div>
        <div className="space-y-2">
          {[5, 4, 3, 2, 1].map((star) => {
            const count = distribution[star] || 0;
            const percentage = total > 0 ? (count / total) * 100 : 0;
            return (
              <div key={star} className="grid grid-cols-[28px_minmax(0,1fr)_28px] items-center gap-2 text-xs">
                <span className="flex items-center gap-1" style={{ color: 'hsl(var(--muted-foreground))' }}>{star}<Star size={10} style={{ color: 'hsl(45,93%,47%)', fill: 'hsl(45,93%,47%)' }} /></span>
                <div className="h-2 rounded-full overflow-hidden" style={{ background: 'rgba(148,163,184,0.18)' }}>
                  <div className="h-full rounded-full" style={{ width: `${percentage}%`, background: 'hsl(45,93%,47%)' }} />
                </div>
                <span className="text-right" style={{ color: 'hsl(var(--muted-foreground))' }}>{count}</span>
              </div>
            );
          })}
        </div>
      </div>

      {!currentUserId && (
        <p className="text-xs mt-3" style={{ color: 'hsl(var(--muted-foreground))' }}>Log in after receiving an order from this store to leave a verified rating.</p>
      )}
      {currentUserId && !isStoreOwner && eligibility && !eligibility.eligible && (
        <p className="text-xs mt-3" style={{ color: 'hsl(var(--muted-foreground))' }}>{eligibilityMessage(eligibility.reason)}</p>
      )}

      <div className="mt-5 space-y-3">
        {loading ? (
          <div className="py-12 flex justify-center"><Loader2 size={24} className="animate-spin" /></div>
        ) : reviews.length === 0 ? (
          <div className="py-12 text-center">
            <MessageSquare size={30} className="mx-auto mb-3" style={{ color: 'hsl(var(--muted-foreground))' }} />
            <p className="font-semibold" style={{ color: 'hsl(var(--foreground))' }}>No verified ratings yet</p>
            <p className="text-sm mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>Delivered-order ratings will appear here.</p>
          </div>
        ) : reviews.map((review) => {
          const mine = entityId(review.user) === currentUserId;
          return (
            <article key={review._id} className="glass-card p-4 sm:p-5">
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-full shrink-0 overflow-hidden flex items-center justify-center font-bold text-white" style={{ background: 'hsl(var(--primary))' }}>
                  {review.user?.avatar ? <img src={review.user.avatar} alt="" className="w-full h-full object-cover" /> : String(review.user?.username || 'B').charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-bold" style={{ color: 'hsl(var(--foreground))' }}>{review.user?.username || 'Buyer'}</p>
                    <span className="tag-pill text-[10px] inline-flex items-center gap-1" style={{ color: 'hsl(150,60%,38%)' }}><CheckCircle2 size={11} /> Verified purchase</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 mt-1">
                    <Stars value={review.rating} size={13} />
                    <span className="text-[11px]" style={{ color: 'hsl(var(--muted-foreground))' }}>{new Date(review.updatedAt || review.createdAt).toLocaleDateString()}</span>
                  </div>
                </div>
                {mine && (
                  <button type="button" onClick={() => deleteReview(review._id)} className="w-8 h-8 rounded-lg inline-flex items-center justify-center" title="Delete review">
                    <Trash2 size={15} style={{ color: 'hsl(0,72%,52%)' }} />
                  </button>
                )}
              </div>
              {review.title && <h3 className="font-bold text-sm mt-3" style={{ color: 'hsl(var(--foreground))' }}>{review.title}</h3>}
              {review.comment && <p className="text-sm leading-relaxed mt-1 whitespace-pre-wrap" style={{ color: 'hsl(var(--muted-foreground))' }}>{review.comment}</p>}
              {review.reply?.text && (
                <div className="mt-4 pl-4 py-3 border-l-2" style={{ borderColor: 'hsl(var(--primary))' }}>
                  <p className="text-xs font-bold" style={{ color: 'hsl(var(--primary))' }}>Store response</p>
                  <p className="text-sm mt-1 whitespace-pre-wrap" style={{ color: 'hsl(var(--muted-foreground))' }}>{review.reply.text}</p>
                </div>
              )}
              {replyingTo === review._id && (
                <div className="mt-4 flex flex-col sm:flex-row gap-2">
                  <textarea value={replyText} onChange={(event) => setReplyText(event.target.value)} maxLength={1000} rows={2} className="glass-input flex-1 resize-none" placeholder="Reply as the store owner" />
                  <button type="button" onClick={() => submitReply(review._id)} className="glass-button px-4 py-2 rounded-xl text-sm font-semibold">Post Reply</button>
                </div>
              )}
              <div className="mt-4 flex items-center gap-4">
                <button type="button" onClick={() => toggleHelpful(review._id)} className="text-xs inline-flex items-center gap-1.5" style={{ color: 'hsl(var(--muted-foreground))' }}><ThumbsUp size={13} /> Helpful ({review.helpfulCount || 0})</button>
                {isStoreOwner && replyingTo !== review._id && <button type="button" onClick={() => { setReplyingTo(review._id); setReplyText(review.reply?.text || ''); }} className="text-xs inline-flex items-center gap-1.5" style={{ color: 'hsl(var(--primary))' }}><MessageSquare size={13} /> {review.reply?.text ? 'Edit Reply' : 'Reply'}</button>}
              </div>
            </article>
          );
        })}
      </div>

      {pagination.hasMore && (
        <div className="mt-4 text-center">
          <button type="button" onClick={() => fetchReviews({ append: true })} disabled={loadingMore} className="glass-button px-4 py-2 rounded-xl text-sm font-semibold inline-flex items-center gap-2 disabled:opacity-60">
            {loadingMore && <Loader2 size={14} className="animate-spin" />} Load More Ratings
          </button>
        </div>
      )}

      <AnimatePresence>
        {formOpen && (
          <motion.div className="fixed inset-0 z-[100] bg-black/45 backdrop-blur-sm flex items-center justify-center p-4" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(event) => { if (event.target === event.currentTarget) setFormOpen(false); }}>
            <motion.form onSubmit={submitReview} className="glass-panel-strong p-5 sm:p-6 w-full max-w-lg" initial={{ opacity: 0, scale: 0.96, y: 12 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.96, y: 12 }}>
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-lg font-extrabold" style={{ color: 'hsl(var(--foreground))' }}>{myReview ? 'Edit Store Rating' : 'Rate This Store'}</h2>
                <button type="button" onClick={() => setFormOpen(false)} className="w-9 h-9 rounded-lg inline-flex items-center justify-center" aria-label="Close"><X size={18} /></button>
              </div>
              <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>Your rating is marked as a verified purchase.</p>
              <div className="mt-5 flex justify-center"><Stars value={form.rating} size={25} interactive onChange={(rating) => setForm((previous) => ({ ...previous, rating }))} /></div>
              <label className="block text-xs font-semibold mt-5 mb-2">Title (optional)</label>
              <input value={form.title} onChange={(event) => setForm((previous) => ({ ...previous, title: event.target.value }))} maxLength={100} className="glass-input w-full" placeholder="Summarize your experience" />
              <label className="block text-xs font-semibold mt-4 mb-2">Review (optional)</label>
              <textarea value={form.comment} onChange={(event) => setForm((previous) => ({ ...previous, comment: event.target.value }))} maxLength={1000} rows={5} className="glass-input w-full resize-none" placeholder="Tell other buyers about this store" />
              <p className="text-[10px] text-right mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>{form.comment.length}/1000</p>
              <button type="submit" disabled={submitting} className="mt-5 w-full px-4 py-2.5 rounded-xl text-sm font-semibold text-white inline-flex items-center justify-center gap-2 disabled:opacity-60" style={{ background: 'hsl(var(--primary))' }}>
                {submitting ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle2 size={16} />} {myReview ? 'Update Rating' : 'Submit Rating'}
              </button>
            </motion.form>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
