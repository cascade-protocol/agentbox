import {
  buildRegistrationFile,
  buildSatiRegistrationEntry,
  createSatiUploader,
  formatCaip10,
  Sati,
  TOKEN_2022_PROGRAM_ADDRESS,
} from "@cascade-fyi/sati-sdk";
import {
  address,
  appendTransactionMessageInstruction,
  assertIsSendableTransaction,
  assertIsTransactionWithBlockhashLifetime,
  createKeyPairSignerFromPrivateKeyBytes,
  createTransactionMessage,
  generateKeyPairSigner,
  type KeyPairSigner,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/connection";
import { instances } from "../db/schema";
import { logger } from "../logger";
import { env } from "./env";
import { satiMintTotal, walletFundingTotal } from "./metrics";

type MintAgentNftInput = {
  ownerWallet: string;
  vmWalletAddress: string;
  instanceName: string;
  hostname: string;
  serverId: number;
};

export type SyncResult = {
  claimed: number;
  recovered: number;
};

type ParsedTokenInfo = {
  mint?: string;
  tokenAmount?: {
    amount?: string;
    decimals?: number;
  };
};

let satiInstance: Sati | null = null;
let hotWalletPromise: Promise<KeyPairSigner> | null = null;

export function getSati(): Sati {
  if (!satiInstance) {
    satiInstance = new Sati({
      network: "mainnet",
      ...(env.SOLANA_RPC_URL && { rpcUrl: env.SOLANA_RPC_URL }),
      transactionConfig: {
        priorityFeeMicroLamports: 50_000,
        maxRetries: 2,
      },
    });
  }

  return satiInstance;
}

export async function getHotWallet(): Promise<KeyPairSigner> {
  if (!env.SATI_HOT_WALLET_PRIVATE_KEY) {
    throw new Error("SATI_HOT_WALLET_PRIVATE_KEY is not configured");
  }

  if (!hotWalletPromise) {
    const rawKey = env.SATI_HOT_WALLET_PRIVATE_KEY;
    hotWalletPromise = (async () => {
      const keyBytes = Uint8Array.from(JSON.parse(rawKey) as number[]);
      const seed = keyBytes.slice(0, 32);
      return createKeyPairSignerFromPrivateKeyBytes(seed);
    })();
  }

  return hotWalletPromise;
}

const VM_WALLET_SOL_FUNDING = 1_000_000n; // 0.001 SOL - enough for several USDC transfers

export async function fundVmWallet(vmWalletAddress: string): Promise<void> {
  const hotWallet = await getHotWallet();
  const sati = getSati();
  const rpc = sati.getRpc();

  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

  const transferIx = getTransferSolInstruction({
    source: hotWallet,
    destination: address(vmWalletAddress),
    amount: VM_WALLET_SOL_FUNDING,
  });

  const tx = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayer(hotWallet.address, tx),
    (tx) => appendTransactionMessageInstruction(transferIx, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
  );

  const signed = await signTransactionMessageWithSigners(tx);
  assertIsSendableTransaction(signed);
  assertIsTransactionWithBlockhashLifetime(signed);
  await sati.getSendAndConfirm()(signed, { commitment: "confirmed" });
  walletFundingTotal.inc({ type: "sol", result: "success" });
  logger.info(`SOL funding confirmed for ${vmWalletAddress} (0.001 SOL)`);
}

const USDC_MINT = address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const USDC_DECIMALS = 6;
const VM_WALLET_USDC_FUNDING = 1_000_000n; // 1 USDC

export async function fundVmWalletUsdc(vmWalletAddress: string): Promise<void> {
  const hotWallet = await getHotWallet();
  const sati = getSati();
  const rpc = sati.getRpc();

  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

  const destOwner = address(vmWalletAddress);

  const [sourceAta] = await findAssociatedTokenPda({
    owner: hotWallet.address,
    mint: USDC_MINT,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });

  const [destAta] = await findAssociatedTokenPda({
    owner: destOwner,
    mint: USDC_MINT,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });

  const createAtaIx = getCreateAssociatedTokenIdempotentInstruction({
    payer: hotWallet,
    ata: destAta,
    owner: destOwner,
    mint: USDC_MINT,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });

  const transferIx = getTransferCheckedInstruction({
    source: sourceAta,
    mint: USDC_MINT,
    destination: destAta,
    authority: hotWallet,
    amount: VM_WALLET_USDC_FUNDING,
    decimals: USDC_DECIMALS,
  });

  const tx = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayer(hotWallet.address, tx),
    (tx) => appendTransactionMessageInstruction(createAtaIx, tx),
    (tx) => appendTransactionMessageInstruction(transferIx, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
  );

  const signed = await signTransactionMessageWithSigners(tx);
  assertIsSendableTransaction(signed);
  assertIsTransactionWithBlockhashLifetime(signed);
  await sati.getSendAndConfirm()(signed, { commitment: "confirmed" });
  walletFundingTotal.inc({ type: "usdc", result: "success" });
  logger.info(`USDC funding confirmed for ${vmWalletAddress} (1 USDC)`);
}

function buildAgentDescription(): string {
  return "Dedicated AI agent gateway powered by OpenClaw and AgentBox. Includes an HTTPS runtime, web terminal access, and a Solana wallet-backed SATI identity.";
}

function buildAgentServices(hostname: string, vmWalletAddress: string) {
  return [
    {
      name: "OASF",
      endpoint: "https://github.com/agntcy/oasf/",
      version: "v0.8.0",
      skills: [
        "natural_language_processing/natural_language_generation/dialogue_generation",
        "tool_interaction/tool_use_planning",
        "agent_orchestration/task_decomposition",
      ],
      domains: [
        "technology/software_engineering/apis_integration",
        "technology/blockchain/blockchain",
      ],
    },
    {
      name: "agentWallet",
      endpoint: formatCaip10(address(vmWalletAddress), "mainnet"),
    },
    {
      name: "web",
      endpoint: `https://${hostname}`,
    },
  ];
}

export async function mintAgentNft(input: MintAgentNftInput): Promise<{ mint: string }> {
  const sati = getSati();
  const hotWallet = await getHotWallet();
  const mintKeypair = await generateKeyPairSigner();

  const registrationFile = buildRegistrationFile({
    name: input.instanceName,
    description: buildAgentDescription(),
    image: `https://api.dicebear.com/9.x/bottts/svg?seed=${input.instanceName}`,
    services: buildAgentServices(input.hostname, input.vmWalletAddress),
    registrations: [buildSatiRegistrationEntry(mintKeypair.address, "mainnet")],
    supportedTrust: ["reputation"],
    active: true,
    x402Support: true,
  });

  const uri = await createSatiUploader().upload(registrationFile);

  // Mint to hot wallet first (avoids on-chain CPI signer issue when owner != payer),
  // then transfer to the actual owner.
  const result = await sati.registerAgent({
    payer: hotWallet,
    name: input.instanceName,
    uri,
    nonTransferable: false,
    mintKeypair,
    additionalMetadata: [{ key: "agentbox:serverId", value: String(input.serverId) }],
  });

  const ownerAddr = address(input.ownerWallet);
  if (ownerAddr !== hotWallet.address) {
    try {
      await sati.transferAgent({
        payer: hotWallet,
        owner: hotWallet,
        mint: result.mint,
        newOwner: ownerAddr,
      });
    } catch (err) {
      logger.error(
        `NFT transfer failed for mint ${result.mint} (owner: ${input.ownerWallet}): ${String(err)}. NFT is in hot wallet - retry via POST /instances/:id/mint will attempt transfer.`,
      );
    }
  }

  satiMintTotal.inc({ result: "success" });
  return { mint: result.mint };
}

type UpdateAgentMetadataInput = {
  mint: string;
  name?: string;
  description?: string;
  hostname: string;
  vmWalletAddress: string;
};

export async function updateAgentMetadataForInstance(
  input: UpdateAgentMetadataInput,
): Promise<void> {
  const sati = getSati();
  const hotWallet = await getHotWallet();
  const mintAddr = address(input.mint);

  const updates: {
    name?: string;
    uri?: string;
    additionalMetadata?: Array<[string, string]>;
  } = {};

  if (input.name !== undefined) {
    updates.name = input.name;
  }

  if (input.description !== undefined) {
    const agentName = input.name ?? input.hostname.split(".")[0] ?? "AgentBox";
    const registrationFile = buildRegistrationFile({
      name: agentName,
      description: input.description,
      image: `https://api.dicebear.com/9.x/bottts/svg?seed=${agentName}`,
      services: buildAgentServices(input.hostname, input.vmWalletAddress),
      registrations: [buildSatiRegistrationEntry(mintAddr, "mainnet")],
      supportedTrust: ["reputation"],
      active: true,
      x402Support: true,
    });

    updates.uri = await createSatiUploader().upload(registrationFile);
  }

  if (!updates.name && !updates.uri) return;

  await sati.updateAgentMetadata({
    payer: hotWallet,
    owner: hotWallet,
    mint: mintAddr,
    updates,
  });
}

async function getOwnedToken2022Mints(walletAddress: string): Promise<string[]> {
  const sati = getSati();
  const owner = address(walletAddress);
  const tokenAccounts = await sati
    .getRpc()
    .getTokenAccountsByOwner(
      owner,
      { programId: TOKEN_2022_PROGRAM_ADDRESS },
      { encoding: "jsonParsed" },
    )
    .send();

  const mints = new Set<string>();
  for (const tokenAccount of tokenAccounts.value) {
    const parsedInfo = (tokenAccount.account.data as { parsed?: { info?: ParsedTokenInfo } })
      ?.parsed?.info;
    if (!parsedInfo?.mint || !parsedInfo.tokenAmount) {
      continue;
    }
    if (parsedInfo.tokenAmount.amount !== "1" || parsedInfo.tokenAmount.decimals !== 0) {
      continue;
    }
    mints.add(parsedInfo.mint);
  }

  return [...mints];
}

export async function syncWalletInstances(walletAddress: string): Promise<SyncResult> {
  const sati = getSati();
  const mints = await getOwnedToken2022Mints(walletAddress);
  if (mints.length === 0) {
    return { claimed: 0, recovered: 0 };
  }

  const matchingRows = await db
    .select({
      id: instances.id,
      nftMint: instances.nftMint,
      ownerWallet: instances.ownerWallet,
    })
    .from(instances)
    .where(inArray(instances.nftMint, mints));

  let claimed = 0;
  for (const row of matchingRows) {
    if (row.ownerWallet === walletAddress) {
      continue;
    }
    await db.update(instances).set({ ownerWallet: walletAddress }).where(eq(instances.id, row.id));
    claimed += 1;
  }

  const knownMints = new Set(
    matchingRows.map((row) => row.nftMint).filter((mint): mint is string => !!mint),
  );
  const unknownMints = mints.filter((mint) => !knownMints.has(mint));

  let recovered = 0;
  for (const mint of unknownMints) {
    let agent = null;
    try {
      agent = await sati.loadAgent(address(mint));
    } catch (err) {
      logger.warn(`Failed to load SATI metadata for mint ${mint}: ${String(err)}`);
      continue;
    }
    if (!agent) {
      continue;
    }

    const serverIdRaw = agent.additionalMetadata["agentbox:serverId"];
    if (!serverIdRaw || !/^\d+$/.test(serverIdRaw)) {
      continue;
    }

    const serverId = Number.parseInt(serverIdRaw, 10);
    if (!Number.isSafeInteger(serverId)) {
      continue;
    }

    const [instance] = await db
      .select({
        id: instances.id,
        ownerWallet: instances.ownerWallet,
        nftMint: instances.nftMint,
      })
      .from(instances)
      .where(eq(instances.id, serverId));

    if (!instance) {
      continue;
    }
    if (instance.nftMint === mint && instance.ownerWallet === walletAddress) {
      continue;
    }

    await db
      .update(instances)
      .set({
        nftMint: mint,
        ownerWallet: walletAddress,
      })
      .where(eq(instances.id, serverId));
    recovered += 1;
  }

  return { claimed, recovered };
}
