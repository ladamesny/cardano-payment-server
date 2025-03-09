require('dotenv').config();
const express = require('express');
const cors = require('cors');
const webhookRoutes = require('./src/routes/webhook');

const app = express();

// Debug middleware to log all requests
app.use((req, res, next) => {
  console.log('Incoming request:', {
    method: req.method,
    path: req.path,
    origin: req.headers.origin,
    headers: req.headers,
  });
  next();
});

// CORS configuration
app.use(
  cors({
    origin: ['https://staging-rq.myshopify.com', 'http://localhost:3000'],
    methods: ['GET', 'POST', 'OPTIONS'],
    credentials: true,
    allowedHeaders: ['Content-Type', 'Accept', 'Origin'],
    optionsSuccessStatus: 200,
  })
);

// Body parsing middleware
app.use(express.json());

// Routes
app.use('/webhook', webhookRoutes);

// Basic error handling
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Webhook endpoint: http://localhost:${PORT}/webhook/payment`);
});
