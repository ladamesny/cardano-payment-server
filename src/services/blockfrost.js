const { BlockFrostAPI } = require('@blockfrost/blockfrost-js');

const blockfrost = new BlockFrostAPI({
  projectId: process.env.BLOCKFROST_PROJECT_ID,
  network: 'mainnet', // or 'preprod' for testnet
});

// Helper function to verify transaction
async function verifyTransaction(txHash, expectedAmount) {
  try {
    const transaction = await blockfrost.txs(txHash);

    // Convert ADA to Lovelace
    const lovelaceAmount = Math.floor(expectedAmount * 1000000);

    // Verify the transaction outputs
    const validPayment = transaction.outputs.some(
      (output) =>
        output.address === process.env.CARDANO_WALLET_ADDRESS &&
        output.amount.find((amt) => amt.unit === 'lovelace')?.quantity >=
          lovelaceAmount
    );

    return {
      valid: validPayment,
      transaction,
    };
  } catch (error) {
    console.error('Blockfrost verification error:', error);
    throw new Error('Transaction verification failed');
  }
}

module.exports = {
  blockfrost,
  verifyTransaction,
};
