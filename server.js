require('dotenv').config();
const express = require('express');
const cors = require('cors');
const webhookRoutes = require('./src/routes/webhook');

const app = express();

// Middleware
app.use(express.json());

app.use(
  cors({
    origin: [
      'https://refinedqualities.com',
      'https://d00537-2.myshopify.com',
      'http://localhost:3000',
    ],
    methods: ['GET', 'POST'],
    credentials: false, // Change this to false
    allowedHeaders: ['Content-Type'],
  })
);

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
