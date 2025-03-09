const express = require('express');
const router = express.Router();
const shopify = require('../config/shopify');
const { verifyTransaction } = require('../services/blockfrost');
const cors = require('cors');

// Backend URL constant
// const BACKEND_URL = 'https://rq-backend-1a4371619f22.herokuapp.com';
const BACKEND_URL = 'https://rq-staging-29d53091b9bf.herokuapp.com';

// Debug middleware to log all requests
router.use((req, res, next) => {
  console.log('Incoming request:', {
    method: req.method,
    path: req.path,
    origin: req.headers.origin,
    headers: req.headers,
  });
  next();
});

// CORS configuration
const corsOptions = {
  origin: function (origin, callback) {
    console.log('Request origin:', origin);

    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) {
      console.log('No origin provided');
      return callback(null, true);
    }

    const allowedOrigins = [
      'https://staging-rq.myshopify.com',
      'https://checkout.shopify.com',
      'https://staging-rq.myshopify.com/pages/cardano-checkout',
    ];

    if (allowedOrigins.includes(origin) || origin.endsWith('.myshopify.com')) {
      console.log('Origin allowed:', origin);
      callback(null, true);
    } else {
      console.log('Origin not allowed:', origin);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Accept', 'Origin', 'X-Requested-With'],
  exposedHeaders: ['Access-Control-Allow-Origin'],
  maxAge: 86400,
  optionsSuccessStatus: 200,
};

// Apply CORS middleware first
router.use(cors(corsOptions));

// Parse JSON bodies after CORS
router.use(express.json());

// Add response headers middleware
router.use((req, res, next) => {
  // Ensure CORS headers are present on all responses
  res.header('Access-Control-Allow-Credentials', 'true');
  next();
});

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
  const {
    order_id,
    transaction_hash,
    ada_amount,
    usd_amount,
    ada_price,
    shipping_cost,
  } = req.body;

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

    // Update the order with payment details including shipping
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
        {
          name: 'shipping_cost',
          value: shipping_cost.toString(),
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
