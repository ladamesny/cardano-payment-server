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
      console.log('Completing draft order in Shopify...');
      const shopName = process.env.SHOPIFY_SHOP_NAME;
      const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;

      // First, check if the draft order exists
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
        console.error(
          'Draft order not found or error:',
          await checkResponse.text()
        );
        return res.status(404).json({
          error: 'Draft order not found or error',
          order_id: order_id,
        });
      }

      // Next, complete the draft order
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

      if (!completeResponse.ok) {
        const errorData = await completeResponse.text();
        console.error('Failed to complete draft order:', errorData);
        throw new Error(`Failed to complete draft order: ${errorData}`);
      }

      const completedOrderText = await completeResponse.text();
      console.log('Raw completed order response:', completedOrderText);

      let completedOrder;
      try {
        completedOrder = JSON.parse(completedOrderText);
      } catch (e) {
        console.error('Failed to parse completed order JSON:', e);
        return res.json({
          success: true,
          message: 'Payment verified but could not parse order details',
          transaction_hash,
        });
      }

      // Check if the response has the expected structure
      if (
        !completedOrder ||
        !completedOrder.order ||
        !completedOrder.order.id
      ) {
        console.error(
          'Completed order missing expected structure:',
          completedOrder
        );
        return res.json({
          success: true,
          message: 'Payment verified but order structure invalid',
          transaction_hash,
        });
      }

      console.log(
        'Draft order completed successfully with order ID:',
        completedOrder.order.id
      );

      // Then, update the order with payment details
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
        const errorData = await orderUpdateResponse.text();
        console.error('Failed to update order:', errorData);
        // Even if updating fails, we can return success since the order was created
        return res.json({
          success: true,
          message: 'Order created but failed to update details',
          order_id: completedOrder.order.id,
          transaction_hash,
        });
      }

      const updatedOrder = await orderUpdateResponse.json();
      console.log('Order updated successfully:', updatedOrder);

      return res.json({
        success: true,
        message: 'Payment verified and order completed',
        order_id: completedOrder.order.id,
        transaction_hash,
      });
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
