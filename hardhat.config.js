require("@nomicfoundation/hardhat-toolbox");

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.19",  // CRITICAL: Max 0.8.19 for Sequentia (no PUSH0)
    settings: {
      optimizer: {
        enabled: true,
        runs: 200
      }
    }
  },
  networks: {
    sequentia: {
      url: "http://54.226.180.9:8545",
      chainId: 15132025,
      accounts: [
        "0xfaa9148191dfcb99dc713f2652315b09df590a59e07c78a8d59c288d7f4a5013"
      ],
      gas: 5000000,
      gasPrice: 0
    }
  }
};
