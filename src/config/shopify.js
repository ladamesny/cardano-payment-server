const Shopify = require('shopify-api-node');

const shopify = new Shopify({
  shopName: process.env.SHOP_NAME,
  accessToken: process.env.SHOPIFY_ACCESS_TOKEN,
  apiVersion: '2024-01', // Use the latest API version
});

// Add GraphQL support
shopify.graphql = async function (query, variables = {}) {
  const response = await this.request({
    method: 'POST',
    url: '/admin/api/2024-01/graphql.json',
    data: {
      query,
      variables,
    },
  });
  return response.data.data;
};

module.exports = shopify;
