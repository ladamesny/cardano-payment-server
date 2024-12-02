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
    const { cart, total, ada_amount, ada_price, customer } = req.body;

    // Create a minimal draft order first
    const draftOrderPayload = {
      draft_order: {
        line_items: cart.items.map((item) => ({
          variant_id: parseInt(item.variant_id),
          quantity: parseInt(item.quantity),
        })),
        email: customer.email,
        shipping_address: {
          first_name: customer.firstName,
          last_name: customer.lastName,
          address1: customer.address1,
          address2: customer.address2 || '',
          city: customer.city,
          province: customer.state,
          zip: customer.zip,
          country_code: 'US',
          phone: customer.phone,
        },
      },
    };

    console.log(
      'Creating draft order with payload:',
      JSON.stringify(draftOrderPayload, null, 2)
    );

    try {
      const draftOrder = await shopify.draftOrder.create(draftOrderPayload);
      console.log('Draft order created successfully:', draftOrder);

      // Now update the draft order with additional details
      const updatePayload = {
        note_attributes: [
          { name: 'wallet_address', value: customer.walletAddress },
          { name: 'ada_amount', value: ada_amount.toString() },
          { name: 'ada_price', value: ada_price.toString() },
        ],
        tags: ['ADA Payment'],
      };

      const updatedOrder = await shopify.draftOrder.update(
        draftOrder.id,
        updatePayload
      );
      console.log('Draft order updated successfully:', updatedOrder);

      res.json({
        order_id: draftOrder.id,
        status: 'success',
      });
    } catch (shopifyError) {
      console.error('Shopify API Error:', {
        message: shopifyError.message,
        response: shopifyError.response?.data,
        status: shopifyError.response?.status,
        statusText: shopifyError.response?.statusText,
      });

      throw shopifyError;
    }
  } catch (error) {
    console.error('Error in create-draft-order:', error);
    res.status(500).json({
      error: 'Failed to process order',
      details: error.message,
      apiError: error.response?.data,
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

    // Complete the draft order
    const completedOrder = await shopify.draftOrder.complete(order_id);
    console.log('Completed draft order:', completedOrder.id);

    // Update the order with payment details
    const updatedOrder = await shopify.order.update(completedOrder.order_id, {
      financial_status: 'paid',
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
      tags: ['ADA Payment', 'Cardano'],
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
