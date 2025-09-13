import { 
  Connection, 
  Keypair, 
  PublicKey, 
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL 
} from '@solana/web3.js';
import { 
  getAssociatedTokenAddress, 
  closeAccount,
  getAccount,
  TokenAccountNotFoundError,
  createCloseAccountInstruction
} from '@solana/spl-token';
import fs from 'fs';
import fetch from 'cross-fetch';

const RPC_URL = 'https://api.mainnet-beta.solana.com';
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
const WALLET_PATH = '/home/dudesoup/code/mev/wallets/blondi.json';

class USDCtoSOLConverter {
  private connection: Connection;
  private wallet: Keypair;
  private walletPublicKey: PublicKey;

  constructor() {
    this.connection = new Connection(RPC_URL, 'confirmed');
    const walletData = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf-8'));
    this.wallet = Keypair.fromSecretKey(new Uint8Array(walletData));
    this.walletPublicKey = this.wallet.publicKey;
    console.log(`Wallet loaded: ${this.walletPublicKey.toBase58()}`);
  }

  async getUSDCBalance(): Promise<number> {
    try {
      const usdcTokenAccount = await getAssociatedTokenAddress(USDC_MINT, this.walletPublicKey);
      const account = await getAccount(this.connection, usdcTokenAccount);
      return Number(account.amount) / 1_000_000;
    } catch (error) {
      if (error instanceof TokenAccountNotFoundError) {
        return 0;
      }
      throw error;
    }
  }

  async executeSwap(): Promise<string> {
    const usdcBalance = await this.getUSDCBalance();
    const amountInSmallestUnit = Math.floor(usdcBalance * 1_000_000);
    
    const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${USDC_MINT.toBase58()}&outputMint=${SOL_MINT.toBase58()}&amount=${amountInSmallestUnit}&slippageBps=100`;
    
    const quoteResponse = await fetch(quoteUrl);
    const quote = await quoteResponse.json();
    
    const swapBody = {
      quoteResponse: quote,
      userPublicKey: this.walletPublicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto'
    };

    const swapResponse = await fetch('https://quote-api.jup.ag/v6/swap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(swapBody)
    });

    const { swapTransaction } = await swapResponse.json();
    const transaction = Transaction.from(Buffer.from(swapTransaction, 'base64'));
    transaction.sign(this.wallet);
    
    return await sendAndConfirmTransaction(this.connection, transaction, [this.wallet]);
  }

  async closeUSDCAccount(): Promise<string | null> {
    try {
      const usdcTokenAccount = await getAssociatedTokenAddress(USDC_MINT, this.walletPublicKey);
      const account = await getAccount(this.connection, usdcTokenAccount);
      
      if (Number(account.amount) < 1000) {
        const closeInstruction = createCloseAccountInstruction(
          usdcTokenAccount,
          this.walletPublicKey,
          this.walletPublicKey
        );
        
        const transaction = new Transaction().add(closeInstruction);
        return await sendAndConfirmTransaction(this.connection, transaction, [this.wallet]);
      }
      return null;
    } catch (error) {
      console.log('Account already closed or does not exist');
      return null;
    }
  }

  async convert(): Promise<void> {
    try {
      const initialSOL = await this.connection.getBalance(this.walletPublicKey);
      const usdcBalance = await this.getUSDCBalance();
      
      console.log(`Initial SOL: ${(initialSOL / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
      console.log(`USDC to convert: ${usdcBalance} USDC`);
      
      if (usdcBalance === 0) {
        console.log('No USDC to convert');
        return;
      }

      console.log('Executing swap...');
      const swapSig = await this.executeSwap();
      console.log(`Swap completed: ${swapSig}`);
      
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      const closeSig = await this.closeUSDCAccount();
      if (closeSig) console.log(`Account closed: ${closeSig}`);
      
      const finalSOL = await this.connection.getBalance(this.walletPublicKey);
      const finalUSDC = await this.getUSDCBalance();
      
      console.log(`\n=== CONVERSION COMPLETE ===`);
      console.log(`Final SOL: ${(finalSOL / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
      console.log(`Final USDC: ${finalUSDC} USDC`);
      console.log(`SOL gained: ${((finalSOL - initialSOL) / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
    } catch (error) {
      console.error('Conversion failed:', error);
    }
  }
}

new USDCtoSOLConverter().convert();
