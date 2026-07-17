/**
 * AI Chat Controller
 * ─────────────────────
 * Handles the streaming AI chat for Rozare platform.
 * Uses OpenRouter API (https://openrouter.ai) to access any model.
 *
 * Key responsibilities:
 *  1. Role-based system prompts (user / seller / admin)
 *  2. Role-based tool (function) exposure + strict server-side validation
 *  3. Deep personalization via live context injection
 *  4. Streaming Server-Sent Events (SSE) response to the client
 *  5. Security: the AI NEVER performs actions directly — it returns tool calls
 *     which the frontend executes against our own `/api/ai-actions/*` routes,
 *     which re-validate the caller's role on the server.
 */

const User = require('../models/User');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Store = require('../models/Store');
const ChatHistory = require('../models/ChatHistory');
const { executeToolCall, isClientSideTool, storeChangeLimits } = require('../services/aiActionExecutor');
const { publicProductFilter } = require('../services/productModerationService');
const { processChatAttachments, appendAttachmentContextToMessages } = require('../services/aiAttachmentService');
const { formatMoneySync } = require('../services/currencyService');
const { getProductCurrency } = require('../services/productPricingService');
const { isProductSellerPubliclyActive } = require('../services/publicCatalogService');

// ─── OpenRouter Config ───────────────────────────────────────────────
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const AI_MODEL = process.env.AI_MODEL || 'google/gemini-2.5-flash';
const AI_FALLBACK_MODEL = process.env.AI_FALLBACK_MODEL || 'google/gemini-flash-1.5';
const SITE_URL = process.env.FRONTEND_URL || 'https://www.rozare.com';
const SITE_NAME = 'Rozare';
const PRODUCT_IMAGE_ATTACHMENT_RE = /\n?\[Attached product image: (https?:\/\/[^\]\s]+)\]/gi;
const AI_REQUEST_TIMEOUT_MS = Number(process.env.AI_REQUEST_TIMEOUT_MS || 60000);
const WHATSAPP_AI_REQUEST_TIMEOUT_MS = Number(process.env.WHATSAPP_AI_REQUEST_TIMEOUT_MS || 35000);

function extractImageAttachments(content = '', explicit = []) {
  const seen = new Set();
  const attachments = [];
  const add = (attachment) => {
    const url = attachment?.url || attachment?.imageUrl || attachment?.src;
    if (!url || !/^https?:\/\//i.test(url)) return;
    const key = String(url).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    attachments.push({ type: 'image', url, name: attachment?.name || 'Product image' });
  };

  if (Array.isArray(explicit)) explicit.forEach(add);
  const text = String(content || '');
  for (const match of text.matchAll(PRODUCT_IMAGE_ATTACHMENT_RE)) {
    add({ url: match[1], name: 'Product image' });
  }
  return attachments;
}

function stripAttachmentMetadata(content = '') {
  return String(content || '').replace(PRODUCT_IMAGE_ATTACHMENT_RE, '').trim();
}

function parseMaybeJson(value, fallback) {
  if (typeof value !== 'string') return value ?? fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function getIncomingMessagesFromRequest(req) {
  const body = req.body || {};
  const parsedMessages = parseMaybeJson(body.messages, body.messages);
  let incoming = Array.isArray(parsedMessages) ? parsedMessages : [];

  const bodyAttachments = parseMaybeJson(body.attachments, body.attachments);
  const uploadAttachments = Array.isArray(req.files)
    ? req.files.map(file => ({
      ...file,
      name: file.originalname,
      filename: file.originalname,
      type: file.mimetype,
    }))
    : [];
  const explicitAttachments = Array.isArray(bodyAttachments) ? bodyAttachments : [];

  if (uploadAttachments.length || explicitAttachments.length) {
    const attachmentResult = await processChatAttachments([...uploadAttachments, ...explicitAttachments]);
    incoming = appendAttachmentContextToMessages(incoming, attachmentResult);
  }

  return incoming;
}

// ─── SYSTEM PROMPTS ──────────────────────────────────────────────────
// These are crafted for warmth, expertise, and personal connection.
// Each prompt is role-scoped and explicitly lists forbidden cross-role actions.

const {
  USER_PROMPT,
  SELLER_PROMPT,
  ADMIN_PROMPT,
  LANGUAGE_STYLE_ADDENDUM,
  TOOL_MEMORY_ADDENDUM,
  COMMERCE_POLICY_ADDENDUM,
  WHATSAPP_SYSTEM_PROMPT_ADDENDUM,
} = require('../services/aiPrompts/defaultPrompts');
const aiPromptService = require('../services/aiPromptService');



// ─── TOOLS BY ROLE ───────────────────────────────────────────────────

const SHARED_NAVIGATION_TOOL = {
  type: 'function',
  function: {
    name: 'navigate',
    description: 'Navigate the user to a page in the application.',
    parameters: {
      type: 'object',
      properties: {
        route: { type: 'string', description: 'Route path e.g. /profile, /cart' },
        label: { type: 'string', description: 'Human-readable label for what page this is' },
      },
      required: ['route', 'label'],
    },
  },
};

const userTools = [
  {
    type: 'function',
    function: {
      name: 'search_products',
      description: 'Search for products in the Rozare catalog. Supports partial names, keywords, common typos, and fuzzy matching.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query (product name, partial name, keyword, description, or typo-tolerant phrase)' },
          category: { type: 'string', description: 'Category filter (optional)' },
          maxPrice: { type: 'number', description: 'Maximum price (optional)' },
          minPrice: { type: 'number', description: 'Minimum price (optional)' },
          brand: { type: 'string', description: 'Brand filter (optional)' },
          storeId: { type: 'string', description: 'Internal store ID to scope results to a store (optional)' },
          storeSlug: { type: 'string', description: 'Store slug/subdomain to scope results to a store (optional)' },
          storeName: { type: 'string', description: 'Store or brand/storefront name to scope results to a store (optional)' },
          inStockOnly: { type: 'boolean', description: 'Set true when the user is actively shopping or ordering and wants available items only.' },
          sortBy: { type: 'string', enum: ['price_low', 'price_high', 'popular', 'newest', 'best_rated', 'trending'] },
          limit: { type: 'number', description: 'Maximum products to return' },
        },
      },
    },
  },
  SHARED_NAVIGATION_TOOL,
  {
    type: 'function',
    function: {
      name: 'show_style_advice',
      description: 'Display rich, styled fashion advice with a color palette to the user.',
      parameters: {
        type: 'object',
        properties: {
          advice: { type: 'string', description: 'The core style advice' },
          occasion: { type: 'string', description: 'Occasion this is for' },
          colorPalette: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                color: { type: 'string', description: 'Hex color or CSS color' },
                name: { type: 'string', description: 'Name of the color' },
              },
              required: ['color', 'name'],
            },
          },
          tips: { type: 'array', items: { type: 'string' } },
        },
        required: ['advice', 'occasion'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'suggest_outfit',
      description: 'Suggest a complete outfit combination for an occasion.',
      parameters: {
        type: 'object',
        properties: {
          occasion: { type: 'string' },
          pieces: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', description: 'e.g. "Top", "Bottom", "Shoes", "Accessory"' },
                description: { type: 'string' },
                color: { type: 'string', description: 'Hex or CSS color' },
                searchQuery: { type: 'string', description: 'Query to find this piece in store' },
              },
              required: ['type', 'description', 'color'],
            },
          },
          reasoning: { type: 'string' },
        },
        required: ['occasion', 'pieces', 'reasoning'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_my_orders',
      description: "Get the user's own order history.",
      parameters: {
        type: 'object',
        properties: { status: { type: 'string', description: 'Optional status filter' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_order_detail',
      description: 'Get full details of a specific order.',
      parameters: {
        type: 'object',
        properties: { orderId: { type: 'string', description: 'MongoDB _id of the order' } },
        required: ['orderId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_order',
      description: "Cancel a pending order (user's own only).",
      parameters: {
        type: 'object',
        properties: { orderId: { type: 'string', description: 'MongoDB _id of the order' } },
        required: ['orderId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'submit_complaint',
      description: 'Submit a complaint on behalf of the user.',
      parameters: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            enum: ['product_issue', 'order_issue', 'delivery', 'refund', 'seller_complaint', 'website_bug', 'suggestion', 'other'],
          },
          subject: { type: 'string' },
          message: { type: 'string' },
        },
        required: ['category', 'subject', 'message'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_my_complaints',
      description: "Get the user's own complaint history.",
      parameters: { type: 'object', properties: {} },
    },
  },
  // ─── NEW USER TOOLS ───
  {
    type: 'function',
    function: {
      name: 'get_wishlist',
      description: "Get all items in the user's wishlist.",
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_to_wishlist',
      description: "Add a product to the user's wishlist.",
      parameters: {
        type: 'object',
        properties: { productId: { type: 'string' } },
        required: ['productId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remove_from_wishlist',
      description: "Remove a product from the user's wishlist.",
      parameters: {
        type: 'object',
        properties: { productId: { type: 'string' } },
        required: ['productId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_addresses',
      description: "Get the user's saved shipping addresses.",
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_address',
      description: "Add a new shipping address to the user's saved addresses.",
      parameters: {
        type: 'object',
        properties: {
          address: {
            type: 'object',
            description: 'Address object with fullName, address, city, state, postalCode, country, phone',
          },
        },
        required: ['address'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_profile',
      description: "Update the user's own profile (username only).",
      parameters: {
        type: 'object',
        properties: {
          updates: { type: 'object', description: 'Object with fields to update (e.g. { username: "NewName" })' },
        },
        required: ['updates'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_notifications',
      description: "Get the user's recent notifications.",
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mark_notifications_read',
      description: 'Mark all notifications as read for the current user.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_available_coupons',
      description: 'List currently available active coupons (optionally for a specific store).',
      parameters: {
        type: 'object',
        properties: {
          storeId: { type: 'string', description: 'Optional seller/store id to filter coupons' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'validate_coupon',
      description: 'Validate a coupon code against a cart total to check savings.',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          cartTotal: { type: 'number' },
        },
        required: ['code', 'cartTotal'],
      },
    },
  },
  // ─── CART & ORDER TOOLS ───
  {
    type: 'function',
    function: {
      name: 'get_verified_stores',
      description: 'List verified public stores that shoppers can browse.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_stores',
      description: 'Search public stores by store name, slug, or description.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Store name, brand, product type, or product keyword' },
          category: { type: 'string', description: 'Optional product category to match stores by inventory' },
          brand: { type: 'string', description: 'Optional product brand to match stores by inventory' },
          limit: { type: 'number' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_store_details',
      description: 'Get public details for a store by ID or slug.',
      parameters: {
        type: 'object',
        properties: {
          storeId: { type: 'string' },
          slug: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_product_detail',
      description: 'Get full details of a specific product by its ID (price, description, stock, colors, options, reviews).',
      parameters: {
        type: 'object',
        properties: { productId: { type: 'string', description: 'Product ID' } },
        required: ['productId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_my_profile',
      description: 'Get the current user\'s full profile details (name, email, addresses, wishlist count).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_to_cart',
      description: 'Add a product to the user\'s shopping cart.',
      parameters: {
        type: 'object',
        properties: {
          productId: { type: 'string', description: 'Product ID to add' },
          quantity: { type: 'number', description: 'Quantity to add. Default 1.' },
          selectedColor: { type: 'string', description: 'Optional color choice' },
          selectedOptions: {
            type: 'object',
            description: 'Required product options, e.g. {"Size":"M","Color":"Red"}. Ask the user before choosing options.',
          },
        },
        required: ['productId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'view_cart',
      description: 'View all items currently in the user\'s shopping cart with prices and totals.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remove_from_cart',
      description: 'Remove a product from the user\'s cart.',
      parameters: {
        type: 'object',
        properties: { productId: { type: 'string' } },
        required: ['productId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'clear_cart',
      description: 'Remove all items from the user\'s cart.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_product_image',
      description: 'Send a product image to the user on WhatsApp. Only use this when the user explicitly asks to see a product image. Do NOT send images automatically when listing products.',
      parameters: {
        type: 'object',
        properties: {
          productId: { type: 'string', description: 'Product ID to send image for' },
          caption: { type: 'string', description: 'Optional caption to include with the image' },
        },
        required: ['productId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'place_order',
      description: 'Place a Cash-on-Delivery order when COD is allowed. Can order a specific product by ID or checkout the entire cart. Uses the user\'s saved address if available, otherwise requires shipping info. Stripe card and Rozare Wallet are completed securely at /checkout. If any seller accepts online payment only, use /checkout instead.',
      parameters: {
        type: 'object',
        properties: {
          productId: { type: 'string', description: 'Optional: specific product ID to order. If omitted, orders entire cart.' },
          quantity: { type: 'number', description: 'Quantity for a direct product order. Default 1.' },
          selectedColor: { type: 'string', description: 'Color choice for a direct product order when applicable.' },
          selectedOptions: {
            type: 'object',
            description: 'Required product options for direct order, e.g. {"Size":"M","Color":"Red"}.',
          },
          shippingInfo: {
            type: 'object',
            description: 'Shipping address. If not provided, uses saved address. Required fields: fullName, email, phone, address, city, state, postalCode, country.',
          },
          paymentMethod: { type: 'string', enum: ['cash_on_delivery', 'stripe'], description: 'Use cash_on_delivery for chat orders. Stripe card and Rozare Wallet require secure /checkout instead of a chat order.' },
        },
      },
    },
  },
];

const sellerTools = [
  ...userTools,
  {
    type: 'function',
    function: {
      name: 'add_product',
      description: "Add a new product to the seller's store. Supports tags, colors, optionGroups, image URL(s), return policy, and improved descriptions. REQUIRED: name, price, category, brand, stock. Ask for any missing fields.",
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Clean product name only. No labels, markdown, or headings.' },
          price: { type: 'number', description: 'Numeric product price in the provided currency or seller preferred currency.' },
          currency: { type: 'string', description: 'ISO currency for price when explicit or from context, e.g. PKR, USD, EUR, GBP.' },
          description: { type: 'string', description: 'Plain product description only. No markdown heading, stars, or field labels.' },
          category: { type: 'string', description: 'Clean category name only.' },
          brand: { type: 'string', description: 'Clean brand name only.' },
          stock: { type: 'number' },
          image: { type: 'string', description: 'Primary product image URL from an upload, pasted URL, or hidden [Attached product image: URL] metadata.' },
          images: {
            type: 'array',
            description: 'Additional product image URLs.',
            items: { type: 'string' },
          },
          discountedPrice: { type: 'number', description: 'Optional numeric discounted price in the same currency unless discountedCurrency is provided.' },
          discountedCurrency: { type: 'string', description: 'Optional ISO currency for discountedPrice.' },
          tags: { type: 'array', items: { type: 'string' } },
          colors: { type: 'array', items: { type: 'string' }, description: 'Color choices such as red, yellow, black.' },
          optionGroups: {
            type: 'array',
            description: 'Seller-defined variants/options, e.g. [{name:"Size", values:["S","M","L"], default:"M"}].',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                values: { type: 'array', items: { type: 'string' } },
                default: { type: 'string' },
              },
              required: ['name', 'values'],
            },
          },
          returnPolicy: { type: 'object', description: 'Optional product-specific return/warranty policy. If omitted, product inherits the store policy.' },
          isFeatured: { type: 'boolean', description: 'Whether to feature this product immediately, subject to seller plan limits.' },
          confirmDuplicate: { type: 'boolean', description: 'Only true when the seller explicitly confirms they intentionally want to create a duplicate listing.' },
          sellerId: { type: 'string', description: 'Admin only: seller user id to create this product under' },
        },
        required: ['name', 'price', 'category', 'brand', 'stock'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_product',
      description: "Edit one of the seller's own products. Supports description, price, stock, image URL(s), tags, colors, optionGroups, return policy, and isFeatured. Use the recent productId from successful add_product/list results for follow-up edits. Product IDs are internal; do not ask sellers for IDs.",
      parameters: {
        type: 'object',
        properties: {
          productId: { type: 'string', description: 'Preferred. Product ID from a previous add/list/search result.' },
          productName: { type: 'string', description: 'Fallback only when productId is not available. Can be a partial, misspelled, or fuzzy product name; the tool will search the seller inventory.' },
          sellerId: { type: 'string', description: 'Admin only: restrict update to this seller.' },
          updates: {
            type: 'object',
            description: 'Fields to update: name, description, price, discountedPrice, category, brand, stock, image/imageUrl, images, tags, colors, optionGroups, returnPolicy, isFeatured.',
          },
        },
        required: ['updates'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_product',
      description: "Delete one or more of the seller's own products. Confirm first. Prefer productName/productNames or internal IDs from list_my_products; never ask the seller to provide product IDs.",
      parameters: {
        type: 'object',
        properties: {
          productId: { type: 'string', description: 'Internal product id from prior tool results. Do not ask seller for this.' },
          productIds: { type: 'array', items: { type: 'string' }, description: 'Internal product ids from prior tool results for bulk deletion.' },
          productName: { type: 'string', description: 'Exact or close product name to delete.' },
          productNames: { type: 'array', items: { type: 'string' }, description: 'Product names to delete.' },
          keepProductId: { type: 'string', description: 'Internal id to keep when deleting duplicates.' },
          excludeProductId: { type: 'string', description: 'Internal id to exclude from deletion.' },
          deleteAllMatches: { type: 'boolean', description: 'True only after seller confirms all matching products should be deleted.' },
          sellerId: { type: 'string', description: 'Admin only: restrict deletion to this seller.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bulk_add_products',
      description: "Import multiple products into the seller's store from structured data such as CSV, JSON, spreadsheets, or pasted rows. Each product must include name, price, category, brand, and stock. Supports currency, description, image(s), tags, colors, optionGroups, discounts, and return policy.",
      parameters: {
        type: 'object',
        properties: {
          products: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                price: { type: 'number' },
                currency: { type: 'string', description: 'ISO currency for this row when explicit or inferred from the file/context.' },
                description: { type: 'string' },
                category: { type: 'string' },
                brand: { type: 'string' },
                stock: { type: 'number' },
                image: { type: 'string' },
                images: { type: 'array', items: { type: 'string' } },
                discountedPrice: { type: 'number' },
                discountedCurrency: { type: 'string' },
                tags: { type: 'array', items: { type: 'string' } },
                colors: { type: 'array', items: { type: 'string' } },
                optionGroups: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      name: { type: 'string' },
                      values: { type: 'array', items: { type: 'string' } },
                      default: { type: 'string' },
                    },
                  },
                },
                returnPolicy: { type: 'object' },
              },
              required: ['name', 'price', 'category', 'brand', 'stock'],
            },
          },
          currency: { type: 'string', description: 'Default import currency if rows omit one and the seller message/file specifies it.' },
          confirmDuplicate: { type: 'boolean', description: 'Only true when the seller explicitly confirms duplicate listings are intentional.' },
          sellerId: { type: 'string', description: 'Admin only: seller user id to import products under.' },
        },
        required: ['products'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'feature_product',
      description: "Feature or unfeature one of the seller's own products on the homepage/store. Use recent productId if available, otherwise productName. Do not ask seller for product IDs.",
      parameters: {
        type: 'object',
        properties: {
          productId: { type: 'string', description: 'Internal product id from prior tool results. Do not ask seller for this.' },
          productName: { type: 'string', description: 'Exact or close product name to feature/unfeature.' },
          featured: { type: 'boolean', description: 'true to feature, false to unfeature. Defaults to true.' },
          sellerId: { type: 'string', description: 'Admin only: restrict to this seller.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_my_products',
      description: "List the seller's products with optional filtering.",
      parameters: {
        type: 'object',
        properties: {
          search: { type: 'string' },
          category: { type: 'string' },
          limit: { type: 'number' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bulk_discount',
      description: "Apply a discount to multiple of the seller's own products.",
      parameters: {
        type: 'object',
        properties: {
          productIds: { type: 'array', items: { type: 'string' } },
          discountType: { type: 'string', enum: ['percentage', 'fixed'] },
          discountValue: { type: 'number' },
        },
        required: ['productIds', 'discountType', 'discountValue'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bulk_price_update',
      description: "Update prices on multiple of the seller's own products.",
      parameters: {
        type: 'object',
        properties: {
          productIds: { type: 'array', items: { type: 'string' } },
          updateType: { type: 'string', enum: ['percentage', 'fixed', 'set'] },
          value: { type: 'number' },
        },
        required: ['productIds', 'updateType', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remove_discount',
      description: "Remove discounts from the seller's own products.",
      parameters: {
        type: 'object',
        properties: { productIds: { type: 'array', items: { type: 'string' } } },
        required: ['productIds'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_seller_analytics',
      description: "Get the seller's business analytics: revenue, orders, top products, stock alerts.",
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_seller_payments',
      description: "Get the seller's payment summary: Stripe withdrawable balance, COD revenue, estimated revenue, payment account status, and recent withdrawal requests.",
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_seller_orders',
      description: "Get orders that contain the seller's products.",
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          limit: { type: 'number' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_order_status',
      description: "Update status of an order containing the seller's product (confirmed/processing/shipped/delivered; sellers can't cancel). Use orderId from get_seller_orders results.",
      parameters: {
        type: 'object',
        properties: {
          orderId: { type: 'string' },
          newStatus: { type: 'string', enum: ['confirmed', 'processing', 'shipped', 'delivered'] },
        },
        required: ['orderId', 'newStatus'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_my_store',
      description: "Get the seller's own store details.",
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_store',
      description: "Update seller's own store settings. Only call when the seller gives a clear instruction and the new value. For questions like 'can I change my store name?', use get_my_store first and answer from cooldown data. Store name cooldown is 7 days; subdomain cooldown is 30 days.",
      parameters: {
        type: 'object',
        properties: {
          updates: {
            type: 'object',
            description: 'Fields: storeName, storeSlug, description, logo, banner, socialLinks, returnPolicy, address, sellerType, paymentPolicy, confirmSubdomainChange. paymentPolicy values: online_and_cod for online payment plus Cash on Delivery, advance_only for Stripe card or Rozare Wallet only. returnPolicy is an object with returnsEnabled, returnDuration (1-365 days when enabled), refundType (full_refund, store_credit, or replacement_only), policyDescription, warrantyEnabled, warrantyDuration, and warrantyDescription. full_refund and store_credit both credit the approved refund to Rozare Wallet after seller funding. Store text fields must be clean plain values only: no markdown stars, headings, labels, copied form labels, or placeholders.',
          },
        },
        required: ['updates'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_store_analytics',
      description: "Get the seller's store performance metrics.",
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'apply_for_verification',
      description: "Submit a verification application for seller's store.",
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_shipping_methods',
      description: "View the seller's shipping methods.",
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_shipping',
      description: "Update one of the seller's shipping methods.",
      parameters: {
        type: 'object',
        properties: {
          method: { type: 'string', enum: ['free', 'standard', 'fast'] },
          cost: { type: 'number' },
          deliveryDays: { type: 'number' },
          isActive: { type: 'boolean' },
        },
        required: ['method'],
      },
    },
  },
  // ─── SELLER COUPON TOOLS ───
  {
    type: 'function',
    function: {
      name: 'create_coupon',
      description: "Create a new discount coupon for the seller's store. If the seller gives only an offer like '10% off' or '500 off', generate a professional code and default the expiry to 30 days unless they specify otherwise.",
      parameters: {
        type: 'object',
        properties: {
          coupon: {
            type: 'object',
            description: 'Coupon: { code?, discountType? ("percentage"|"fixed"), discountValue? or discountPercent? or fixedAmount?, minOrderAmount?, maxUses?, maxUsesPerUser?, expiryDate?, maxDiscountAmount?, applicableTo?, applicableProducts?, description? }',
          },
        },
        required: ['coupon'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_my_coupons',
      description: "List the seller's own coupons.",
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_coupon',
      description: "Update one of the seller's own coupons. Prefer couponCode when the seller names a coupon; use couponId only when already known from tool results.",
      parameters: {
        type: 'object',
        properties: {
          couponId: { type: 'string' },
          couponCode: { type: 'string' },
          updates: { type: 'object' },
        },
        required: ['updates'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_coupon',
      description: "Delete one of the seller's own coupons. Confirm first. Prefer couponCode when the seller names a coupon; use couponId only when already known from tool results.",
      parameters: {
        type: 'object',
        properties: { couponId: { type: 'string' }, couponCode: { type: 'string' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'toggle_coupon',
      description: "Toggle active/inactive state of one of seller's coupons. Prefer couponCode when the seller names a coupon; use couponId only when already known from tool results.",
      parameters: {
        type: 'object',
        properties: { couponId: { type: 'string' }, couponCode: { type: 'string' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_seller_ads_status',
      description: "Check whether the seller can run Rozare ads, list active featured products available for ads, and show pending/active ads requests. Call before submitting or explaining current ads status.",
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'submit_seller_ads_request',
      description: "Submit a seller ads request for admin approval. Only Elite sellers can submit. TikTok ads are included with Elite; Meta ads require the Meta ads add-on. Products must be active featured products from get_seller_ads_status.",
      parameters: {
        type: 'object',
        properties: {
          requestType: { type: 'string', enum: ['start', 'update', 'stop'], description: 'start a campaign, update advertised products, or stop the active campaign.' },
          productIds: { type: 'array', items: { type: 'string' }, description: 'Internal featured product ids from get_seller_ads_status. Do not ask the seller to provide IDs.' },
          productNames: { type: 'array', items: { type: 'string' }, description: 'Featured product names to match when ids are not available.' },
          selectAllFeatured: { type: 'boolean', description: 'True when the seller asks to run ads on all active featured products.' },
          includeMeta: { type: 'boolean', description: 'True only if the seller requests Meta ads and has the Meta ads add-on.' },
          sellerNote: { type: 'string', description: 'Optional short note for admin review.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_subscription_status',
      description: "Get the seller's current subscription plan and status.",
      parameters: { type: 'object', properties: {} },
    },
  },
];

const adminTools = [
  ...sellerTools,
  {
    type: 'function',
    function: {
      name: 'get_all_users',
      description: 'List/search all users on the platform.',
      parameters: {
        type: 'object',
        properties: {
          search: { type: 'string' },
          role: { type: 'string' },
          status: { type: 'string' },
          limit: { type: 'number' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_user',
      description: 'Delete a user. This is permanent. Confirm with admin first.',
      parameters: {
        type: 'object',
        properties: { userId: { type: 'string' } },
        required: ['userId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'block_user',
      description: 'Toggle block/unblock for a user.',
      parameters: {
        type: 'object',
        properties: {
          userId: { type: 'string' },
          blocked: { type: 'boolean', description: 'true to block, false to unblock' },
        },
        required: ['userId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'change_user_role',
      description: "Change a user's role.",
      parameters: {
        type: 'object',
        properties: {
          userId: { type: 'string' },
          newRole: { type: 'string', enum: ['user', 'seller', 'admin'] },
        },
        required: ['userId', 'newRole'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_admin_analytics',
      description: 'Get platform-wide analytics.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_all_orders',
      description: 'List all orders across the platform.',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          limit: { type: 'number' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_all_complaints',
      description: 'List all complaints platform-wide.',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string' },
          status: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_complaint',
      description: 'Respond to, resolve, escalate or reprioritize a complaint.',
      parameters: {
        type: 'object',
        properties: {
          complaintId: { type: 'string' },
          status: { type: 'string' },
          adminResponse: { type: 'string' },
          priority: { type: 'string' },
        },
        required: ['complaintId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_pending_verifications',
      description: 'List stores awaiting verification.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'approve_verification',
      description: "Approve a store's verification application.",
      parameters: {
        type: 'object',
        properties: { storeId: { type: 'string' } },
        required: ['storeId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'reject_verification',
      description: "Reject a store's verification application.",
      parameters: {
        type: 'object',
        properties: {
          storeId: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['storeId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remove_verification',
      description: "Revoke a store's verified badge.",
      parameters: {
        type: 'object',
        properties: { storeId: { type: 'string' } },
        required: ['storeId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_all_stores',
      description: 'List all stores on the platform.',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'number' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_tax_config',
      description: 'Update platform tax configuration.',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['none', 'percentage', 'fixed'] },
          value: { type: 'number' },
          isActive: { type: 'boolean' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_tax_config',
      description: 'View platform tax configuration.',
      parameters: { type: 'object', properties: {} },
    },
  },
  // ─── ADMIN BROADCAST + SUBSCRIPTION TOOLS ───
  {
    type: 'function',
    function: {
      name: 'send_broadcast',
      description: 'Send/schedule a broadcast notification to all users or a targeted audience.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          message: { type: 'string' },
          body: { type: 'string' },
          audience: {
            type: 'string',
            enum: ['all_users', 'all_sellers', 'both', 'specific'],
            description: 'Audience target. Use all_users, all_sellers, both, or specific. Legacy object { target, userIds } is also accepted.',
          },
          userIds: { type: 'array', items: { type: 'string' } },
          channels: { type: 'array', items: { type: 'string', enum: ['inapp', 'push', 'email', 'whatsapp'] } },
          scheduleType: { type: 'string', enum: ['immediate', 'one_time', 'recurring'] },
          scheduledAt: { type: 'string', description: 'ISO datetime string; omit for immediate' },
        },
        required: ['title', 'message'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_broadcasts',
      description: 'List recent/scheduled broadcasts.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_broadcast',
      description: 'Cancel a scheduled broadcast that has not yet been sent.',
      parameters: {
        type: 'object',
        properties: { broadcastId: { type: 'string' } },
        required: ['broadcastId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_all_subscriptions',
      description: 'View all seller subscriptions and their statuses.',
      parameters: { type: 'object', properties: {} },
    },
  },
];

// ─── Helpers ─────────────────────────────────────────────────────────

// ─── Minimal grammar addendum ───
// Keeps the original assistant behavior/tool usage intact while avoiding
// masculine first-person wording in gendered languages.


function splitInternalAssistantContent(content = '') {
  const visibleLines = [];
  const internalLines = [];

  String(content || '').split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim().replace(/^_+|_+$/g, '');
    if (trimmed.includes('[Tool memory:') || /^Action note:/i.test(trimmed)) {
      internalLines.push(trimmed);
      return;
    }
    visibleLines.push(line);
  });

  return {
    visible: visibleLines.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    internal: internalLines.join('\n'),
  };
}

function sanitizeAssistantVisibleText(text = '') {
  return splitInternalAssistantContent(text).visible;
}

function prepareIncomingChatMessages(incomingMessages = []) {
  const cleanMessages = [];
  const internalBlocks = [];

  for (const message of incomingMessages || []) {
    if (!message || typeof message.role !== 'string') continue;
    const rawContent = typeof message.content === 'string'
      ? message.content
      : JSON.stringify(message.content ?? '');
    const { visible, internal } = splitInternalAssistantContent(rawContent);
    if (internal) internalBlocks.push(internal);

    const nextMessage = {
      role: message.role,
      content: visible,
      ...(Array.isArray(message.attachments) ? { attachments: message.attachments } : {}),
      ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
      ...(message.name ? { name: message.name } : {}),
      ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
    };

    if (
      nextMessage.content ||
      nextMessage.attachments ||
      nextMessage.tool_call_id ||
      nextMessage.tool_calls
    ) {
      cleanMessages.push(nextMessage);
    }
  }

  const memoryMessage = internalBlocks.length
    ? {
        role: 'system',
        content: [
          '## Internal tool memory for follow-up actions',
          'Use this only to resolve product/store/order references in tool calls.',
          'Never quote, summarize, expose, or mention this memory to the user.',
          internalBlocks.slice(-20).join('\n'),
        ].join('\n'),
      }
    : null;

  return { cleanMessages, memoryMessage };
}

// Assembles persona + addendums + admin-maintained knowledge prompts through
// aiPromptService, so dashboard edits apply live (no deploy). Falls back to
// the code defaults if the prompt store is unreachable.
async function getSystemPrompt(role, channel = 'web') {
  try {
    return await aiPromptService.getSystemPromptForRole(role, { channel });
  } catch (err) {
    console.warn('[ai-chat] prompt service failed, using code defaults:', err.message);
    let base;
    switch (role) {
      case 'seller':
        base = SELLER_PROMPT;
        break;
      case 'admin':
        base = ADMIN_PROMPT;
        break;
      default:
        base = USER_PROMPT;
    }
    const whatsapp = channel === 'whatsapp' ? WHATSAPP_SYSTEM_PROMPT_ADDENDUM : '';
    return base + LANGUAGE_STYLE_ADDENDUM + TOOL_MEMORY_ADDENDUM + COMMERCE_POLICY_ADDENDUM + whatsapp;
  }
}

const GUEST_TOOL_NAMES = new Set([
  'search_products',
  'navigate',
  'show_style_advice',
  'suggest_outfit',
  'get_product_detail',
  'send_product_image',
  'get_available_coupons',
  'validate_coupon',
  'get_verified_stores',
  'get_store_details',
  'search_stores',
]);

const guestTools = userTools.filter(t => GUEST_TOOL_NAMES.has(t.function.name));

function getTools(role) {
  switch (role) {
    case 'seller':
      return sellerTools;
    case 'admin':
      return adminTools;
    case 'user':
      return userTools;
    default:
      return guestTools;
  }
}

/**
 * Server-side allow-list: hard-enforces which tools each role can invoke.
 * This is the second layer of security (the first being the role-scoped tool list
 * sent to the model). Even if the model hallucinates a tool, we block it here.
 */
const ALLOWED_TOOLS_BY_ROLE = {
  user: new Set(userTools.map(t => t.function.name)),
  seller: new Set(sellerTools.map(t => t.function.name)),
  admin: new Set(adminTools.map(t => t.function.name)),
  guest: GUEST_TOOL_NAMES,
};

function isToolAllowedForRole(toolName, role) {
  const set = ALLOWED_TOOLS_BY_ROLE[role] || ALLOWED_TOOLS_BY_ROLE.guest;
  return set.has(toolName);
}

function getUpdatePayload(args) {
  return args?.updates && typeof args.updates === 'object' && !Array.isArray(args.updates)
    ? args.updates
    : (args || {});
}

function looksLikeStoreChangeQuestion(text) {
  const t = String(text || '').toLowerCase();
  if (!/(store\s*name|subdomain|store\s*slug|slug)/.test(t)) return false;
  if (!/(change|rename|update|edit|modify)/.test(t)) return false;
  return /\b(can|could|may|allowed|able|possible|when|how soon)\b/.test(t) || t.includes('?');
}

function hasExplicitStoreTarget(text) {
  const t = String(text || '').toLowerCase();
  return /\b(change|rename|update|set)\b[\s\S]{0,80}\b(store\s*name|subdomain|store\s*slug|slug)\b[\s\S]{0,40}\b(to|as)\b\s+["']?[\w][\w\s.-]{2,}/.test(t);
}

function isPlaceholderStoreValue(value) {
  const v = String(value || '').trim().toLowerCase();
  return [
    'your new store name',
    'new store name',
    'store name',
    'your new subdomain',
    'new subdomain',
    'subdomain',
    'your-new-store-name',
    'new-store-name',
    'your-new-subdomain',
    'new-subdomain',
  ].includes(v);
}

async function executeToolCallForChat(toolName, args, userObj, lastUserText = '') {
  const argsWithContext = args && typeof args === 'object' && !Array.isArray(args)
    ? { ...args, _lastUserText: lastUserText }
    : { _lastUserText: lastUserText };

  if (toolName !== 'update_store') {
    return executeToolCall(toolName, argsWithContext, userObj);
  }

  const updates = getUpdatePayload(args);
  const identityFields = ['storeName', 'storeSlug', 'sellerType'];
  const touchesIdentity = identityFields.some(field => updates[field] !== undefined);
  const hasPlaceholder = identityFields.some(field => isPlaceholderStoreValue(updates[field]));

  if (hasPlaceholder) {
    return {
      success: false,
      blocked: true,
      error: 'No store update was performed because the requested value looked like a placeholder. Ask for the exact new store name or subdomain first.',
    };
  }

  if (touchesIdentity && looksLikeStoreChangeQuestion(lastUserText) && !hasExplicitStoreTarget(lastUserText)) {
    const inspection = await executeToolCall('get_my_store', {}, userObj);
    return {
      success: false,
      blocked: true,
      error: 'No store update was performed because the user asked whether the change is allowed. Use the store changeLimits data to answer, then ask for the desired value if a change is currently available.',
      data: inspection?.data ? { store: inspection.data } : undefined,
    };
  }

  return executeToolCall(toolName, argsWithContext, userObj);
}

/**
 * Token-saving: keep last N full messages, condense older ones into summary.
 */
function optimizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  if (messages.length <= 20) return messages;

  const older = messages.slice(0, messages.length - 20);
  const recent = messages.slice(-20);

  const summary = older
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .slice(-10)
    .map(m => {
      const content = typeof m.content === 'string' ? m.content : '';
      return `${m.role}: ${content.slice(0, 140)}`;
    })
    .join('\n');

  if (!summary) return recent;

  return [
    { role: 'system', content: `## Earlier conversation (condensed context)\n${summary}` },
    ...recent,
  ];
}

/**
 * Build deep user context for personalization.
 */
async function buildUserContext(userId, role) {
  if (!userId) return null;
  try {
    const user = await User.findById(userId).select('username email role currency sellerInfo createdAt');
    if (!user) return null;

    const ctx = {
      name: user.username || '',
      email: user.email || '',
      role: user.role,
      currency: user.currency || 'USD',
      memberSince: user.createdAt ? user.createdAt.toISOString().split('T')[0] : null,
    };

    // Recent orders (all roles)
    const recentOrders = await Order.find({ user: userId })
      .sort({ createdAt: -1 })
      .limit(5)
      .populate('orderItems.productId', 'name category brand')
      .lean();

    ctx.recentOrders = recentOrders.map(o => ({
      orderId: o.orderId,
      status: o.orderStatus,
      total: o.orderSummary?.totalAmount || 0,
      currency: o.currency || 'USD',
      items: (o.orderItems || []).map(i => i.productId?.name).filter(Boolean).slice(0, 3),
      date: o.createdAt,
    }));

    // Favorite categories from order history
    const categories = {};
    recentOrders.forEach(o => {
      (o.orderItems || []).forEach(item => {
        if (item.productId?.category) {
          categories[item.productId.category] = (categories[item.productId.category] || 0) + 1;
        }
      });
    });
    ctx.topCategories = Object.entries(categories)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([cat]) => cat);

    // Seller-specific enrichment
    if (role === 'seller') {
      try {
        const store = await Store.findOne({ seller: userId }).select('storeName storeSlug verification trustCount isActive lastNameChangeAt lastSlugChangeAt lastTypeChangeAt');
        if (store) {
          ctx.store = {
            name: store.storeName,
            slug: store.storeSlug,
            url: store.storeSlug ? `https://${store.storeSlug}.rozare.com/` : null,
            isVerified: store.verification?.isVerified || false,
            trustCount: store.trustCount || 0,
            isActive: store.isActive,
            changeLimits: storeChangeLimits(store),
          };
        }
        const productCount = await Product.countDocuments({ seller: userId });
        ctx.productCount = productCount;
      } catch (e) { /* non-fatal */ }
    }

    // Admin-specific enrichment
    if (role === 'admin') {
      try {
        const [totalUsers, totalOrders, totalStores, pendingVerifications] = await Promise.all([
          User.countDocuments(),
          Order.countDocuments(),
          Store.countDocuments(),
          Store.countDocuments({ 'verification.status': 'pending' }),
        ]);
        ctx.platform = { totalUsers, totalOrders, totalStores, pendingVerifications };
      } catch (e) { /* non-fatal */ }
    }

    return ctx;
  } catch (e) {
    console.error('buildUserContext error:', e.message);
    return null;
  }
}

function formatContextBlock(ctx, role) {
  if (!ctx) return '';
  let s = `\n\n## Current User Context (use this to personalize, don't repeat back verbatim)\n`;
  if (ctx.name) s += `- Name: ${ctx.name}\n`;
  s += `- Role: ${ctx.role}\n`;
  if (ctx.currency) s += `- Preferred currency: ${ctx.currency}\n`;
  if (ctx.memberSince) s += `- Member since: ${ctx.memberSince}\n`;
  if (ctx.topCategories?.length) s += `- Loves: ${ctx.topCategories.join(', ')}\n`;
  if (ctx.recentOrders?.length) {
    s += `- Recent orders:\n`;
    ctx.recentOrders.forEach(o => {
      s += `  • #${o.orderId}: ${o.items?.join(', ') || 'items'} — ${o.status} — ${formatMoneySync(o.total, o.currency || 'USD', { sourceCurrency: o.currency || 'USD' })}\n`;
    });
  }
  if (role === 'seller' && ctx.store) {
    s += `- Store: "${ctx.store.name}" (${ctx.store.slug}) - ${ctx.store.isVerified ? 'verified' : 'not verified'} - ${ctx.productCount ?? 0} products - ${ctx.store.trustCount} trust\n`;
    if (ctx.store.url) s += `- Store URL: ${ctx.store.url}\n`;
  }
  if (role === 'seller' && ctx.store?.changeLimits) {
    const limits = ctx.store.changeLimits;
    if (limits.storeName) {
      s += `- Store name change: ${limits.storeName.canChange ? 'available now' : `available in ${limits.storeName.daysRemaining} day(s) on ${String(limits.storeName.nextAllowedAt).slice(0, 10)}`}\n`;
    }
    if (limits.subdomain) {
      s += `- Subdomain change: ${limits.subdomain.canChange ? 'available now' : `available in ${limits.subdomain.daysRemaining} day(s) on ${String(limits.subdomain.nextAllowedAt).slice(0, 10)}`}\n`;
    }
  }
  if (role === 'admin' && ctx.platform) {
    s += `- Platform snapshot: ${ctx.platform.totalUsers} users, ${ctx.platform.totalOrders} orders, ${ctx.platform.totalStores} stores, ${ctx.platform.pendingVerifications} pending verifications\n`;
  }

  const hour = new Date().getHours();
  const timeOfDay = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : hour < 21 ? 'evening' : 'night';
  s += `- Current time of day: ${timeOfDay}\n`;
  return s;
}

/**
 * Filter/stamp tool calls coming back from the model to enforce role allowlist.
 * This is a LAST-MILE check; the backend AI-action routes ALSO re-validate role.
 */
function filterToolCallsByRole(parsed, role) {
  if (!parsed?.choices) return parsed;
  parsed.choices = parsed.choices.map(choice => {
    const delta = choice.delta || choice.message;
    if (!delta?.tool_calls) return choice;
    const filtered = [];
    for (const tc of delta.tool_calls) {
      const name = tc.function?.name;
      // When streaming, the first chunk has the name; subsequent chunks have argument deltas
      // We only filter when a named tool call appears and is disallowed
      if (name && !isToolAllowedForRole(name, role)) {
        // Drop this tool call entirely — replace with null/no-op
        continue;
      }
      filtered.push(tc);
    }
    if (delta.tool_calls) delta.tool_calls = filtered;
    return choice;
  });
  return parsed;
}

// ─── Helper: read a full streaming response, buffer tool calls, forward text ─
async function consumeStream(response, { onText, onToolCallDelta, role }) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let assistantContent = '';
  const toolCallMap = {}; // indexed by tool_call index

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        let line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (!line.startsWith('data: ')) continue;

        const jsonStr = line.slice(6).trim();
        if (jsonStr === '[DONE]') continue;

        try {
          const parsed = JSON.parse(jsonStr);
          if (parsed.error) throw new Error(parsed.error?.message || parsed.error);
          const choice = parsed.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta;
          if (!delta) continue;

          // Text content
          if (delta.content) {
            assistantContent += delta.content;
            if (onText) onText(delta.content);
          }

          // Tool call deltas — accumulate into toolCallMap
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const i = tc.index ?? 0;
              if (!toolCallMap[i]) {
                toolCallMap[i] = { id: '', name: '', arguments: '' };
              }
              if (tc.id) toolCallMap[i].id = tc.id;
              if (tc.function?.name) toolCallMap[i].name = tc.function.name;
              if (tc.function?.arguments) toolCallMap[i].arguments += tc.function.arguments;
            }
          }
        } catch (e) {
          if (e.message?.includes('AI') || e.message?.includes('rate')) throw e;
          // Ignore JSON parse errors mid-stream
        }
      }
    }
  } finally {
    try { reader.cancel(); } catch {}
  }

  // Build tool_calls array (only allowed tools)
  const toolCalls = Object.values(toolCallMap)
    .filter(tc => tc.name && isToolAllowedForRole(tc.name, role));

  return { assistantContent, toolCalls };
}

// ─── WhatsApp Mode System Prompt Addendum ────────────────────────────

/**
 * processAIChatMessage — Reusable core AI chat engine
 * ────────────────────────────────────────────────────
 * Used by both the HTTP chatOnce endpoint AND the WhatsApp AI chat service.
 * Runs a non-streaming AI conversation with server-side tool execution loop.
 *
 * @param {Object} userObj - { _id, id, role } — the authenticated user
 * @param {Array}  incomingMessages - array of { role, content } messages
 * @param {Object} options - { mode: 'web'|'whatsapp', conversationId?: string }
 * @returns {Object} { responseText, toolResults, clientActions, conversationId }
 */
async function processAIChatMessage(userObj, incomingMessages, options = {}) {
  const mode = options.mode || 'web';
  const isWhatsApp = mode === 'whatsapp';

  const userId = userObj?._id || userObj?.id || null;
  const effectiveRole = ['user', 'seller', 'admin'].includes(userObj?.role)
    ? userObj.role
    : 'guest';

  const userContext = await buildUserContext(userId, effectiveRole);
  let systemContent = await getSystemPrompt(effectiveRole, isWhatsApp ? 'whatsapp' : 'web');
  systemContent += formatContextBlock(userContext, effectiveRole);

  if (effectiveRole === 'guest') {
    systemContent += `\n\n## IMPORTANT: This user is NOT logged in. Encourage them to sign in for personalized help.`;
  }

  const { cleanMessages, memoryMessage } = prepareIncomingChatMessages(incomingMessages);

  const conversationMessages = [
    { role: 'system', content: systemContent },
    ...(memoryMessage ? [memoryMessage] : []),
    ...optimizeMessages(cleanMessages),
  ];

  const tools = getTools(effectiveRole);
  const toolResults = [];
  const clientActions = [];
  const lastUserText = cleanMessages.filter(m => m.role === 'user').pop()?.content || '';

  const MAX_ITERATIONS = 5;
  let lastMessage = null;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const isLast = i === MAX_ITERATIONS - 1;
    if (!OPENROUTER_API_KEY) {
      throw new Error('AI service temporarily unavailable.');
    }

    const timeoutMs = isWhatsApp ? WHATSAPP_AI_REQUEST_TIMEOUT_MS : AI_REQUEST_TIMEOUT_MS;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref?.();

    let upstream;
    try {
      upstream = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': SITE_URL,
          'X-Title': SITE_NAME,
        },
        body: JSON.stringify({
          model: AI_MODEL,
          messages: conversationMessages,
          tools: isLast ? undefined : tools,
          stream: false,
          temperature: 0.7,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new Error('AI service timed out.');
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }

    if (!upstream.ok) {
      const t = await upstream.text().catch(() => '');
      console.error('OpenRouter non-stream error', upstream.status, t);
      if (upstream.status === 429) throw new Error('AI rate limit hit. Try again in a moment.');
      if (upstream.status === 402) throw new Error('AI credits exhausted.');
      throw new Error('AI service temporarily unavailable.');
    }

    const data = await upstream.json();
    const message = data.choices?.[0]?.message;
    if (!message) break;

    lastMessage = message;

    // Filter tool calls by role
    if (message.tool_calls?.length) {
      message.tool_calls = message.tool_calls.filter(tc =>
        tc.function?.name && isToolAllowedForRole(tc.function.name, effectiveRole)
      );
    }

    if (!message.tool_calls?.length) break;

    // Add assistant message and execute tools
    conversationMessages.push(message);

    for (const tc of message.tool_calls) {
      const toolName = tc.function.name;
      let args = {};
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}

      // Special handling for send_product_image in WhatsApp mode
      if (toolName === 'send_product_image' && isWhatsApp) {
        try {
          const product = await Product.findOne(publicProductFilter({ _id: args.productId })).select('name image images price discountedPrice currency priceCurrency stock seller').lean();
          const imageUrl = product?.image || product?.images?.[0]?.url || product?.images?.[0];
          if (!product || !(await isProductSellerPubliclyActive(product.seller))) {
            const toolResult = { success: false, error: 'Product not found.' };
            conversationMessages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: JSON.stringify(toolResult),
            });
            toolResults.push({ tool: toolName, result: toolResult, id: tc.id });
          } else if (!imageUrl) {
            conversationMessages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: JSON.stringify({ success: false, message: 'This product does not have an image.' }),
            });
            toolResults.push({ tool: toolName, result: { success: false, error: 'This product does not have an image.' }, id: tc.id });
          } else {
            const productCurrency = getProductCurrency(product);
            const priceText = product.discountedPrice
              ? `~${formatMoneySync(product.price, productCurrency, { sourceCurrency: productCurrency })}~ ${formatMoneySync(product.discountedPrice, productCurrency, { sourceCurrency: productCurrency })}`
              : formatMoneySync(product.price, productCurrency, { sourceCurrency: productCurrency });
            const caption = args.caption || [`*${product.name}*`, `Price: ${priceText}`, `${SITE_URL}/single-product/${product._id}`].join('\n');
            // Store image info for the WhatsApp service to send after response
            if (!options._pendingImages) options._pendingImages = [];
            options._pendingImages.push({ imageUrl, caption });
            const toolResult = {
              success: true,
              data: {
                productId: product._id,
                name: product.name,
                imageUrl,
                caption,
                price: product.discountedPrice || product.price,
                currency: productCurrency,
                stock: product.stock,
              },
              message: `Image of "${product.name}" will be sent to the user.`,
            };
            conversationMessages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: JSON.stringify(toolResult),
            });
            toolResults.push({ tool: toolName, result: toolResult, id: tc.id });
          }
        } catch (imgErr) {
          const toolResult = { success: false, error: 'Failed to fetch product image.' };
          conversationMessages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify(toolResult),
          });
          toolResults.push({ tool: toolName, result: toolResult, id: tc.id });
        }
        continue;
      }

      if (isClientSideTool(toolName)) {
        if (isWhatsApp) {
          // In WhatsApp mode, convert client-side tools to text results
          let textResult = '';
          if (toolName === 'navigate') {
            const route = args.route || '/';
            const label = args.label || 'Page';
            textResult = `Here's the link: ${SITE_URL}${route} (${label})`;
          } else if (toolName === 'show_style_advice') {
            textResult = `Style Advice for ${args.occasion || 'any occasion'}:\n${args.advice || ''}`;
            if (args.tips?.length) textResult += '\n\nTips:\n' + args.tips.map(t => `• ${t}`).join('\n');
          } else if (toolName === 'suggest_outfit') {
            textResult = `Outfit for ${args.occasion || 'any occasion'}:\n`;
            if (args.pieces?.length) {
              textResult += args.pieces.map(p => `• ${p.type}: ${p.description}`).join('\n');
            }
            if (args.reasoning) textResult += `\n\n${args.reasoning}`;
          } else {
            textResult = `${toolName} executed.`;
          }
          conversationMessages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify({ success: true, message: textResult }),
          });
          toolResults.push({ tool: toolName, result: { success: true, message: textResult }, id: tc.id });
        } else {
          // Web mode: send client actions as before
          clientActions.push({ action: toolName, args, id: tc.id });
          conversationMessages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify({ success: true, message: `${toolName} sent to client.` }),
          });
        }
      } else {
        // Server-side execution
        const result = await executeToolCallForChat(toolName, args, userObj, lastUserText);
        toolResults.push({ tool: toolName, result, id: tc.id });
        conversationMessages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(result),
        });
      }
    }
  }

  const responseText = sanitizeAssistantVisibleText(
    typeof lastMessage?.content === 'string' ? lastMessage.content : ''
  );

  // Save to conversation history — ONLY the NEW messages from this interaction
  // (not the full history that was passed in as context, to avoid duplication)
  let savedConvoId = null;
  if (userId) {
    try {
      // Save only NEW messages from this request (not the history passed as context).
      // Simple approach: save the last user message + the final AI response text.
      // This avoids index calculation bugs when optimizeMessages condenses history.
      const lastUserMsg = incomingMessages.filter(m => m.role === 'user').pop();
      const newMessages = [];
      if (lastUserMsg?.content) {
        newMessages.push({
          role: 'user',
          content: typeof lastUserMsg.content === 'string' ? lastUserMsg.content : '',
          ...(Array.isArray(lastUserMsg.attachments) ? { attachments: lastUserMsg.attachments } : {}),
        });
      }
      if (responseText) {
        const toolEvents = [
          ...toolResults.map(t => ({ type: 'tool_result', tool: t.tool, result: t.result })),
          ...clientActions.map(c => ({ type: 'client_action', action: c.action, args: c.args })),
        ];
        newMessages.push({
          role: 'assistant',
          content: responseText,
          ...(toolEvents.length ? { toolEvents } : {}),
        });
      }

      if (newMessages.length > 0) {
        savedConvoId = await saveToConversation(userId, options.conversationId || null, newMessages, isWhatsApp ? 'whatsapp' : 'web');
      }
    } catch (e) {
      console.error('processAIChatMessage: chat history save error:', e.message);
    }
  }

  return {
    responseText,
    toolResults,
    clientActions,
    conversationId: savedConvoId?.toString() || null,
    role: effectiveRole,
    lastMessage: lastMessage ? { ...lastMessage, content: responseText } : lastMessage,
  };
}

// Export for use by WhatsApp AI chat service
exports.processAIChatMessage = processAIChatMessage;

// ─── MAIN CHAT ENDPOINT (Streaming SSE with Server-Side Tool Loop) ───

exports.streamChat = async (req, res) => {
  try {
    if (!OPENROUTER_API_KEY) {
      return res.status(500).json({
        error: 'AI service not configured. Please contact support.',
        detail: 'OPENROUTER_API_KEY missing',
      });
    }

    const body = req.body || {};
    const incoming = await getIncomingMessagesFromRequest(req);

    const authenticatedRole = req.user?.role || 'guest';
    const userId = req.user?.id || null;
    const effectiveRole = ['user', 'seller', 'admin'].includes(authenticatedRole)
      ? authenticatedRole
      : 'guest';

    // Build the user object for the executor
    const userObj = userId ? { _id: userId, id: userId, role: effectiveRole } : null;

    const userContext = await buildUserContext(userId, effectiveRole);

    let systemContent = await getSystemPrompt(effectiveRole);
    systemContent += formatContextBlock(userContext, effectiveRole);
    if (effectiveRole === 'guest') {
      systemContent += `\n\n## IMPORTANT: This user is NOT logged in. Do not try to access their personal data. Encourage them to sign in for personalized help.`;
    }

    const { cleanMessages, memoryMessage } = prepareIncomingChatMessages(incoming);

    const tools = getTools(effectiveRole);

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const closed = () => res.writableEnded || res.destroyed;
    const send = (obj) => { if (!closed()) res.write(`data: ${JSON.stringify(obj)}\n\n`); };

    // Heartbeat
    const heartbeat = setInterval(() => { if (!closed()) res.write(': ping\n\n'); }, 15000);
    const cleanupHB = () => clearInterval(heartbeat);
    req.on('close', cleanupHB);

    // Build conversation for the API
    const conversationMessages = [
      { role: 'system', content: systemContent },
      ...(memoryMessage ? [memoryMessage] : []),
      ...optimizeMessages(cleanMessages),
    ];

    // Track where new messages start (so we only save NEW messages to history)
    const newMsgStartIndex = conversationMessages.length;

    // Collect tool events from this turn so we can persist them with the assistant message
    const turnToolEvents = [];
    const lastUserText = cleanMessages.filter(m => m.role === 'user').pop()?.content || '';

    // ═══ Tool Execution Loop ═══
    // The AI may request tool calls. We execute them server-side, feed results back,
    // and let the AI generate a natural language summary. Max 5 iterations for safety.
    const MAX_TOOL_ITERATIONS = 5;
    let iteration = 0;
    let finalTextSent = false;

    while (iteration < MAX_TOOL_ITERATIONS && !closed()) {
      iteration++;
      const isLastChance = iteration === MAX_TOOL_ITERATIONS;

      // Call OpenRouter (streaming)
      const upstreamResp = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': SITE_URL,
          'X-Title': SITE_NAME,
        },
        body: JSON.stringify({
          model: AI_MODEL,
          messages: conversationMessages,
          tools: isLastChance ? undefined : tools, // Don't offer tools on last iteration
          stream: true,
          temperature: 0.7,
        }),
      });

      if (!upstreamResp.ok) {
        const errorText = await upstreamResp.text().catch(() => '');
        console.error('OpenRouter error', upstreamResp.status, errorText);
        const errMsg = upstreamResp.status === 429
          ? 'AI rate limit hit. Please try again in a moment.'
          : upstreamResp.status === 402
            ? 'AI credits exhausted. Please top up.'
            : 'AI service temporarily unavailable.';
        send({ error: errMsg });
        break;
      }

      if (!upstreamResp.body) {
        send({ error: 'Empty AI response' });
        break;
      }

      // Consume the stream: forward text to client in real-time, accumulate tool calls
      const { assistantContent, toolCalls } = await consumeStream(upstreamResp, {
        onText: (chunk) => {
          // Stream text chunks to client in real-time (typing effect)
          if (!closed()) {
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
          }
        },
        role: effectiveRole,
      });

      // If no tool calls, the AI gave a direct text answer — we're done
      if (toolCalls.length === 0) {
        finalTextSent = true;
        // Add assistant message to conversation for history
        conversationMessages.push({ role: 'assistant', content: sanitizeAssistantVisibleText(assistantContent) });
        break;
      }

      // ── Tool calls detected: execute them server-side ──
      // Add the assistant's tool-call message to the conversation
      const assistantMsg = {
        role: 'assistant',
        content: assistantContent || null,
        tool_calls: toolCalls.map((tc, i) => ({
          id: tc.id || `call_${Date.now()}_${i}`,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        })),
      };
      conversationMessages.push(assistantMsg);

      // Execute each tool call
      for (const tc of assistantMsg.tool_calls) {
        const toolName = tc.function.name;
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}

        if (isClientSideTool(toolName)) {
          // Client-side tools: send to frontend for rendering, give AI a success ack
          send({ type: 'client_action', action: toolName, args, id: tc.id });
          // Persist client actions other than navigation (which is a one-time side-effect)
          if (toolName !== 'navigate') {
            turnToolEvents.push({ type: 'client_action', action: toolName, args });
          }
          conversationMessages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify({ success: true, message: `${toolName} displayed to user.` }),
          });
        } else {
          // Server-side execution
          send({ type: 'tool_start', tool: toolName, id: tc.id });

          const result = await executeToolCallForChat(toolName, args, userObj, lastUserText);

          send({ type: 'tool_result', tool: toolName, result, id: tc.id });
          turnToolEvents.push({ type: 'tool_result', tool: toolName, result });

          conversationMessages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify(result),
          });
        }
      }

      // Loop continues — AI will now see tool results and generate a response
    }

    // ── Save chat history to conversation ──
    if (userId) {
      try {
        const conversationId = body.conversationId || null;
        const lastUserMsg = cleanMessages.filter(m => m.role === 'user').pop();
        const newMessages = [];
        if (lastUserMsg?.content && typeof lastUserMsg.content === 'string' && lastUserMsg.content.trim()) {
          newMessages.push({ role: 'user', content: lastUserMsg.content });
        }
        // Merge ALL assistant text from this turn into a single message
        // (multiple tool-rounds can produce multiple assistant text segments — they belong to the same turn)
        const assistantText = conversationMessages
          .slice(newMsgStartIndex)
          .filter(m => m.role === 'assistant' && typeof m.content === 'string' && m.content.trim())
          .map(m => sanitizeAssistantVisibleText(m.content).trim())
          .filter(Boolean)
          .join('\n\n');
        if (assistantText) {
          newMessages.push({ role: 'assistant', content: assistantText, toolEvents: turnToolEvents });
        }

        const savedConvoId = await saveToConversation(userId, conversationId, newMessages);
        // Send the conversationId back to the client so it can track it
        if (savedConvoId && !closed()) {
          res.write(`data: ${JSON.stringify({ type: 'conversation_id', conversationId: savedConvoId.toString() })}\n\n`);
        }
      } catch (e) {
        console.error('Chat history save error:', e.message);
      }
    }

    // Finalize SSE
    if (!closed()) {
      res.write('data: [DONE]\n\n');
      res.end();
    }
    cleanupHB();
  } catch (err) {
    console.error('streamChat fatal error:', err);
    if (!res.headersSent) {
      return res.status(500).json({ error: err.message || 'Server error' });
    }
    try {
      res.write(`data: ${JSON.stringify({ error: err.message || 'Server error' })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } catch {}
  }
};

/**
 * Non-streaming variant with server-side tool execution loop.
 * Used by React Native / Expo clients that cannot handle SSE.
 */
exports.chatOnce = async (req, res) => {
  try {
    if (!OPENROUTER_API_KEY) {
      return res.status(500).json({ error: 'AI service not configured' });
    }

    const body = req.body || {};
    const incoming = await getIncomingMessagesFromRequest(req);
    const authenticatedRole = req.user?.role || 'guest';
    const userId = req.user?.id || null;
    const effectiveRole = ['user', 'seller', 'admin'].includes(authenticatedRole)
      ? authenticatedRole
      : 'guest';

    const userObj = userId ? { _id: userId, id: userId, role: effectiveRole } : null;

    const userContext = await buildUserContext(userId, effectiveRole);
    let systemContent = await getSystemPrompt(effectiveRole);
    systemContent += formatContextBlock(userContext, effectiveRole);
    if (effectiveRole === 'guest') {
      systemContent += `\n\n## IMPORTANT: This user is NOT logged in. Encourage them to sign in for personalized help.`;
    }

    const { cleanMessages, memoryMessage } = prepareIncomingChatMessages(incoming);

    const conversationMessages = [
      { role: 'system', content: systemContent },
      ...(memoryMessage ? [memoryMessage] : []),
      ...optimizeMessages(cleanMessages),
    ];
    const tools = getTools(effectiveRole);
    const toolResults = []; // Collect tool results for client
    const clientActions = []; // Collect client-side actions
    const lastUserText = cleanMessages.filter(m => m.role === 'user').pop()?.content || '';

    // Tool execution loop (non-streaming)
    const MAX_ITERATIONS = 5;
    let lastMessage = null;

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const isLast = i === MAX_ITERATIONS - 1;

      const upstream = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': SITE_URL,
          'X-Title': SITE_NAME,
        },
        body: JSON.stringify({
          model: AI_MODEL,
          messages: conversationMessages,
          tools: isLast ? undefined : tools,
          stream: false,
          temperature: 0.7,
        }),
      });

      if (!upstream.ok) {
        const t = await upstream.text().catch(() => '');
        console.error('OpenRouter non-stream error', upstream.status, t);
        if (upstream.status === 429) return res.status(429).json({ error: 'AI rate limit hit. Try again.' });
        if (upstream.status === 402) return res.status(402).json({ error: 'AI credits exhausted.' });
        return res.status(500).json({ error: 'AI service temporarily unavailable' });
      }

      const data = await upstream.json();
      const message = data.choices?.[0]?.message;
      if (!message) break;

      lastMessage = message;

      // Filter tool calls by role
      if (message.tool_calls?.length) {
        message.tool_calls = message.tool_calls.filter(tc =>
          tc.function?.name && isToolAllowedForRole(tc.function.name, effectiveRole)
        );
      }

      // If no tool calls, done
      if (!message.tool_calls?.length) break;

      // Add assistant message and execute tools
      conversationMessages.push(message);

      for (const tc of message.tool_calls) {
        const toolName = tc.function.name;
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}

        if (isClientSideTool(toolName)) {
          clientActions.push({ action: toolName, args, id: tc.id });
          conversationMessages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify({ success: true, message: `${toolName} sent to client.` }),
          });
        } else {
          const result = await executeToolCallForChat(toolName, args, userObj, lastUserText);
          toolResults.push({ tool: toolName, result, id: tc.id });
          conversationMessages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify(result),
          });
        }
      }
    }

    // Save chat history — only the LAST user message + final AI response (not full history)
    if (userId) {
      try {
        const responseText = sanitizeAssistantVisibleText(
          typeof lastMessage?.content === 'string' ? lastMessage.content : ''
        );
        const lastUserMsg = cleanMessages.filter(m => m.role === 'user').pop();
        const newMessages = [];
        if (lastUserMsg?.content) {
          newMessages.push({ role: 'user', content: typeof lastUserMsg.content === 'string' ? lastUserMsg.content : '' });
        }
        if (responseText) {
          const toolEvents = [
            ...toolResults.map(t => ({ type: 'tool_result', tool: t.tool, result: t.result })),
            ...clientActions.map(c => ({ type: 'client_action', action: c.action, args: c.args })),
          ];
          newMessages.push({
            role: 'assistant',
            content: responseText,
            ...(toolEvents.length ? { toolEvents } : {}),
          });
        }
        if (newMessages.length > 0) {
          await saveToConversation(userId, body.conversationId || null, newMessages, 'web');
        }
      } catch (e) { /* non-fatal */ }
    }

    const responseText = sanitizeAssistantVisibleText(
      typeof lastMessage?.content === 'string' ? lastMessage.content : ''
    );
    const visibleMessage = lastMessage
      ? { ...lastMessage, content: responseText }
      : lastMessage;

    return res.json({
      message: visibleMessage,
      toolResults,
      clientActions,
      role: effectiveRole,
    });
  } catch (err) {
    console.error('chatOnce error:', err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
};

// ═══════════════════════════════════════════════════════════════════
//  CHAT HISTORY / CONVERSATION MANAGEMENT
// ═══════════════════════════════════════════════════════════════════

/**
 * Save messages to a specific conversation (or create/find the active one).
 */
async function saveToConversation(userId, conversationId, messages, source = 'web') {
  let history = await ChatHistory.findOne({ user: userId });
  if (!history) {
    history = new ChatHistory({ user: userId, conversations: [] });
  }

  let convo;
  if (conversationId) {
    convo = history.conversations.id(conversationId);
  }
  if (!convo) {
    if (source === 'whatsapp') {
      // For WhatsApp: find existing WhatsApp conversation or create one
      convo = history.conversations.find(c => c.source === 'whatsapp');
    } else {
      // For web: find the active web conversation
      convo = history.conversations.find(c => c.isActive && c.source !== 'whatsapp');
    }
    if (!convo) {
      // Auto-generate title from first user message
      const firstUserMsg = messages.find(m => m.role === 'user');
      const title = source === 'whatsapp'
        ? '[WhatsApp] Chat'
        : (firstUserMsg
          ? stripAttachmentMetadata(firstUserMsg.content).slice(0, 60) + (stripAttachmentMetadata(firstUserMsg.content).length > 60 ? '...' : '')
          : 'New Chat');
      history.conversations.push({ title, messages: [], isActive: source !== 'whatsapp', source });
      convo = history.conversations[history.conversations.length - 1];
      if (source !== 'whatsapp') {
        history.activeConversationId = convo._id;
      }
    }
  }

  // APPEND new messages (don't replace existing ones)
  for (const m of messages) {
    const entry = { role: m.role, content: m.content };
    const attachments = extractImageAttachments(m.content, m.attachments);
    if (attachments.length > 0) {
      entry.attachments = attachments;
    }
    if (Array.isArray(m.toolEvents) && m.toolEvents.length > 0) {
      entry.toolEvents = m.toolEvents;
    }
    convo.messages.push(entry);
  }
  // Cap at 200 messages
  if (convo.messages.length > 200) {
    convo.messages = convo.messages.slice(-200);
  }
  convo.lastActive = new Date();

  await history.save();
  return convo._id;
}

/**
 * GET /api/ai-chat/conversations — list user's conversations (sidebar)
 */
exports.getConversations = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required.' });

    const history = await ChatHistory.findOne({ user: userId }).lean();
    if (!history || !history.conversations?.length) {
      return res.json({ conversations: [], activeConversationId: null });
    }

    // Return conversations sorted by last active, with summary info
    const conversations = history.conversations
      .sort((a, b) => new Date(b.lastActive || b.updatedAt) - new Date(a.lastActive || a.updatedAt))
      .map(c => ({
        _id: c._id,
        title: c.title,
        messageCount: c.messages?.length || 0,
        lastActive: c.lastActive || c.updatedAt,
        isActive: c.isActive,
        preview: stripAttachmentMetadata(c.messages?.filter(m => m.role === 'user').pop()?.content || '').slice(0, 80),
      }));

    return res.json({
      conversations,
      activeConversationId: history.activeConversationId,
    });
  } catch (err) {
    console.error('getConversations error:', err);
    return res.status(500).json({ error: 'Failed to fetch conversations.' });
  }
};

/**
 * GET /api/ai-chat/conversations/:conversationId — load a specific conversation's messages
 */
exports.getConversation = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { conversationId } = req.params;
    if (!userId) return res.status(401).json({ error: 'Authentication required.' });

    const history = await ChatHistory.findOne({ user: userId }).lean();
    if (!history) return res.json({ messages: [], title: 'New Chat' });

    const convo = history.conversations?.find(c => c._id?.toString() === conversationId);
    if (!convo) return res.status(404).json({ error: 'Conversation not found.' });

    // Mark this as active
    await ChatHistory.updateOne(
      { user: userId },
      {
        $set: {
          activeConversationId: convo._id,
          'conversations.$[c].isActive': true,
        },
      },
      { arrayFilters: [{ 'c._id': convo._id }] }
    );

    // Deactivate other conversations
    await ChatHistory.updateOne(
      { user: userId },
      { $set: { 'conversations.$[c].isActive': false } },
      { arrayFilters: [{ 'c._id': { $ne: convo._id } }] }
    );

    return res.json({
      _id: convo._id,
      title: convo.title,
      messages: (convo.messages || []).map(m => ({
        role: m.role,
        content: m.content,
        attachments: m.attachments || [],
        toolEvents: m.toolEvents || [],
        createdAt: m.createdAt,
      })),
    });
  } catch (err) {
    console.error('getConversation error:', err);
    return res.status(500).json({ error: 'Failed to load conversation.' });
  }
};

/**
 * POST /api/ai-chat/conversations — create a new conversation
 */
exports.createConversation = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required.' });

    let history = await ChatHistory.findOne({ user: userId });
    if (!history) {
      history = new ChatHistory({ user: userId, conversations: [] });
    }

    // Deactivate all existing conversations
    history.conversations.forEach(c => { c.isActive = false; });

    const title = req.body.title || 'New Chat';
    history.conversations.push({ title, messages: [], isActive: true });
    const newConvo = history.conversations[history.conversations.length - 1];
    history.activeConversationId = newConvo._id;

    await history.save();

    return res.json({
      _id: newConvo._id,
      title: newConvo.title,
      messages: [],
    });
  } catch (err) {
    console.error('createConversation error:', err);
    return res.status(500).json({ error: 'Failed to create conversation.' });
  }
};

/**
 * DELETE /api/ai-chat/conversations/:conversationId — delete a conversation
 */
exports.deleteConversation = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { conversationId } = req.params;
    if (!userId) return res.status(401).json({ error: 'Authentication required.' });

    const history = await ChatHistory.findOne({ user: userId });
    if (!history) return res.status(404).json({ error: 'No chat history found.' });

    history.conversations = history.conversations.filter(
      c => c._id?.toString() !== conversationId
    );

    // If we deleted the active one, activate the latest
    if (history.activeConversationId?.toString() === conversationId) {
      const latest = history.conversations[history.conversations.length - 1];
      if (latest) {
        latest.isActive = true;
        history.activeConversationId = latest._id;
      } else {
        history.activeConversationId = null;
      }
    }

    await history.save();
    return res.json({ success: true, message: 'Conversation deleted.' });
  } catch (err) {
    console.error('deleteConversation error:', err);
    return res.status(500).json({ error: 'Failed to delete conversation.' });
  }
};

/**
 * PATCH /api/ai-chat/conversations/:conversationId/rename
 */
exports.renameConversation = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { conversationId } = req.params;
    const { title } = req.body;
    if (!userId) return res.status(401).json({ error: 'Authentication required.' });
    if (!title) return res.status(400).json({ error: 'Title is required.' });

    await ChatHistory.updateOne(
      { user: userId, 'conversations._id': conversationId },
      { $set: { 'conversations.$.title': title.slice(0, 100) } }
    );

    return res.json({ success: true });
  } catch (err) {
    console.error('renameConversation error:', err);
    return res.status(500).json({ error: 'Failed to rename.' });
  }
};

/**
 * DELETE /api/ai-chat/conversations/:conversationId/messages — clear messages but keep conversation
 */
exports.clearConversation = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { conversationId } = req.params;
    if (!userId) return res.status(401).json({ error: 'Authentication required.' });

    await ChatHistory.updateOne(
      { user: userId, 'conversations._id': conversationId },
      { $set: { 'conversations.$.messages': [] } }
    );

    return res.json({ success: true, message: 'Messages cleared.' });
  } catch (err) {
    console.error('clearConversation error:', err);
    return res.status(500).json({ error: 'Failed to clear.' });
  }
};
