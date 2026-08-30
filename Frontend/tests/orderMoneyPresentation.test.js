import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const readSource = (relativePath) => readFileSync(
  new URL(relativePath, import.meta.url),
  'utf8',
);

test('buyer and seller order details render authoritative frozen line money', () => {
  const sellerDetail = readSource('../src/components/layout/OrderDetail.jsx');
  const buyerDetail = readSource('../src/components/layout/UserOrderDetail.jsx');
  const buyerGroups = readSource('../src/components/order/BuyerSellerFulfillmentGroups.jsx');

  for (const source of [sellerDetail, buyerDetail]) {
    assert.match(source, /getExactOrderItemUnitAmount\(item\)/);
    assert.match(source, /Complete frozen line price/);
    assert.doesNotMatch(source, /orderMoney\(item\.price\)/);
  }
  assert.match(buyerGroups, /getExactOrderItemUnitAmount\(item\)/);
  assert.match(buyerGroups, /formatMoney\(exactUnitAmount\)/);
  assert.doesNotMatch(buyerGroups, /formatMoney\(item\.price\)/);
});

test('cart and checkout cards use the same exact line-unit allocation as settlement', () => {
  const cart = readSource('../src/components/common/CartDropdown.jsx');
  const checkout = readSource('../src/components/layout/Checkout.jsx');

  assert.match(cart, /getExactLineUnitAmount\(lineTotal, qty\)/);
  assert.match(checkout, /getExactLineUnitAmount\(itemLineTotal, qty\)/);
  assert.match(checkout, /Complete line:/);
});

test('admin order cancellation runs directly without a confirmation popup', () => {
  const orderDetail = readSource('../src/components/layout/OrderDetail.jsx');

  assert.match(orderDetail, /onClick=\{handleCancelOrder\}/);
  assert.match(orderDetail, /isCancelling \? 'Cancelling\.\.\.' : 'Cancel Order'/);
  assert.doesNotMatch(orderDetail, /showCancelConfirm/);
  assert.doesNotMatch(orderDetail, /Keep Order/);
  assert.doesNotMatch(orderDetail, /Are you sure\? This action cannot be undone\./);
});
