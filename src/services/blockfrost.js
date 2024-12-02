require('dotenv').config();
const Blockfrost = require('@blockfrost/blockfrost-js');

// Add validation for required environment variables
if (!process.env.BLOCKFROST_PROJECT_ID) {
  throw new Error('BLOCKFROST_PROJECT_ID environment variable is not set');
}

const blockfrost = new Blockfrost.BlockFrostAPI({
  projectId: process.env.BLOCKFROST_PROJECT_ID,
  network: process.env.CARDANO_NETWORK || 'preview', // Change default to preview if that's your network
});

console.log('Blockfrost Project ID:', process.env.BLOCKFROST_PROJECT_ID);

// Helper function to verify transaction
async function verifyTransaction(txHash, expectedAmount) {
  try {
    console.log(
      `Verifying transaction ${txHash} on network: ${
        process.env.CARDANO_NETWORK || 'preview'
      }`
    );

    // Add retry logic with delay
    let retries = 20;
    let transaction;

    while (retries > 0) {
      try {
        transaction = await blockfrost.txs(txHash);
        break;
      } catch (error) {
        if (error.status_code === 404 && retries > 1) {
          console.log(
            `Transaction not found, retrying in 5 seconds... (${
              retries - 1
            } attempts remaining)`
          );
          await new Promise((resolve) => setTimeout(resolve, 5000));
          retries--;
          continue;
        }
        throw error;
      }
    }

    console.log('Transaction found from Blockfrost:', transaction);

    // Convert ADA to Lovelace
    const lovelaceAmount = Math.floor(expectedAmount * 1000000);

    // Get the transaction UTxOs
    const utxos = await blockfrost.txsUtxos(txHash);
    console.log('Transaction UTXOs:', utxos);

    // Verify the transaction outputs
    const validPayment = utxos.outputs.some(
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
