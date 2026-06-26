import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { trackMetaPageView, trackTikTokPage } from '../../utils/tiktokPixel';

/**
 * GA4 + GTM analytics. Activates only when env vars are configured.
 *  - VITE_GA_MEASUREMENT_ID  e.g. "G-XXXXXXXXXX"
 *  - VITE_GTM_CONTAINER_ID   e.g. "GTM-XXXXXXX"
 *
 * Tracks SPA route changes as page_view.
 */
const GA_ID = import.meta.env.VITE_GA_MEASUREMENT_ID;
const GTM_ID = import.meta.env.VITE_GTM_CONTAINER_ID;

let injected = false;
function injectScripts() {
  if (injected || typeof document === 'undefined') return;
  injected = true;

  if (GA_ID) {
    const s1 = document.createElement('script');
    s1.async = true;
    s1.src = `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`;
    document.head.appendChild(s1);

    const s2 = document.createElement('script');
    s2.text = `
      window.dataLayer = window.dataLayer || [];
      function gtag(){dataLayer.push(arguments);}
      window.gtag = gtag;
      gtag('js', new Date());
      gtag('config', '${GA_ID}', { send_page_view: false });
    `;
    document.head.appendChild(s2);
  }

  if (GTM_ID) {
    const s = document.createElement('script');
    s.text = `
      (function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start': new Date().getTime(),event:'gtm.js'});
      var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';
      j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
      })(window,document,'script','dataLayer','${GTM_ID}');
    `;
    document.head.appendChild(s);

    const noscript = document.createElement('noscript');
    const iframe = document.createElement('iframe');
    iframe.src = `https://www.googletagmanager.com/ns.html?id=${GTM_ID}`;
    iframe.height = '0';
    iframe.width = '0';
    iframe.style.display = 'none';
    iframe.style.visibility = 'hidden';
    noscript.appendChild(iframe);
    document.body.insertBefore(noscript, document.body.firstChild);
  }
}

export default function Analytics() {
  const location = useLocation();

  useEffect(() => { injectScripts(); }, []);

  useEffect(() => {
    if (!GA_ID || typeof window === 'undefined' || !window.gtag) return;
    window.gtag('event', 'page_view', {
      page_path: location.pathname + location.search,
      page_location: window.location.href,
      page_title: document.title,
      send_to: GA_ID,
    });
  }, [location.pathname, location.search]);

  useEffect(() => {
    trackTikTokPage();
    trackMetaPageView();
  }, [location.pathname, location.search]);

  return null;
}
