const { ethers } = require("hardhat");

async function main() {
  console.log("Deploying ClaraJobNFT to Sequentia...");

  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const balance = await deployer.provider.getBalance(deployer.address);
  console.log("Balance:", ethers.formatEther(balance), "SEQ");

  const ClaraJobNFT = await ethers.getContractFactory("ClaraJobNFT");
  console.log("Deploying...");

  const clara = await ClaraJobNFT.deploy();
  await clara.waitForDeployment();

  const address = await clara.getAddress();
  console.log("ClaraJobNFT deployed to:", address);

  // Verify deployment
  const name = await clara.name();
  const symbol = await clara.symbol();
  const owner = await clara.owner();
  console.log("Name:", name);
  console.log("Symbol:", symbol);
  console.log("Owner:", owner);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });


