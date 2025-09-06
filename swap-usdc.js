import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import { readFileSync } from 'fs';

async function swapUSDCtoSOL() {
    const wallet = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync('blondi.json', 'utf8'))));
    const connection = new Connection('https://api.mainnet-beta.solana.com');
    
    console.log('Wallet:', wallet.publicKey.toString());
    
    try {
        const quoteResponse = await fetch(`https://quote-api.jup.ag/v6/quote?inputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&outputMint=So11111111111111111111111111111111111111112&amount=360540619&slippageBps=50`);
        const quoteData = await quoteResponse.json();
        
        console.log('Quote:', quoteData.outAmount / 1e9, 'SOL');
        
        const swapResponse = await fetch('https://quote-api.jup.ag/v6/swap', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                quoteResponse: quoteData,
                userPublicKey: wallet.publicKey.toString(),
                wrapAndUnwrapSol: true,
                dynamicComputeUnitLimit: true,
                prioritizationFeeLamports: 'auto'
            })
        });
        
        const swapData = await swapResponse.json();
        const swapTransactionBuf = Buffer.from(swapData.swapTransaction, 'base64');
        const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
        transaction.sign([wallet]);
        
        const signature = await connection.sendTransaction(transaction);
        console.log('Transaction sent:', signature);
        
        const confirmation = await connection.confirmTransaction(signature);
        console.log('Confirmed:', confirmation);
        
    } catch (error) {
        console.error('Error:', error);
    }
}

swapUSDCtoSOL();
