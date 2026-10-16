// Shared by the real pages and their initial, no-JavaScript HTML previews.
export const publicSeoPages = [
  {
    key: 'about', path: '/about', title: 'About Rozare', heading: 'Shopping and selling on Rozare',
    description: 'Discover Rozare, an AI-powered marketplace connecting shoppers with independent sellers and brands through storefronts, secure checkout and seller tools.',
    paragraphs: ['Rozare brings product discovery, independent storefronts and order management into one marketplace.', 'Shoppers can compare products, options, seller policies and shipping before checkout. Sellers manage their catalog, orders and customer updates through the dashboard and supported AI and WhatsApp tools.'],
  },
  {
    key: 'contact', path: '/contact', title: 'Contact Rozare Support', heading: 'How can we help?',
    description: 'Contact Rozare for help with orders, payments, returns, warranty claims, seller accounts and marketplace questions. Find support details and policy links.',
    paragraphs: ['For help with a specific order, payment or after-sales request, include the order reference and a clear description of the issue. Never send a card number, CVV, password or verification code.'],
  },
  {
    key: 'faq', path: '/faq', title: 'FAQ — Shopping, Payments and Seller Help', heading: 'Frequently asked questions',
    description: 'Answers about Rozare checkout, saved cards, Wallet refunds, returns, replacements, warranties, seller earnings, deductions and withdrawals.',
    paragraphs: ['Clear answers for shopping and selling on Rozare.'],
  },
  {
    key: 'selling', path: '/become-seller', title: 'Sell on Rozare — Your Store, Products and Seller Tools', heading: 'Build your store on Rozare',
    description: 'Create a Rozare storefront, list products and manage orders with seller dashboards, AI and WhatsApp tools. Review seller plans, payment terms and policies.',
    paragraphs: ['Create your storefront, add accurate product details and options, and set shipping, return and warranty policies for your customers.', 'Manage orders, payouts, promotions and analytics from Seller Dashboard. Plan pricing and any recurring-payment agreement are shown before you subscribe.'],
  },
  {
    key: 'tracking', path: '/track-order', title: 'Track Your Rozare Order', heading: 'Track your order',
    description: 'Look up your Rozare order using your email and order reference to check order progress, shipping updates and seller-provided delivery details.',
    paragraphs: ['Use the email address associated with the order and its order reference to look up its status. Signed-in buyers can also open Your Orders for order details and eligible after-sales requests.'],
  },
  {
    key: 'deletion', path: '/account-deletion', title: 'Delete Your Rozare Account', heading: 'Delete your Rozare account',
    description: 'Learn how to request deletion of your Rozare account or eligible personal data, verify account ownership, and understand which records may be retained.',
    paragraphs: ['Sign in and follow the account-deletion option in Profile settings, or contact privacy@rozare.com from your registered email address to request deletion.', 'Deletion is permanent. Ownership verification may be required, and order, payment, dispute, safety or legally required records may be retained as explained in the Privacy Policy.'],
  },
];

export const publicSeoPage = path => publicSeoPages.find(page => page.path === path);
