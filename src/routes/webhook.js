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
    const { cart, total, ada_amount, ada_price } = req.body;

    if (!cart || !total || !ada_amount || !ada_price) {
      return res.status(400).json({
        error:
          'Missing required fields: cart, total, ada_amount, and ada_price are required',
      });
    }

    // Create draft order
    const draftOrder = await shopify.draftOrder.create({
      line_items: cart.items.map((item) => ({
        variant_id: item.variant_id,
        quantity: item.quantity,
      })),
      note: `Payment pending - ADA Amount: ${ada_amount} (@ $${ada_price} per ADA)`,
      financial_status: 'pending',
    });

    console.log('Draft order:', JSON.stringify(draftOrder, null, 2));
    console.log(`Created draft order: ${draftOrder.id}`);

    res.json({
      success: true,
      order_id: draftOrder.id,
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
  const { order_id, transaction_hash, ada_amount, usd_amount, ada_price } =
    req.body;

  try {
    console.log(`Processing payment for order ${order_id}`);
    console.log(`Transaction hash: ${transaction_hash}`);
    console.log(
      `Amount: ${ada_amount} ADA (@ $${ada_price} per ADA) (${usd_amount} USD)`
    );

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

    // First verify the draft order exists
    let draftOrder;
    try {
      draftOrder = await shopify.draftOrder.get(order_id);
      console.log('Found Shopify draft order:', draftOrder.id);
    } catch (error) {
      console.error('Error fetching Shopify draft order:', error);
      return res.status(404).json({
        error: 'Draft order not found',
        details: `Unable to find draft order ${order_id}`,
      });
    }

    // Complete the draft order
    try {
      const completedOrder = await shopify.draftOrder.complete(order_id);
      console.log('Completed draft order:', completedOrder.id);

      // Update the completed order with payment details
      await shopify.order.update(completedOrder.order_id, {
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
            name: 'ada_price',
            value: ada_price.toString(),
          },
          {
            name: 'usd_amount',
            value: usd_amount.toString(),
          },
        ],
      });

      console.log(
        `Successfully processed payment for order ${completedOrder.order_id}`
      );
      return res.json({
        success: true,
        message: 'Payment verified and order completed',
        order_id: completedOrder.order_id,
        transaction_hash,
      });
    } catch (error) {
      console.error('Error completing draft order:', error);
      return res.status(500).json({
        error: 'Failed to complete draft order',
        details: error.message,
      });
    }
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
