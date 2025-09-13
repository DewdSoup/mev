const { Connection, Keypair, Transaction, SystemProgram, LAMPORTS_PER_SOL, PublicKey } = require('@solana/web3.js');
const fs = require('fs');

// Copy your blondi.json content here directly since we can't read WSL files from Windows
const walletArray = [/* paste your private key array from blondi.json here */];
const wallet = Keypair.fromSecretKey(new Uint8Array(walletArray));

const connection = new Connection('https://api.mainnet-beta.solana.com');
// ... rest of transaction code