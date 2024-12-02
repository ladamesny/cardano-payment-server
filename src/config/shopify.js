const Shopify = require('shopify-api-node');

if (!process.env.SHOPIFY_SHOP_NAME || !process.env.SHOPIFY_ACCESS_TOKEN) {
  throw new Error('Missing required Shopify environment variables');
}

const shopify = new Shopify({
  shopName: process.env.SHOPIFY_SHOP_NAME,
  accessToken: process.env.SHOPIFY_ACCESS_TOKEN,
  apiVersion: '2024-01',
  autoLimit: true,
});

// Add custom GraphQL method
shopify.graphql = async function (query, variables = {}) {
  try {
    const result = await this.request({
      method: 'POST',
      url: '/admin/api/2024-01/graphql.json',
      data: {
        query,
        variables,
      },
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
      },
    });
    return result.data;
  } catch (error) {
    console.error('GraphQL request failed:', error);
    throw error;
  }
};

module.exports = shopify;
