// FIXTURE for noWindowProbe.test.js — intentionally contains the four banned
// injected-global access patterns so the scanner test can prove the rule
// actually catches them. This file lives OUTSIDE src/ (test/fixtures/) and
// is never imported or executed; it exists only as scanner bait.
const legacyEthereumAccess = window.ethereum;
const legacySolanaAccess = window.solana;
const legacyBitcoinAccess = window.BitcoinProvider;
const legacyTronAccess = window.tronLink;

export {};
