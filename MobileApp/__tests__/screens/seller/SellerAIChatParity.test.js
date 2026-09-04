const fs = require('fs');
const path = require('path');

const sellerDashboardSource = fs.readFileSync(
  path.join(__dirname, '../../../src/screens/seller/SellerDashboardScreen.js'),
  'utf8',
);
const sharedChatScreenSource = fs.readFileSync(
  path.join(__dirname, '../../../src/screens/AIChatScreen.js'),
  'utf8',
);

describe('seller AI chat screen parity', () => {
  test('seller launcher opens the shared full-screen AI route', () => {
    expect(sellerDashboardSource).toContain("navigation.navigate('AIChat', { role: 'seller' })");
    expect(sellerDashboardSource).not.toContain("import ChatBot from '../../components/ChatBot'");
    expect(sellerDashboardSource).not.toContain('showAI');
  });

  test('shared route renders the common role-aware ChatBot', () => {
    expect(sharedChatScreenSource).toContain("import ChatBot from '../components/ChatBot'");
    expect(sharedChatScreenSource).toContain('dashboardRole={role}');
  });
});
