const { Connection, Keypair, Transaction, SystemProgram, LAMPORTS_PER_SOL, PublicKey, sendAndConfirmTransaction } = require('@solana/web3.js');
const fs = require('fs');

async function sendSOL() {
    try {
        // Load your wallet
        const walletData = JSON.parse(fs.readFileSync('/home/dudesoup/code/mev/wallets/blondi.json', 'utf8'));
        const wallet = Keypair.fromSecretKey(new Uint8Array(walletData));

        console.log('From wallet:', wallet.publicKey.toString());

        // Try multiple RPC endpoints
        const endpoints = [
            'https://api.mainnet-beta.solana.com',
            'https://rpc.ankr.com/solana',
            'https://solana.publicnode.com',
            'https://solana-api.projectserum.com',
            'https://api.mainnet-beta.solana.com'
        ];

        let connection = null;

        for (const endpoint of endpoints) {
            try {
                console.log(`Trying ${endpoint}...`);
                connection = new Connection(endpoint, 'confirmed');

                // Test connection
                await connection.getLatestBlockhash();
                console.log(`✓ Connected to ${endpoint}`);
                break;
            } catch (error) {
                console.log(`✗ ${endpoint} failed:`, error.message);
                continue;
            }
        }

        if (!connection) {
            throw new Error('All RPC endpoints failed');
        }

        // Create transaction
        const transaction = new Transaction().add(
            SystemProgram.transfer({
                fromPubkey: wallet.publicKey,
                toPubkey: new PublicKey('3DUUarpMEKEijz6hCkeXR9RiLBCgrYe6QTpGicqxuXj2'),
                lamports: Math.floor(0.16 * LAMPORTS_PER_SOL)
            })
        );

        console.log('Sending 0.16 SOL...');

        // Send and confirm
        const signature = await sendAndConfirmTransaction(
            connection,
            transaction,
            [wallet],
            {
                commitment: 'confirmed',
                maxRetries: 3
            }
        );

        console.log('✓ Transaction successful!');
        console.log('Signature:', signature);
        console.log('Explorer:', `https://solscan.io/tx/${signature}`);

    } catch (error) {
        console.error('Transfer failed:', error.message);

        if (error.message.includes('timeout') || error.message.includes('ENOTFOUND')) {
            console.log('\n🔧 Network troubleshooting:');
            console.log('1. Try mobile hotspot');
            console.log('2. Check if VPN is interfering');
            console.log('3. Try from Windows Command Prompt instead of WSL');
        }
    }
}

sendSOL();