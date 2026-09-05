import fs from 'fs';
import path from 'path';
import { parse } from '@babel/parser';

const read = (...segments) => fs.readFileSync(path.resolve(__dirname, ...segments), 'utf8');

const evaluateStatic = (node) => {
  if (!node) return undefined;
  if (node.type === 'StringLiteral' || node.type === 'NumericLiteral' || node.type === 'BooleanLiteral') {
    return node.value;
  }
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis.map((part) => part.value.cooked).join('');
  }
  if (node.type === 'ArrayExpression') {
    return node.elements.map(evaluateStatic);
  }
  if (node.type === 'ObjectExpression') {
    return node.properties.reduce((result, property) => {
      if (property.type !== 'ObjectProperty') return result;
      const key = property.key.name || property.key.value;
      const value = evaluateStatic(property.value);
      if (value !== undefined) result[key] = value;
      return result;
    }, {});
  }
  return undefined;
};

const readStaticConstant = (source, constantName) => {
  const ast = parse(source, { sourceType: 'module', plugins: ['jsx'] });
  for (const statement of ast.program.body) {
    if (statement.type !== 'VariableDeclaration') continue;
    for (const declaration of statement.declarations) {
      if (declaration.id?.name === constantName) return evaluateStatic(declaration.init);
    }
  }
  throw new Error(`Static constant ${constantName} was not found`);
};

const withoutIcons = (items) => items.map(({ icon, ...item }) => item);

describe('website and mobile information parity', () => {
  const websiteTerms = read('../../../Frontend/src/pages/TermsOfService.jsx');
  const mobileTerms = read('../../src/screens/TermsOfServiceScreen.js');
  const websitePrivacy = read('../../../Frontend/src/pages/PrivacyPolicy.jsx');
  const mobilePrivacy = read('../../src/screens/PrivacyPolicyScreen.js');
  const websiteFaq = read('../../../Frontend/src/pages/FAQPage.jsx');
  const mobileFaq = read('../../src/screens/FAQScreen.js');
  const websiteAbout = read('../../../Frontend/src/pages/AboutPage.jsx');
  const mobileAbout = read('../../src/screens/AboutScreen.js');
  const websiteDocs = read('../../../Frontend/src/pages/DocsPage.jsx');
  const mobileDocs = read('../../src/screens/DocsScreen.js');

  it('keeps the legal Terms and Privacy sections word-for-word aligned', () => {
    expect(withoutIcons(readStaticConstant(mobileTerms, 'sections')))
      .toEqual(withoutIcons(readStaticConstant(websiteTerms, 'sections')));
    expect(withoutIcons(readStaticConstant(mobilePrivacy, 'sections')))
      .toEqual(withoutIcons(readStaticConstant(websitePrivacy, 'sections')));
  });

  it('keeps FAQ questions, answers, and About content aligned with the website', () => {
    const websiteFaqData = readStaticConstant(websiteFaq, 'faqCategories');
    const mobileFaqData = readStaticConstant(mobileFaq, 'faqCategories');
    expect(mobileFaqData.map(({ category, questions }) => ({
      category,
      questions: questions.map(({ q, a }) => ({ q, a })),
    }))).toEqual(websiteFaqData.map(({ category, questions }) => ({
      category,
      questions: questions.map(({ q, a }) => ({ q, a })),
    })));

    expect(withoutIcons(readStaticConstant(mobileAbout, 'values')))
      .toEqual(withoutIcons(readStaticConstant(websiteAbout, 'values')));
    expect(readStaticConstant(mobileAbout, 'stats'))
      .toEqual(readStaticConstant(websiteAbout, 'stats'));
  });

  it('exposes every website documentation section in the mobile guide', () => {
    const websiteSections = readStaticConstant(websiteDocs, 'SECTIONS');
    const mobileSections = readStaticConstant(mobileDocs, 'SECTIONS');
    expect(mobileSections.map(({ id, title }) => ({ id, title })))
      .toEqual(websiteSections.map(({ id, title }) => ({ id, title })));
    mobileSections.forEach((section) => expect(section.body.trim().length).toBeGreaterThan(80));
  });

  it('keeps factual AI, tags, tracking, and verification guidance explicit', () => {
    const docsText = readStaticConstant(mobileDocs, 'SECTIONS')
      .map(({ body }) => body)
      .join(' ');
    const faqItems = readStaticConstant(mobileFaq, 'faqCategories')
      .flatMap(({ questions }) => questions);
    const faqAnswer = (question) => faqItems.find(({ q }) => q === question)?.a || '';

    expect(docsText).toContain('Web and app chat history is kept separate from WhatsApp chat history.');
    expect(docsText).toContain('Web and app shopping chat allow 5 messages per UTC day for guests and 20 for signed-in buyers');
    expect(docsText).toContain('WhatsApp uses separate protections and conversation history.');
    expect(docsText).not.toMatch(/same conversation context is shared/i);
    expect(docsText).not.toMatch(/(?:up to|allow(?:s)?) 15 tags/i);

    expect(faqAnswer('How do I track my order?')).not.toMatch(/tracking number|email/i);
    expect(faqAnswer('What is the Trust system?')).toContain('does not grant a verified badge');
    expect(faqAnswer('How are stores verified?')).toContain('an admin reviews the store');
  });

  it('documents the complete subscription contract and loads live catalog values', () => {
    const docsText = readStaticConstant(mobileDocs, 'SECTIONS')
      .find(section => section.id === 'subscription-plans')?.body || '';
    const subscriptionScreen = read('../../src/screens/seller/SellerSubscriptionScreen.js');

    expect(docsText).toContain('up to 15 products during that trial');
    expect(docsText).toContain('one 30-day introductory period');
    expect(docsText).toContain('one 45-day introductory period');
    expect(docsText).toContain('rate is claimed only after Stripe confirms completion');
    expect(docsText).toContain('extra 40% founder discount');
    expect(docsText).toContain('reserves a place for 35 minutes');
    expect(docsText).toContain('permanently forfeited if the subscription ends');
    expect(docsText).toContain('3 days after blocking');
    expect(docsText).toContain('does not grant a fresh Starter bonus period');
    expect(mobileDocs).toContain('api.get(API_ENDPOINTS.SUBSCRIPTION.CATALOG');
    expect(mobileDocs).toContain('buildSubscriptionDocsBody(subscriptionCatalog)');

    expect(subscriptionScreen).toContain("free_period: ['Introductory Period'");
    expect(subscriptionScreen).toContain("past_due: ['Past Due'");
    expect(subscriptionScreen).toContain('Access currently unavailable');
    expect(subscriptionScreen).toContain('FIRST100 founder rate forfeited');
    expect(subscriptionScreen).toContain('Bonus features expired');
    expect(subscriptionScreen).toContain('The complete subscription lifecycle');
    expect(subscriptionScreen).toContain('starterBonusPeriodUsed');
    expect(subscriptionScreen).toContain('Up to 15 product listings during the free trial');
    expect(subscriptionScreen).toContain('Rozare WhatsApp order confirmation automation');
    expect(subscriptionScreen).toContain('model.isElite && model.isSubscribed && styles.currentEliteCard');
    expect(subscriptionScreen).toContain("model.isBlocked\n                      ? 'Subscribe to restore your public store and seller tools'");
  });
});

describe('product gallery gesture ownership', () => {
  it('reserves Product Details horizontal gestures for the image gallery', () => {
    const navigator = read('../../src/navigation/AppNavigator.js');
    const productDetail = read('../../src/screens/ProductDetailScreen.js');
    const routeBlock = navigator.match(/<Stack\.Screen\s+name="ProductDetail"[\s\S]*?\/>/)?.[0] || '';

    expect(routeBlock).toContain('gestureEnabled: false');
    expect(productDetail).toContain('{...galleryPanResponder.panHandlers}');
    expect(productDetail).toContain('onMoveShouldSetPanResponderCapture');
  });
});

describe('checkout fixed-tax FX safety', () => {
  it('tracks the configured source amount instead of the rounded display tax', () => {
    const checkout = read('../../src/screens/CheckoutScreen.js');

    expect(checkout).toContain('const [taxSourceAmount, setTaxSourceAmount] = useState(0);');
    expect(checkout).toContain('taxCurrency && hasCurrencyAmount(taxSourceAmount) ? taxCurrency : null');
    expect(checkout).not.toContain('hasCurrencyAmount(tax) ? taxCurrency : null');
  });

  it('fails tax closed, handles authoritative repricing, and never labels paid sub-cent shipping as free', () => {
    const checkout = read('../../src/screens/CheckoutScreen.js');

    expect(checkout).toContain("const [taxStatus, setTaxStatus] = useState('loading');");
    expect(checkout).toContain('parseCheckoutTaxConfigResponse(taxRes.data)');
    expect(checkout).toContain('if (isCheckoutRepriceRequired(error))');
    expect(checkout).toContain('Review the new total, then press the payment button again');
    expect(checkout).toContain('isPositiveSourceAmountRoundedToZero(sourceAmount, targetAmount)');
    expect(checkout).not.toContain("methodCost === 0 ? 'Free'");
  });
});

describe('seller balance fallback-rate labeling', () => {
  it('marks every converted balance-detail amount as approximate during an FX outage', () => {
    const payments = read('../../src/screens/seller/SellerPaymentsScreen.js');

    expect(payments).toContain("const formatDisplayMoney = (amount) => `${displayMoneyIsApproximate ? '≈' : ''}${formatAmount(amount, { targetCurrency: sellerCurrency })}`;");
    expect(payments).toContain('<Text style={styles.balanceValue}>{formatDisplayMoney(amount)}</Text>');
  });
});

describe('currency account and live-rate isolation', () => {
  it('never promotes a guest device currency into an authenticated account', () => {
    const mobileContext = read('../../src/contexts/CurrencyContext.js');
    const webContext = read('../../../Frontend/src/contexts/CurrencyContext.jsx');

    expect(mobileContext).toContain("setCurrencyState('USD');");
    expect(mobileContext).not.toMatch(/accountCurrencyKey\(activeAccountId\),\s*deviceCurrency/);
    expect(webContext).toContain("setCurrency('USD');");
    [mobileContext, webContext].forEach((source) => {
      expect(source).toContain('lastLiveAt = res.data.fallback === false ? Date.now() : 0');
      expect(source).toContain('ratesClockRef.current.lastLiveAt = 0;');
    });
  });
});

describe('AI daily quota ownership', () => {
  it('renders shared rich product results and refreshes native state after AI mutations', () => {
    const chatBot = read('../../src/components/ChatBot.js');

    expect(chatBot).toContain("['search_products', 'list_my_products', 'get_wishlist'].includes(tr.name)");
    expect(chatBot).toContain("tr.name === 'get_product_detail'");
    expect(chatBot).toContain("tr.name === 'view_cart'");
    expect(chatBot).toContain('price: cartItem.price,');
    expect(chatBot).not.toContain('price: cartItem.originalPrice || cartItem.price');
    expect(chatBot).toContain("['add_to_wishlist', 'remove_from_wishlist'].includes(tr.name)");
    expect(chatBot).toContain('void fetchWishlist();');
    expect(chatBot).toContain('void fetchCart();');
    expect(chatBot).toContain('void refreshUnreadCount();');
    expect(chatBot).toContain('void fetchAndUpdateCurrentUser();');
  });

  it('lets the server consume quota and handles the authoritative 429 response', () => {
    const chatBot = read('../../src/components/ChatBot.js');

    expect(chatBot).not.toContain("api.post('/api/ai-actions/rate-limit/increment'");
    expect(chatBot).toContain("response.code === 'AI_DAILY_LIMIT_REACHED'");
    expect(chatBot).toContain('checkRateLimit();');
  });

  it('keeps tool-only turns in model context without replaying successful actions', () => {
    const chatBot = read('../../src/components/ChatBot.js');

    expect(chatBot).toContain('Array.isArray(m.toolResults) && m.toolResults.length > 0');
    expect(chatBot).toContain('succeeded in the previous assistant turn. Do not repeat it');
    expect(chatBot).toContain("[m.content, toolMemory].filter(Boolean).join('\\n\\n')");
  });

  it('threads the selected currency through every mobile AI money request path', () => {
    const chatBot = read('../../src/components/ChatBot.js');

    expect(chatBot).toContain('const { formatPrice, formatProductPrice, getProductCurrency, currency } = useCurrency();');
    expect(chatBot).toContain("resolveProductPresentationMoney(p, 'discountedPrice')");
    expect(chatBot).toContain("tr.name === 'list_my_products'");
    expect(chatBot).toContain('getProductCurrency(p)');
    expect(chatBot).toContain("form.append('currency', requestCurrency);");
    expect(chatBot).toContain('currency: requestCurrency,');
    expect(chatBot).toContain("source: 'mobile'");
    expect(chatBot).toContain('...(conversationId ? { conversationId } : {})');
    expect(chatBot).toContain('requestKey = createChatRequestKey(),');
    expect(chatBot).toContain('code: args.code, sellerId: args.sellerId, productId: args.productId, currency: requestCurrency');
    expect(chatBot).not.toContain('cartTotal: args.cartTotal');
    expect(chatBot).toContain('currency=${encodeURIComponent(requestCurrency)}&');
    expect(chatBot).toContain('const attempt = await getOrCreatePersistedMutationAttemptForFingerprint({');
    expect(chatBot).toContain([
      'const response = await callAI(',
      '        aiMessages,',
      '        attachmentsToSend,',
      '        attempt.key,',
      '        currency,',
      '        activeConvoIdRef.current,',
    ].join('\n'));
  });
});
