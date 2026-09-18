import { useEffect, useRef } from 'react';
import { FlaskConical } from 'lucide-react';
import { SHOW_TEST_PHASE_NOTICE } from '../../config/siteNotice';
import './TestPhaseNotice.css';

export default function TestPhaseNotice() {
  const noticeRef = useRef(null);

  useEffect(() => {
    if (!SHOW_TEST_PHASE_NOTICE || !noticeRef.current) return;

    const root = document.documentElement;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const visibleHeight = Math.max(0, noticeRef.current?.getBoundingClientRect().bottom || 0);
      root.style.setProperty('--test-phase-notice-offset', `${visibleHeight}px`);
    };
    const scheduleMeasure = () => {
      if (!frame) frame = window.requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(noticeRef.current);
    window.addEventListener('scroll', scheduleMeasure, { passive: true });
    window.addEventListener('resize', scheduleMeasure);
    measure();

    return () => {
      observer.disconnect();
      window.removeEventListener('scroll', scheduleMeasure);
      window.removeEventListener('resize', scheduleMeasure);
      window.cancelAnimationFrame(frame);
      root.style.removeProperty('--test-phase-notice-offset');
    };
  }, []);

  if (!SHOW_TEST_PHASE_NOTICE) return null;

  return (
    <aside ref={noticeRef} className="test-phase-notice" aria-labelledby="test-phase-notice-title">
      <div className="test-phase-notice__inner">
        <FlaskConical className="test-phase-notice__icon" size={20} aria-hidden="true" />
        <div className="test-phase-notice__content">
          <p id="test-phase-notice-title" className="test-phase-notice__title">
            Rozare is in its testing phase
          </p>
          <p>
            We are still developing and testing our payment methods and gateways. All data across
            the website is test data; there are no real products or stores yet. You are welcome to
            explore and test the platform. Once development is complete, Rozare will be ready for
            buyers and sellers to use professionally.
          </p>
          <p className="test-phase-notice__deletion">
            All accounts and data you enter during this testing phase will be permanently deleted
            after testing is complete.
          </p>
        </div>
      </div>
    </aside>
  );
}
