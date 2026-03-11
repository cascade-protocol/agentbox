import { base58 } from "@scure/base";
import {
  type Address,
  address,
  appendTransactionMessageInstructions,
  assertIsSendableTransaction,
  assertIsTransactionWithBlockhashLifetime,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  getTransactionDecoder,
  getTransactionLifetimeConstraintFromCompiledTransactionMessage,
  type Instruction,
  type KeyPairSigner,
  partiallySignTransactionMessageWithSigners,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransaction,
} from "@solana/kit";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN_PROGRAM: Address = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM: Address = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/** Minimum SOL (lamports) required to attempt a swap involving native SOL (wSOL ATA rent + fees). */
export const MIN_SOL_FOR_SWAP_LAMPORTS = 2_500_000n; // ~0.0025 SOL

export class TransactionNotConfirmedError extends Error {
  constructor(public readonly signature: string) {
    super(`Transaction sent but not confirmed: ${signature}`);
    this.name = "TransactionNotConfirmedError";
  }
}

/**
 * Send a signed transaction and wait for confirmation. On timeout, verifies
 * the tx status on-chain before returning. Throws if the tx was not confirmed.
 */
async function sendAndVerify(
  rpcUrl: string,
  signedWithLifetime: Parameters<ReturnType<typeof sendAndConfirmTransactionFactory>>[0],
  signature: string,
): Promise<void> {
  const rpc = createSolanaRpc(rpcUrl);
  const wsUrl = rpcUrl.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
  const rpcSubscriptions = createSolanaRpcSubscriptions(wsUrl);
  const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });

  try {
    await sendAndConfirm(signedWithLifetime, {
      commitment: "confirmed",
      skipPreflight: true,
      abortSignal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    if (!(e instanceof DOMException)) throw e;
    // Timeout: verify if tx actually landed
    const { value } = await rpc
      .getSignatureStatuses([signature as Parameters<typeof rpc.getSignatureStatuses>[0][0]])
      .send();
    const status = value[0];
    if (!status || !status.confirmationStatus) {
      throw new TransactionNotConfirmedError(signature);
    }
    if (status.err) {
      throw new Error(`Transaction failed on-chain: ${JSON.stringify(status.err)}`);
    }
  }
}

/** Derive the Associated Token Account address for a given owner + mint. */
async function findAta(mint: Address, owner: Address): Promise<Address> {
  const encoder = getAddressEncoder();
  const [pda] = await getProgramDerivedAddress({
    programAddress: ASSOCIATED_TOKEN_PROGRAM,
    seeds: [encoder.encode(owner), encoder.encode(TOKEN_PROGRAM), encoder.encode(mint)],
  });
  return pda;
}

/** Build a TransferChecked instruction (SPL Token discriminator = 12). */
function transferCheckedIx(
  source: Address,
  mint: Address,
  destination: Address,
  authority: KeyPairSigner,
  amount: bigint,
  decimals: number,
): Instruction {
  const data = new Uint8Array(1 + 8 + 1);
  data[0] = 12; // TransferChecked discriminator
  new DataView(data.buffer).setBigUint64(1, amount, true);
  data[9] = decimals;
  return {
    programAddress: TOKEN_PROGRAM,
    accounts: [
      { address: source, role: 2 /* writable */ },
      { address: mint, role: 0 /* readonly */ },
      { address: destination, role: 2 /* writable */ },
      { address: authority.address, role: 1 /* readonly signer */ },
    ],
    data,
  };
}

export const SOL_MINT = "So11111111111111111111111111111111111111112";

const JUPITER_QUOTE_URL = "https://lite-api.jup.ag/swap/v1/quote";
const JUPITER_SWAP_URL = "https://lite-api.jup.ag/swap/v1/swap";

const BAGS_API_BASE = "https://public-api-v2.bags.fm/api/v1";
const BAGS_PARTNER_WALLET = "BM4cfeoL9CYsdmPwhrRZ86AK1shEwTBAcQeuZqDNeVfq";
const BAGS_PARTNER_CONFIG = "9eqHvAYh99CpTTa6E3JzaN6BQFrSAMURnK4EkwrL2uT";

export type UsdcBalance = { raw: bigint; ui: string };
export type TokenHolding = { mint: string; amount: string; decimals: number };

export async function getTokenAccounts(rpcUrl: string, owner: string): Promise<TokenHolding[]> {
  const rpc = createSolanaRpc(rpcUrl);
  const { value } = await rpc
    .getTokenAccountsByOwner(
      address(owner),
      { programId: TOKEN_PROGRAM },
      { encoding: "jsonParsed" },
    )
    .send();
  return value
    .map((v) => {
      const info = v.account.data.parsed.info;
      return {
        mint: info.mint as string,
        amount: info.tokenAmount.uiAmountString as string,
        decimals: info.tokenAmount.decimals as number,
      };
    })
    .filter((t) => t.mint !== USDC_MINT && t.amount !== "0");
}

export async function getUsdcBalance(rpcUrl: string, owner: string): Promise<UsdcBalance> {
  const rpc = createSolanaRpc(rpcUrl);
  const { value } = await rpc
    .getTokenAccountsByOwner(
      address(owner),
      { mint: address(USDC_MINT) },
      { encoding: "jsonParsed" },
    )
    .send();
  if (value.length > 0) {
    const ta = value[0].account.data.parsed.info.tokenAmount;
    return {
      raw: BigInt(ta.amount),
      ui: ta.uiAmount !== null ? ta.uiAmount.toFixed(2) : "0.00",
    };
  }
  return { raw: 0n, ui: "0.00" };
}

export async function getSolBalanceLamports(rpcUrl: string, owner: string): Promise<bigint> {
  const rpc = createSolanaRpc(rpcUrl);
  const { value } = await rpc.getBalance(address(owner)).send();
  return value;
}

export async function getSolBalance(rpcUrl: string, owner: string): Promise<string> {
  const lamports = await getSolBalanceLamports(rpcUrl, owner);
  return (Number(lamports) / 1e9).toFixed(4);
}

/**
 * Look up the actual USDC cost of an x402 payment from the on-chain transaction.
 * Compares pre/post token balances for the wallet to find the USDC delta.
 */
export async function getTransactionUsdcCost(
  rpcUrl: string,
  txSignature: string,
  wallet: string,
): Promise<number | null> {
  try {
    const res = await globalThis.fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getTransaction",
        params: [txSignature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }],
      }),
      signal: AbortSignal.timeout(10000),
    });
    const data = (await res.json()) as {
      result?: {
        meta?: {
          preTokenBalances?: Array<{
            mint: string;
            owner: string;
            uiTokenAmount: { uiAmountString: string };
          }>;
          postTokenBalances?: Array<{
            mint: string;
            owner: string;
            uiTokenAmount: { uiAmountString: string };
          }>;
        };
      };
    };
    const meta = data.result?.meta;
    if (!meta?.preTokenBalances || !meta?.postTokenBalances) return null;

    for (const pre of meta.preTokenBalances) {
      if (pre.mint !== USDC_MINT || pre.owner !== wallet) continue;
      const post = meta.postTokenBalances.find((p) => p.mint === USDC_MINT && p.owner === wallet);
      if (!post) continue;
      const preAmt = Number.parseFloat(pre.uiTokenAmount.uiAmountString);
      const postAmt = Number.parseFloat(post.uiTokenAmount.uiAmountString);
      if (preAmt > postAmt) return preAmt - postAmt;
    }
    return null;
  } catch {
    return null;
  }
}

export async function checkAtaExists(rpcUrl: string, owner: string): Promise<boolean> {
  const ata = await findAta(address(USDC_MINT), address(owner));
  const rpc = createSolanaRpc(rpcUrl);
  const { value } = await rpc.getAccountInfo(ata, { encoding: "base64" }).send();
  return value !== null;
}

export async function transferUsdc(
  signer: KeyPairSigner,
  rpcUrl: string,
  dest: string,
  amountRaw: bigint,
): Promise<string> {
  const rpc = createSolanaRpc(rpcUrl);
  const usdcMint = address(USDC_MINT);

  const sourceAta = await findAta(usdcMint, signer.address);
  const destAta = await findAta(usdcMint, address(dest));

  const transferIx = transferCheckedIx(sourceAta, usdcMint, destAta, signer, amountRaw, 6);

  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
  const tx = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(signer.address, m),
    (m) => appendTransactionMessageInstructions([transferIx], m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
  );

  const signed = await partiallySignTransactionMessageWithSigners(tx);
  const encoded = getBase64EncodedWireTransaction(signed);
  return (await rpc.sendTransaction(encoded, { encoding: "base64" }).send()) as string;
}

/**
 * Sign and submit a PumpPortal trade transaction, waiting for confirmation.
 *
 * Uses @solana/kit's sendAndConfirmTransactionFactory (WebSocket + block height)
 * for proper confirmation. Extracts lifetime constraint from the compiled message
 * since decoded external transactions don't carry it (see anza-xyz/kit#918).
 *
 * Trust assumption: PumpPortal's API constructs the transaction and we sign
 * whatever bytes it returns. If their API is compromised, the agent wallet
 * is at risk. Acceptable because agent wallets hold small operational balances.
 */
export async function signAndSendPumpPortalTx(
  signer: KeyPairSigner,
  rpcUrl: string,
  params: Record<string, unknown>,
  extraKeyPairs?: Parameters<typeof signTransaction>[0],
): Promise<string> {
  const response = await globalThis.fetch("https://pumpportal.fun/api/trade-local", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publicKey: signer.address, ...params }),
  });
  if (response.status !== 200) {
    const text = await response.text();
    throw new Error(`PumpPortal error ${response.status}: ${text}`);
  }

  const txBytes = new Uint8Array(await response.arrayBuffer());
  const decoded = getTransactionDecoder().decode(txBytes);
  const compiledMsg = getCompiledTransactionMessageDecoder().decode(decoded.messageBytes);
  const lifetimeConstraint =
    await getTransactionLifetimeConstraintFromCompiledTransactionMessage(compiledMsg);
  const signed = await signTransaction([...(extraKeyPairs ?? []), signer.keyPair], decoded);
  assertIsSendableTransaction(signed);
  const signedWithLifetime = { ...signed, lifetimeConstraint };
  assertIsTransactionWithBlockhashLifetime(signedWithLifetime);

  const signature = getSignatureFromTransaction(signedWithLifetime);
  await sendAndVerify(rpcUrl, signedWithLifetime, signature);
  return signature;
}

// --- Jupiter swap ---

export class JupiterNoRouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JupiterNoRouteError";
  }
}

export async function getTokenDecimals(rpcUrl: string, mint: string): Promise<number> {
  if (mint === SOL_MINT) return 9;
  if (mint === USDC_MINT) return 6;
  const rpc = createSolanaRpc(rpcUrl);
  const { value } = await rpc.getAccountInfo(address(mint), { encoding: "jsonParsed" }).send();
  if (!value) throw new Error(`Token mint not found: ${mint}`);
  const data = value.data as { parsed: { info: { decimals: number } } };
  return data.parsed.info.decimals;
}

/**
 * Swap tokens via Jupiter aggregator. Returns the tx signature and
 * the raw input/output amounts (in smallest units) from the quote.
 *
 * Trust assumption identical to PumpPortal: Jupiter constructs the
 * transaction, we sign whatever it returns. Acceptable for small
 * operational balances.
 */
export async function swapViaJupiter(
  signer: KeyPairSigner,
  rpcUrl: string,
  inputMint: string,
  outputMint: string,
  amountRaw: string,
  slippageBps: number,
): Promise<{ signature: string; inAmount: string; outAmount: string }> {
  const quoteUrl = new URL(JUPITER_QUOTE_URL);
  quoteUrl.searchParams.set("inputMint", inputMint);
  quoteUrl.searchParams.set("outputMint", outputMint);
  quoteUrl.searchParams.set("amount", amountRaw);
  quoteUrl.searchParams.set("slippageBps", String(slippageBps));
  quoteUrl.searchParams.set("restrictIntermediateTokens", "true");

  const quoteRes = await globalThis.fetch(quoteUrl.toString(), {
    signal: AbortSignal.timeout(10_000),
  });
  if (!quoteRes.ok) {
    const body = await quoteRes.json().catch(() => ({}) as Record<string, unknown>);
    const msg = (body as { error?: string }).error || `HTTP ${quoteRes.status}`;
    throw new JupiterNoRouteError(msg);
  }
  const quote = (await quoteRes.json()) as {
    inAmount: string;
    outAmount: string;
    error?: string;
  };
  if (quote.error) throw new JupiterNoRouteError(quote.error);

  const swapRes = await globalThis.fetch(JUPITER_SWAP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: signer.address,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: "auto",
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!swapRes.ok) {
    const text = await swapRes.text();
    throw new Error(`Jupiter swap tx failed: ${swapRes.status} ${text}`);
  }
  const { swapTransaction } = (await swapRes.json()) as { swapTransaction: string };

  const txBytes = new Uint8Array(Buffer.from(swapTransaction, "base64"));
  const decoded = getTransactionDecoder().decode(txBytes);
  const compiledMsg = getCompiledTransactionMessageDecoder().decode(decoded.messageBytes);
  const lifetimeConstraint =
    await getTransactionLifetimeConstraintFromCompiledTransactionMessage(compiledMsg);
  const signed = await signTransaction([signer.keyPair], decoded);
  assertIsSendableTransaction(signed);
  const signedWithLifetime = { ...signed, lifetimeConstraint };
  assertIsTransactionWithBlockhashLifetime(signedWithLifetime);

  const signature = getSignatureFromTransaction(signedWithLifetime);
  await sendAndVerify(rpcUrl, signedWithLifetime, signature);

  return { signature, inAmount: quote.inAmount, outAmount: quote.outAmount };
}

// --- Bags.fm ---

export class BagsNoRouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BagsNoRouteError";
  }
}

/**
 * Sign and submit a Base58-encoded transaction from an external API.
 * Same pattern as signAndSendPumpPortalTx/swapViaJupiter but decodes Base58.
 */
async function signAndSendBase58Tx(
  signer: KeyPairSigner,
  rpcUrl: string,
  base58Tx: string,
): Promise<string> {
  const txBytes = base58.decode(base58Tx);
  const decoded = getTransactionDecoder().decode(txBytes);
  const compiledMsg = getCompiledTransactionMessageDecoder().decode(decoded.messageBytes);
  const lifetimeConstraint =
    await getTransactionLifetimeConstraintFromCompiledTransactionMessage(compiledMsg);
  const signed = await signTransaction([signer.keyPair], decoded);
  assertIsSendableTransaction(signed);
  const signedWithLifetime = { ...signed, lifetimeConstraint };
  assertIsTransactionWithBlockhashLifetime(signedWithLifetime);

  const signature = getSignatureFromTransaction(signedWithLifetime);
  await sendAndVerify(rpcUrl, signedWithLifetime, signature);
  return signature;
}

/**
 * Launch a new token on Bags.fm. Three-step flow:
 * 1. Upload token info (name, symbol, description, image)
 * 2. Create fee share config (with AgentBox partner key for revenue)
 * 3. Create and submit launch transaction
 *
 * Trust assumption identical to PumpPortal/Jupiter: Bags constructs the
 * transaction, we sign whatever it returns.
 */
export async function launchOnBags(
  signer: KeyPairSigner,
  rpcUrl: string,
  apiKey: string,
  params: {
    name: string;
    symbol: string;
    description: string;
    imageBlob: Blob;
    initialBuyLamports: number;
  },
): Promise<{ signature: string; mint: string }> {
  const headers = { "x-api-key": apiKey };

  // Step 1: Create token info
  const form = new FormData();
  form.append("name", params.name);
  form.append("symbol", params.symbol);
  form.append("description", params.description);
  form.append("image", params.imageBlob, "token.png");

  const infoRes = await globalThis.fetch(`${BAGS_API_BASE}/token-launch/create-token-info`, {
    method: "POST",
    headers,
    body: form,
    signal: AbortSignal.timeout(15_000),
  });
  if (!infoRes.ok) {
    const text = await infoRes.text();
    throw new Error(`Bags token info failed: ${infoRes.status} ${text}`);
  }
  const infoData = (await infoRes.json()) as {
    success: boolean;
    response: { tokenMint: string; tokenMetadata: string };
  };
  const mint = infoData.response.tokenMint;
  const ipfs = infoData.response.tokenMetadata;

  // Step 2: Fee share config - agent gets 100%, AgentBox partner earns platform fees
  const feeShareRes = await globalThis.fetch(`${BAGS_API_BASE}/fee-share/config`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      payer: signer.address,
      baseMint: mint,
      claimersArray: [signer.address],
      basisPointsArray: [10000],
      partner: BAGS_PARTNER_WALLET,
      partnerConfig: BAGS_PARTNER_CONFIG,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!feeShareRes.ok) {
    const text = await feeShareRes.text();
    throw new Error(`Bags fee share failed: ${feeShareRes.status} ${text}`);
  }
  const feeShareData = (await feeShareRes.json()) as {
    success: boolean;
    response: {
      needsCreation: boolean;
      meteoraConfigKey: string;
      transactions: Array<{ transaction: string }>;
    };
  };

  // Sign fee share config txs if creation is needed
  if (feeShareData.response.needsCreation) {
    for (const tx of feeShareData.response.transactions) {
      await signAndSendBase58Tx(signer, rpcUrl, tx.transaction);
    }
  }

  // Step 3: Create and submit launch transaction
  const launchRes = await globalThis.fetch(
    `${BAGS_API_BASE}/token-launch/create-launch-transaction`,
    {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        ipfs,
        tokenMint: mint,
        wallet: signer.address,
        initialBuyLamports: params.initialBuyLamports,
        configKey: feeShareData.response.meteoraConfigKey,
      }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!launchRes.ok) {
    const text = await launchRes.text();
    throw new Error(`Bags launch tx failed: ${launchRes.status} ${text}`);
  }
  const launchData = (await launchRes.json()) as { success: boolean; response: string };
  const signature = await signAndSendBase58Tx(signer, rpcUrl, launchData.response);

  return { signature, mint };
}

/**
 * Swap tokens via Bags.fm trade API. For tokens on Meteora DLMM pools.
 */
export async function swapViaBags(
  signer: KeyPairSigner,
  rpcUrl: string,
  apiKey: string,
  inputMint: string,
  outputMint: string,
  amountRaw: string,
  slippageBps: number,
): Promise<{ signature: string; inAmount: string; outAmount: string }> {
  const headers = { "x-api-key": apiKey };

  const quoteUrl = new URL(`${BAGS_API_BASE}/trade/quote`);
  quoteUrl.searchParams.set("baseMint", inputMint);
  quoteUrl.searchParams.set("quoteMint", outputMint);
  quoteUrl.searchParams.set("amount", amountRaw);
  quoteUrl.searchParams.set("swapMode", "ExactIn");
  quoteUrl.searchParams.set("slippageBps", String(slippageBps));

  const quoteRes = await globalThis.fetch(quoteUrl.toString(), {
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  if (!quoteRes.ok) {
    const body = await quoteRes.json().catch(() => ({}) as Record<string, unknown>);
    const msg = (body as { error?: string }).error || `HTTP ${quoteRes.status}`;
    throw new BagsNoRouteError(msg);
  }
  const quoteData = (await quoteRes.json()) as {
    success: boolean;
    response: { inAmount: string; outAmount: string };
  };
  if (!quoteData.success) throw new BagsNoRouteError("quote failed");
  const quote = quoteData.response;

  const swapRes = await globalThis.fetch(`${BAGS_API_BASE}/trade/swap`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: signer.address,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!swapRes.ok) {
    const text = await swapRes.text();
    throw new BagsNoRouteError(`Bags swap failed: ${swapRes.status} ${text}`);
  }
  const swapData = (await swapRes.json()) as {
    success: boolean;
    response: { swapTransaction: string };
  };
  const signature = await signAndSendBase58Tx(signer, rpcUrl, swapData.response.swapTransaction);

  return { signature, inAmount: quote.inAmount, outAmount: quote.outAmount };
}
