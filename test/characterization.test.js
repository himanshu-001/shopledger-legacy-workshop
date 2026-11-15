var test = require('node:test');
var assert = require('node:assert/strict');

var pricing = require('../lib/pricing');
var inventory = require('../lib/inventory');
var ledger = require('../lib/ledger');
var orders = require('../lib/orders');
var reports = require('../lib/reports');
var invoice = require('../lib/invoice');

test('pricing applies the HSN slab after proportionally allocating coupon discount', function () {
  var result = pricing.computeTotals([
    { id: 1, name: 'Rice', hsn: '1006', price: 1000, qty: 1 }
  ], 'SAVE10');

  assert.equal(result.subtotal, 1000);
  assert.equal(result.discount, 100);
  assert.equal(result.tax, 45);
  assert.equal(result.total, 945);
  assert.equal(result.lines[0].taxable, 900);
});

test('inventory treats reserved units as unavailable and requires one unit to remain', function () {
  var products = [{ id: 1, name: 'Rice', stock: 5, reserved: 2 }];

  assert.equal(inventory.getSellableStock(products[0]), 3);
  assert.deepEqual(inventory.check(products, [{ id: 1, qty: 2 }]), { ok: true });
  assert.equal(inventory.check(products, [{ id: 1, qty: 3 }]).ok, false);
});

test('Khata billing includes opening balance and refuses orders over the credit limit', function () {
  var db = { customers: [{ id: 7, name: 'Asha', openingBalance: 100, totalBilled: 200, totalSettled: 50, creditLimit: 300 }] };

  var rejected = ledger.chargeOrderToKhata(db, 7, 51);
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /credit limit exceeded/i);

  var accepted = ledger.chargeOrderToKhata(db, 7, 50);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.customer.balance, 300);
});

test('cancelling a Khata order changes status and reverses its debit', function () {
  var db = {
    orders: [{ id: 9, status: 'completed', paymentMode: 'khata', customerId: 7, total: 80, items: [] }],
    products: [],
    customers: [{ id: 7, name: 'Asha', openingBalance: 0, totalBilled: 80, totalSettled: 0 }]
  };

  assert.equal(orders.cancel(db, 9, 'customer request').ok, true);
  assert.equal(db.orders[0].status, 'cancelled');
  assert.equal(db.orders[0].cancelReason, 'customer request');
  assert.equal(db.customers[0].totalBilled, 0);
  assert.equal(orders.cancel(db, 9).ok, false);
});

test('dashboard revenue excludes cancelled orders but totalOrders includes them', function () {
  var db = {
    orders: [
      { id: 1, status: 'completed', total: 100, tax: 5, discount: 0 },
      { id: 2, status: 'cancelled', total: 40, tax: 2, discount: 0 }
    ], products: [], customers: []
  };

  var summary = reports.getDashboardSummary(db);
  assert.equal(summary.grossRevenue, 100);
  assert.equal(summary.totalOrders, 2);
  assert.equal(summary.activeOrdersCount, 1);
  assert.equal(summary.cancelledCount, 1);
});

test('invoice figures match the totals charged for an HSN-rated order with a coupon', function () {
  var items = [
    { id: 1, name: 'Rice', hsn: '1006', price: 640, qty: 1 },
    { id: 2, name: 'Sunflower oil', hsn: '1512', price: 190, qty: 2 }
  ];
  var billed = pricing.computeTotals(items, 'SAVE10');
  var invoiceFigures = invoice.computeInvoiceFigures({ items: items, coupon: 'SAVE10' });

  assert.equal(billed.subtotal, 1020);
  assert.equal(billed.discount, 102);
  assert.equal(billed.tax, 45.9);
  assert.equal(billed.total, 963.9);
  assert.equal(invoiceFigures.subtotal, billed.subtotal);
  assert.equal(invoiceFigures.discount, billed.discount);
  assert.equal(invoiceFigures.tax, billed.tax);
  assert.equal(invoiceFigures.total, billed.total);
  assert.deepEqual(invoiceFigures.rows.map(function (row) { return row.gstPercent; }), [5, 5]);
  assert.deepEqual(invoiceFigures.rows.map(function (row) { return row.lineTax; }), [28.8, 17.1]);
});

test('GST reconciliation matches the billed HSN-rated coupon order', function () {
  var items = [
    { id: 1, name: 'Rice', hsn: '1006', price: 640, qty: 1 },
    { id: 2, name: 'Sunflower oil', hsn: '1512', price: 190, qty: 2 }
  ];
  var billed = pricing.computeTotals(items, 'SAVE10');
  var db = {
    orders: [{
      id: 12, date: '2026-11-15', customer: 'Asha', coupon: 'SAVE10',
      subtotal: billed.subtotal, discount: billed.discount,
      tax: billed.tax, total: billed.total, items: items
    }]
  };

  var reconciliation = reports.getGstReconciliation(db);
  assert.equal(reconciliation.totalChecked, 1);
  assert.equal(reconciliation.mismatchCount, 0);
  assert.equal(reconciliation.totalDelta, 0);
  assert.equal(reconciliation.rows[0].invoiceTax, billed.tax);
  assert.equal(reconciliation.rows[0].ledgerTax, billed.tax);
  assert.equal(reconciliation.rows[0].delta, 0);
  assert.equal(reconciliation.rows[0].matched, true);
});

test('invoice applies fractional gstRate using the tax module rate convention', function () {
  var figures = invoice.computeInvoiceFigures({
    items: [{ name: 'Rice', hsn: '1006', price: 100, qty: 1, gstRate: 0.05 }]
  });

  assert.equal(figures.rows[0].gstPercent, 5);
  assert.equal(figures.tax, 5);
  assert.equal(figures.total, 105);
});
