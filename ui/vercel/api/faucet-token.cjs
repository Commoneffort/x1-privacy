// Mock USDC.x faucet (testnet).
const { faucetHandler } = require("./_faucet.cjs");
module.exports = faucetHandler("cUSDC.x", process.env.FAUCET_TOKEN || "5000");
