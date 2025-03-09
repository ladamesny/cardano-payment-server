const express = require('express');
const router = express.Router();
const shopify = require('../config/shopify');
const { verifyTransaction } = require('../services/blockfrost');

// Backend URL constant
const BACKEND_URL = 'https://rq-staging-29d53091b9bf.herokuapp.com';

// Parse JSON bodies
router.use(express.json());

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

    // Log the request for debugging
    console.log('Processing draft order request:', {
      headers: req.headers,
      origin: req.headers.origin,
    });

    // Format price as string with 2 decimal places
    const formatPrice = (price) => {
      return (price / 100).toFixed(2);
    };

    // Start with minimal draft order
    const draftOrderPayload = {
      draft_order: {
        line_items: cart.items.map((item) => ({
          variant_id: parseInt(item.variant_id),
          quantity: parseInt(item.quantity),
        })),
        email: customer.email,
        customer: {
          email: customer.email,
          first_name: customer.firstName,
          last_name: customer.lastName,
        },
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

    // Make direct REST API call
    const shopName = process.env.SHOPIFY_SHOP_NAME;
    const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;

    const response = await fetch(
      `https://${shopName}/admin/api/2024-01/draft_orders.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': accessToken,
        },
        body: JSON.stringify(draftOrderPayload),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error('Shopify API Error:', {
        status: response.status,
        statusText: response.statusText,
        data,
      });
      throw new Error(`Shopify API error: ${JSON.stringify(data)}`);
    }

    console.log('Draft order created successfully:', data);

    res.json({
      order_id: data.draft_order.id,
      status: 'success',
    });
  } catch (error) {
    console.error('Error in create-draft-order:', error);
    res.status(500).json({
      error: 'Failed to process order',
      details: error.message,
    });
  }
});

router.get('/callback', async (req, res) => {
  const cod4e = req.query.code;
  console.log('Code: ', code);
  res.send('authorization complete!');
});

// Payment webhook endpoint
router.post('/payment', validatePaymentRequest, async (req, res) => {
  try {
    const { order_id, transaction_hash, ada_amount, usd_amount, ada_price } =
      req.body;

    console.log('Processing payment:', {
      order_id,
      transaction_hash,
      ada_amount,
      usd_amount,
      ada_price,
    });

    // Verify the transaction on blockchain
    console.log('Verifying transaction on blockchain...');
    const { valid, transaction } = await verifyTransaction(
      transaction_hash,
      ada_amount
    );

    if (!valid) {
      console.error('Invalid payment detected:', {
        expected: ada_amount,
        transaction,
      });
      return res
        .status(400)
        .json({ error: 'Invalid payment amount or address' });
    }

    console.log('Transaction verified successfully');

    try {
      console.log('Checking order status in Shopify...');
      const shopName = process.env.SHOPIFY_SHOP_NAME;
      const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;

      // First, check if the draft order exists and its status
      const checkResponse = await fetch(
        `https://${shopName}/admin/api/2024-01/draft_orders/${order_id}.json`,
        {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': accessToken,
          },
        }
      );

      if (!checkResponse.ok) {
        const checkErrorText = await checkResponse.text();
        console.log('Draft order check result:', checkErrorText);

        // Check if this is a "not found" because it's already been converted to a regular order
        // If so, try to find the associated order directly
        if (checkResponse.status === 404) {
          console.log(
            'Draft order not found, may already be converted to order. Proceeding as success.'
          );
          return res.json({
            success: true,
            message: 'Payment verified, order likely already processed',
            transaction_hash,
          });
        }

        return res.status(checkResponse.status).json({
          error: 'Error checking draft order',
          details: checkErrorText,
        });
      }

      const draftOrderData = await checkResponse.json();

      // If the order is already completed/paid, return success rather than error
      if (draftOrderData.draft_order.status === 'completed') {
        console.log('Draft order already completed, returning success');
        return res.json({
          success: true,
          message: 'Order already completed',
          transaction_hash,
          order_id: draftOrderData.draft_order.order_id, // Include the converted order ID if available
        });
      }

      // Only try to complete if not already completed
      console.log('Completing draft order in Shopify...');
      const completeResponse = await fetch(
        `https://${shopName}/admin/api/2024-01/draft_orders/${order_id}/complete.json`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': accessToken,
          },
        }
      );

      // Get response as text first for error handling
      const completeResponseText = await completeResponse.text();

      // Handle "already paid" as success
      if (!completeResponse.ok) {
        console.log('Complete draft order response:', completeResponseText);

        // If order was already paid, treat as success not error
        if (completeResponseText.includes('This order has been paid')) {
          return res.json({
            success: true,
            message: 'Order already paid and completed',
            transaction_hash,
          });
        }

        // If we hit rate limits, tell the client to retry
        if (completeResponseText.includes('rate limit')) {
          return res.status(429).json({
            error: 'Rate limit reached',
            details: 'Please retry after a minute',
            shouldRetry: true,
          });
        }

        throw new Error(
          `Failed to complete draft order: ${completeResponseText}`
        );
      }

      // Parse the successful response
      let completedOrder;
      try {
        completedOrder = JSON.parse(completeResponseText);
      } catch (e) {
        console.error('Failed to parse complete order response:', e);
        return res.json({
          success: true,
          message: 'Order likely completed but response parsing failed',
          transaction_hash,
        });
      }

      // Continue with updating the order with payment details
      if (completedOrder && completedOrder.order && completedOrder.order.id) {
        console.log(
          'Updating order with payment details:',
          completedOrder.order.id
        );

        // Update the order with payment info
        const orderUpdateResponse = await fetch(
          `https://${shopName}/admin/api/2024-01/orders/${completedOrder.order.id}.json`,
          {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              'X-Shopify-Access-Token': accessToken,
            },
            body: JSON.stringify({
              order: {
                id: completedOrder.order.id,
                financial_status: 'paid',
                note: `Paid with Cardano ADA\nTransaction Hash: ${transaction_hash}\nADA Amount: ${ada_amount}\nADA Price: $${ada_price}`,
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
              },
            }),
          }
        );

        if (!orderUpdateResponse.ok) {
          console.warn(
            'Order was completed but metadata update failed. This is not critical.'
          );
        } else {
          console.log('Order updated with payment details successfully');
        }

        return res.json({
          success: true,
          message: 'Payment verified and order completed',
          order_id: completedOrder.order.id,
          transaction_hash,
        });
      } else {
        // Even if we can't get the order ID, still return success
        return res.json({
          success: true,
          message: 'Payment verified and order likely completed',
          transaction_hash,
        });
      }
    } catch (shopifyError) {
      console.error('Shopify API error:', shopifyError);
      throw shopifyError;
    }
  } catch (error) {
    console.error('Payment processing error:', error);
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
