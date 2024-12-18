const express = require('express');
const router = express.Router();
const shopify = require('../config/shopify');
const { verifyTransaction } = require('../services/blockfrost');

const validatePaymentRequest = (req, res, next) => {
  // Middleware to validate request body
  const { order_id, transaction_hash, ada_amount } = req.body;

  if (!order_id || !transaction_hash || !ada_amount) {
    return res.status(400).json({
      error:
        'Missing required fields: order_id, transaction_hash, and ada_amount are required',
    });
  }

  next();
};

// Add new draft order endpoint
router.post('/create-draft-order', async (req, res) => {
  try {
    const { cart, total, ada_amount } = req.body;

    if (!cart || !total || !ada_amount) {
      return res.status(400).json({
        error:
          'Missing required fields: cart, total, and ada_amount are required',
      });
    }

    // Create draft order
    const draftOrder = await shopify.draftOrder.create({
      line_items: cart.items.map((item) => ({
        variant_id: item.variant_id,
        quantity: item.quantity,
      })),
      note: `Payment pending - ADA Amount: ${ada_amount}`,
      financial_status: 'pending',
    });

    console.log('Draft order:', JSON.stringify(draftOrder, null, 2));
    console.log(`Created draft order: ${draftOrder.order_number}`);

    res.json({
      success: true,
      order_number: draftOrder.order_number,
    });
  } catch (error) {
    console.error('Error creating draft order:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Payment webhook endpoint
router.post('/payment', validatePaymentRequest, async (req, res) => {
  const { order_id, transaction_hash, ada_amount, usd_amount } = req.body;

  try {
    console.log(`Processing payment for order ${order_id}`);
    console.log(`Transaction hash: ${transaction_hash}`);
    console.log(`Amount: ${ada_amount} ADA (${usd_amount} USD)`);

    // Verify the transaction on blockchain
    const { valid, transaction } = await verifyTransaction(
      transaction_hash,
      ada_amount
    );

    if (!valid) {
      console.error('Invalid payment detected');
      return res
        .status(400)
        .json({ error: 'Invalid payment amount or address' });
    }

    // Update Shopify order
    await shopify.order.update(order_id, {
      financial_status: 'paid',
      note: `Paid with ADA. Transaction: ${transaction_hash}`,
      note_attributes: [
        {
          name: 'cardano_transaction',
          value: transaction_hash,
        },
        {
          name: 'ada_amount',
          value: ada_amount.toString(),
        },
        {
          name: 'usd_amount',
          value: usd_amount.toString(),
        },
      ],
    });

    console.log(`Successfully processed payment for order ${order_id}`);
    res.json({
      success: true,
      message: 'Payment verified and order updated',
      transaction_hash,
    });
  } catch (error) {
    console.error('Payment processing failed:', error);
    res.status(500).json({
      error: 'Payment processing failed',
      details: error.message,
    });
  }
});

// Health check endpoint
router.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

module.exports = router;
