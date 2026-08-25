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

    expect(payments).toContain("const formatDisplayMoney = (amount) => `${displayMoneyIsApproximate ? '≈' : ''}${formatAmount(amount)}`;");
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
  it('lets the server consume quota and handles the authoritative 429 response', () => {
    const chatBot = read('../../src/components/ChatBot.js');

    expect(chatBot).not.toContain("api.post('/api/ai-actions/rate-limit/increment'");
    expect(chatBot).toContain("response.code === 'AI_DAILY_LIMIT_REACHED'");
    expect(chatBot).toContain('checkRateLimit();');
  });

  it('threads the selected currency through every mobile AI money request path', () => {
    const chatBot = read('../../src/components/ChatBot.js');

    expect(chatBot).toContain('const { formatPrice, formatProductPrice, currency } = useCurrency();');
    expect(chatBot).toContain("resolveProductPresentationMoney(p, 'discountedPrice')");
    expect(chatBot).toContain("form.append('currency', requestCurrency);");
    expect(chatBot).toContain('{ messages, requestKey, currency: requestCurrency }');
    expect(chatBot).toContain('code: args.code, sellerId: args.sellerId, productId: args.productId, currency: requestCurrency');
    expect(chatBot).not.toContain('cartTotal: args.cartTotal');
    expect(chatBot).toContain('currency=${encodeURIComponent(requestCurrency)}&');
    expect(chatBot).toContain('const attempt = await getOrCreatePersistedMutationAttemptForFingerprint({');
    expect(chatBot).toContain('const response = await callAI(aiMessages, attachmentsToSend, attempt.key, currency);');
  });
});
