export const X1_CHAIN = 'x1:mainnet'; // Starport integration identifier; not a claim of ecosystem-wide standardization.
export const X1_GENESIS = '4SvBP3omtvcCVWdxq1zBY5cDp4wndjsThb6nEMn6iMdN';
export const X1_CAIP = 'solana:' + X1_GENESIS.slice(0,32);
export const SVM_CHAINS = ['solana:mainnet','solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',X1_CHAIN,X1_CAIP] as const;
export function svmNetwork(chain:unknown):'solana'|'x1' {
 if(chain==='solana:mainnet'||chain==='solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')return 'solana';
 if(chain===X1_CHAIN||chain===X1_CAIP)return 'x1';
 throw Object.assign(new Error('Unsupported SVM network.'),{code:4902});
}
