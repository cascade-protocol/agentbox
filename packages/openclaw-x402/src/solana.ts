import {
  type Address,
  address,
  appendTransactionMessageInstructions,
  assertIsSendableTransaction,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  getTransactionDecoder,
  type KeyPairSigner,
  partiallySignTransactionMessageWithSigners,
  pipe,
  sendTransactionWithoutConfirmingFactory,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransaction,
} from "@solana/kit";
import { findAssociatedTokenPda, getTransferCheckedInstruction } from "@solana-program/token-2022";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN_PROGRAM: Address = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

export type UsdcBalance = { raw: bigint; ui: string };

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

export async function getSolBalance(rpcUrl: string, owner: string): Promise<string> {
  const rpc = createSolanaRpc(rpcUrl);
  const { value } = await rpc.getBalance(address(owner)).send();
  return (Number(value) / 1e9).toFixed(4);
}

export async function checkAtaExists(rpcUrl: string, owner: string): Promise<boolean> {
  const [ata] = await findAssociatedTokenPda({
    mint: address(USDC_MINT),
    owner: address(owner),
    tokenProgram: TOKEN_PROGRAM,
  });
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

  const [sourceAta] = await findAssociatedTokenPda({
    mint: usdcMint,
    owner: signer.address,
    tokenProgram: TOKEN_PROGRAM,
  });
  const [destAta] = await findAssociatedTokenPda({
    mint: usdcMint,
    owner: address(dest),
    tokenProgram: TOKEN_PROGRAM,
  });

  const transferIx = getTransferCheckedInstruction(
    {
      source: sourceAta,
      mint: usdcMint,
      destination: destAta,
      authority: signer,
      amount: amountRaw,
      decimals: 6,
    },
    { programAddress: TOKEN_PROGRAM },
  );

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
 * Sign and submit a PumpPortal trade transaction.
 *
 * Trust assumption: PumpPortal's API constructs the transaction and we sign
 * whatever bytes it returns. If their API is compromised, the agent wallet
 * is at risk. Acceptable because agent wallets hold small operational balances.
 */
export async function signAndSendPumpPortalTx(
  signer: KeyPairSigner,
  rpcUrl: string,
  params: Record<string, unknown>,
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
  const signed = await signTransaction([signer.keyPair], decoded);
  assertIsSendableTransaction(signed);
  const signature = getSignatureFromTransaction(signed);
  const rpc = createSolanaRpc(rpcUrl);
  const sendTx = sendTransactionWithoutConfirmingFactory({ rpc });
  // skipPreflight: skip simulation for time-sensitive PumpPortal txs.
  // commitment only affects preflight simulation level (unused with skipPreflight)
  // but @solana/kit requires it in the type.
  await sendTx(signed, { commitment: "confirmed", skipPreflight: true });
  return signature;
}
