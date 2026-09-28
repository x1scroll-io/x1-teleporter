import { Buffer } from 'buffer';
import { BaseMessageSignerWalletAdapter, WalletReadyState, scopePollingDetectionStrategy, type WalletName } from '@solana/wallet-adapter-base';
/** Site-side adapter. Integrators must add it to their picker; importing it does not alter XDEX. */
import { PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import { X1_GENESIS } from '../svmNetworkIds';
export class StarportX1Adapter extends BaseMessageSignerWalletAdapter {
 readonly name='Starport' as WalletName; readonly supportedChains=['x1:mainnet'] as const; readonly url='https://starportwallet.com';
 readonly icon='data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCI+PHJlY3Qgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0IiByeD0iMTQiIGZpbGw9IiMwODE1MjMiLz48ZyBmaWxsPSIjNjVkZmZmIj48cGF0aCBkPSJNMzAuNjM5LDYuMDM2IEEyNiwyNiAwIDAsMCAxNC45NDIsMTIuMzc4IEwxOC4yMjMsMTYuMTUxIEEyMSwyMSAwIDAsMSAzMC45MDEsMTEuMDI5IFoiLz48cGF0aCBkPSJNMTIuMzc4LDE0Ljk0MiBBMjYsMjYgMCAwLDAgMzAuNjM5LDU3Ljk2NCBMMzAuOTAxLDUyLjk3MSBBMjEsMjEgMCAwLDEgMTYuMTUxLDE4LjIyMyBaIi8+PHBhdGggZD0iTTMzLjM2MSw1Ny45NjQgQTI2LDI2IDAgMCwwIDQ5LjA1OCw1MS42MjIgTDQ1Ljc3Nyw0Ny44NDkgQTIxLDIxIDAgMCwxIDMzLjA5OSw1Mi45NzEgWiIvPjxwYXRoIGQ9Ik01MS42MjIsNDkuMDU4IEEyNiwyNiAwIDAsMCAzMy4zNjEsNi4wMzYgTDMzLjA5OSwxMS4wMjkgQTIxLDIxIDAgMCwxIDQ3Ljg0OSw0NS43NzcgWiIvPjxwYXRoIGQ9Ik0zMiAxMiBDMzQgMjcgMzUgMjkgNDggMzIgQzM1IDM0IDM0IDM2IDMyIDUxIEMzMCAzNiAyOSAzNCAxNiAzMiBDMjkgMjkgMzAgMjcgMzIgMTJaIi8+PC9nPjwvc3ZnPg==';
 readonly supportedTransactionVersions=new Set<'legacy'|0>(['legacy',0]);
 connecting=false; publicKey:PublicKey|null=null;

 private provider:any;
 private changed=(addresses:string[])=>{this.publicKey=addresses[0]?new PublicKey(addresses[0]):null;if(this.publicKey)this.emit('connect',this.publicKey);else this.emit('disconnect');};
 private disconnected=()=>this.changed([]);
 get readyState(){return typeof window==='undefined'?WalletReadyState.Unsupported:(window as any).starport?.x1?WalletReadyState.Installed:WalletReadyState.NotDetected;}
 constructor(){super();if(typeof window!=='undefined')scopePollingDetectionStrategy(()=>{if(this.readyState===WalletReadyState.Installed){this.emit('readyStateChange',this.readyState);return true;}return false;});}
 async autoConnect(){return this.open(true);}
 async connect(){return this.open(false);}
 private async open(silent:boolean){
  if(this.connecting)return;
  this.connecting=true;
  try{
   const provider=(window as any).starport?.x1;if(!provider)throw new Error('Install or enable Starport, then refresh this page.');
   const result=await provider.connect({onlyIfTrusted:silent});
   this.unbind();this.provider=provider;provider.on('accountsChanged',this.changed);provider.on('disconnect',this.disconnected);
   this.publicKey=new PublicKey(result.publicKey);this.emit('connect',this.publicKey);
  }finally{this.connecting=false;}
 }
 private unbind(){this.provider?.removeListener('accountsChanged',this.changed);this.provider?.removeListener('disconnect',this.disconnected);}
 async disconnect(){try{await this.provider?.disconnect();}finally{this.unbind();this.provider=null;this.publicKey=null;this.emit('disconnect');}}
 private requireProvider(){if(!this.provider||!this.publicKey)throw new Error('Connect Starport first.');return this.provider;}
 private wire(tx:Transaction|VersionedTransaction){return Buffer.from(tx instanceof Transaction?tx.serialize({requireAllSignatures:false,verifySignatures:false}):tx.serialize()).toString('base64');}
 async signTransaction<T extends Transaction|VersionedTransaction>(tx:T):Promise<T>{
  const signed=await this.requireProvider().signTransaction(this.wire(tx));
  return (tx instanceof Transaction?Transaction.from(Buffer.from(signed,'base64')):VersionedTransaction.deserialize(Buffer.from(signed,'base64'))) as T;
 }
 async signAllTransactions<T extends Transaction|VersionedTransaction>(transactions:T[]):Promise<T[]>{const signed:T[]=[];for(const tx of transactions)signed.push(await this.signTransaction(tx));return signed;}
 async signMessage(message:Uint8Array):Promise<Uint8Array>{return (await this.requireProvider().signMessage(message)).signature;}
 async sendTransaction(tx:Transaction|VersionedTransaction,connection:any,options:any={}):Promise<string>{
  const provider=this.requireProvider();
  if(await connection.getGenesisHash()!==X1_GENESIS)throw new Error('XDEX connection must use X1 mainnet.');
  if(tx instanceof Transaction){
   if(!tx.feePayer)tx.feePayer=this.publicKey!;
   if(!tx.recentBlockhash)tx.recentBlockhash=(await connection.getLatestBlockhash()).blockhash;
   if(options.signers?.length)tx.partialSign(...options.signers);
  }else if(options.signers?.length)tx.sign(options.signers);
  return (await provider.signAndSendTransaction(this.wire(tx))).signature;
 }
}
