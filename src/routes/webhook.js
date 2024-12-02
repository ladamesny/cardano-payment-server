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
    const { cart, customer } = req.body;

    // Format price as string with 2 decimal places
    const formatPrice = (price) => {
      return (price / 100).toFixed(2);
    };

    // Start with minimal draft order
    const draftOrderPayload = {
      draft_order: {
        line_items: cart.items.map((item) => ({
          title: item.title || 'Product',
          variant_id: parseInt(item.variant_id),
          quantity: parseInt(item.quantity),
          requires_shipping: true,
          price: formatPrice(item.price), // Convert cents to dollars
          applied_discount: {
            value_type: 'fixed_amount',
            value: '0.00',
            amount: '0.00',
            title: 'No Discount',
          },
        })),
        customer: {
          email: customer.email,
          accepts_marketing: false,
        },
        use_customer_default_address: false,
        currency: 'USD',
        taxes_included: false,
        tax_exempt: false,
        presentment_currency: 'USD',
        note_attributes: [
          {
            name: 'source',
            value: 'ada_payment',
          },
        ],
        shipping_line: {
          custom: true,
          title: 'Standard Shipping',
          price: '0.00',
        },
      },
    };

    console.log(
      'Creating draft order with payload:',
      JSON.stringify(draftOrderPayload, null, 2)
    );

    try {
      const draftOrder = await shopify.draftOrder.create(draftOrderPayload);
      console.log('Draft order response:', JSON.stringify(draftOrder, null, 2));

      res.json({
        order_id: draftOrder.id,
        status: 'success',
      });
    } catch (shopifyError) {
      // Try to get the actual error message
      const errorBody = shopifyError.response?.body;
      console.error('Shopify API Error Details:', {
        message: shopifyError.message,
        body: typeof errorBody === 'string' ? JSON.parse(errorBody) : errorBody,
        status: shopifyError.status,
      });
      throw shopifyError;
    }
  } catch (error) {
    console.error('Error in create-draft-order:', error);
    res.status(500).json({
      error: 'Failed to process order',
      details: error.message,
      apiError: error.response?.body,
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
