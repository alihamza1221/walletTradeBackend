import { createPublicClient, http, hexToBigInt, parseUnits } from "viem";

import { bsc } from "viem/chains";
import { GraphQLClient } from "graphql-request";
import {
  SMART_ROUTER_ADDRESSES,
  SwapRouter,
  SmartRouter,
} from "@pancakeswap/smart-router";
import { ERC20Token } from "@pancakeswap/sdk";
import { Native, CurrencyAmount, TradeType, Percent } from "@pancakeswap/sdk";
import { ChainId } from "@pancakeswap/chains";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import db, { client } from "./utils/db.js";

dotenv.config();

BigInt.prototype.toJSON = function () {
  return this.toString();
};

const app = express();

app.use(cors());
app.use(express.json());
const chainId = ChainId.BSC;
const publicClient = createPublicClient({
  chain: bsc,
  transport: http(process.env.QUICKNODE_RPC_URL || ""),
  batch: {
    multicall: {
      batchSize: 1024 * 200,
    },
  },
});

const v3SubgraphClient = new GraphQLClient(
  "https://api.thegraph.com/subgraphs/name/pancakeswap/exchange-v3-bsc"
);
const v2SubgraphClient = new GraphQLClient(
  "https://proxy-worker-api.pancakeswap.com/bsc-exchange"
);

const quoteProvider = SmartRouter.createQuoteProvider({
  onChainProvider: () => publicClient,
});

app.post("/swap", async (req, res) => {
  try {
    const { swapTo, swapFrom, amount, address } = req.body;
    if (!swapTo || !swapFrom || !amount || !address) {
      return res.status(400).json({
        message: "Missing required fields: swapTo, swapFrom, amount, address",
      });
    }

    // Convert to ERC20Token if not native
    const swapFromToken = convertToERC20Token(swapFrom);
    const swapToToken = convertToERC20Token(swapTo);

    const tx = await createSwapTx(swapFromToken, swapToToken, amount, address);

    return res.status(200).json({
      message: "Swap transaction created successfully",
      transaction: tx,
    });
  } catch (error) {
    console.error("Error creating swap transaction:", error);
    return res.status(400).json({
      message: "Error creating swap transaction",
      error: error.message,
    });
  }
});
app.get("/tokens", async (req, res) => {
  try {
    //get cake and native tokne
    const tokens = await getPancakeSwapTokens();
    res.json({
      success: true,
      count: tokens.length,
      tokens: tokens,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/quote", async (req, res) => {
  try {
    let { swapFrom, swapTo, userAmount } = req.body;
    // Validate required fields
    if (!swapFrom || !swapTo || !userAmount) {
      return res.status(400).json({
        message: "Missing required fields",
      });
    }

    const quote = await getQuoteForSwap(swapFrom, swapTo, userAmount);
    return res.status(200).json({
      message: "Quote fetched successfully",
      quote: quote.toExact(),
    });
  } catch (error) {
    console.error("Error fetching quote for swap:", error);
    return res.status(400).json({
      message: "Error fetching quote for swap",
      error: error.message,
    });
  }
});

app.get("/dexTokens", async (req, res) => {
  try {
    // Return the list of tokens
    db();
    const tokens = await client
      .db("tradewallet")
      .collection("tokens")
      .find({})
      .toArray();
    return res.status(200).json({
      message: "Tokens fetched successfully",
      tokens: tokens,
    });
  } catch (error) {
    console.error("Error fetching tokens:", error);
    return res.status(500).json({
      message: "Error fetching tokens",
      error: error.message,
    });
  }
});

app.post("/dexTokens", async (req, res) => {
  try {
    //destructuring could give error if not present
    const { chainId, decimals, symbol, name, usdtPrice } = req.body;

    const isNative = req.body?.isNative || false;
    const address = req.body?.address || "";
    const logoURI = req.body?.logoURI || "";
    if (
      !chainId ||
      !decimals ||
      !symbol ||
      !name ||
      !usdtPrice ||
      (!isNative && !address)
    ) {
      return res.status(400).json({
        message: "Missing required fields",
      });
    }

    // Check if the token already exists
    db();
    const collection = client.db("tradewallet").collection("tokens");
    const existingToken = await collection.findOne({
      symbol: symbol,
    });
    if (existingToken) {
      return res.status(400).json({
        message: "Token with this symbol already exists",
      });
    }

    // Create the new token object
    const newToken = {
      chainId: parseInt(chainId),
      decimals: parseInt(decimals),
      symbol,
      name,
      usdtPrice: usdtPrice,
    };
    if (isNative) {
      newToken.isNative = true;
      newToken.isToken = false;
    } else {
      newToken.isNative = false;
      newToken.isToken = true;
      newToken.address = address;
    }
    if (logoURI) {
      newToken.logoURI = logoURI;
    }
    // Add the new token to the list

    //getQuoteForSwap
    // const quote = await getQuoteForSwap(newToken, newToken, "1");
    // newToken.usdtPrice = quote.toExact();
    const result = await collection.insertOne(newToken);
    if (!result.acknowledged) {
      return res.status(500).json({
        message: "Error adding token to the database",
      });
    }

    return res.status(201).json({
      message: "Token added successfully",
      _id: result.insertedId,
    });
  } catch (error) {
    console.error("Error adding token:", error);
    return res.status(500).json({
      message: "Error adding token",
      error: error.message,
    });
  }
});
app.delete("/dexTokens", async (req, res) => {
  try {
    const { symbol } = req.body;
    if (!symbol) {
      return res.status(400).json({
        message: "Missing required field: symbol",
      });
    }
    db();
    const collection = client.db("tradewallet").collection("tokens");

    const res = await collection.deleteOne({ symbol: symbol });
    if (!res.acknowledged) {
      return res.status(404).json({
        message: "Token not found",
      });
    }
    return res.status(200).json({
      message: "Token deleted successfully",
      count: res.deletedCount,
    });
  } catch (e) {
    console.error("Error deleting token:", e);
    return res.status(500).json({
      message: "Error deleting token",
      error: e.message,
    });
  }
});

app.patch("/dexTokens/:symbol", async (req, res) => {
  try {
    const { symbol } = req.params;
    const updateData = req.body;

    if (!symbol || Object.keys(updateData).length === 0) {
      return res.status(400).json({
        message: "Missing required fields",
      });
    }

    db();
    const collection = client.db("tradewallet").collection("tokens");

    const result = await collection.updateOne(
      { symbol: symbol },
      { $set: updateData }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({
        message: "Token not found",
      });
    }

    return res.status(200).json({
      message: "Token updated successfully",
      count: result.modifiedCount,
    });
  } catch (error) {
    console.error("Error updating token:", error);
    return res.status(500).json({
      message: "Error updating token",
      error: error.message,
    });
  }
});

app.listen(3001, () => {
  console.log("Server is running on port 3001");
});

async function createSwapTx(swapFrom, swapTo, userAmount, address) {
  const [v2Pools, v3Pools] = await Promise.all([
    SmartRouter.getV2CandidatePools({
      onChainProvider: () => publicClient,
      v2SubgraphProvider: () => v2SubgraphClient,
      v3SubgraphProvider: () => v3SubgraphClient,
      currencyA: swapFrom,
      currencyB: swapTo,
    }),
    SmartRouter.getV3CandidatePools({
      onChainProvider: () => publicClient,
      subgraphProvider: () => v3SubgraphClient,
      currencyA: swapFrom,
      currencyB: swapTo,
    }),
  ]);
  const rawAmount = parseUnits(userAmount, swapFrom.decimals);
  const amount = CurrencyAmount.fromRawAmount(swapFrom, rawAmount);
  const trade = await SmartRouter.getBestTrade(
    amount,
    swapTo,
    TradeType.EXACT_INPUT,
    {
      gasPriceWei: () => publicClient.getGasPrice(),
      maxHops: 2,
      maxSplits: 2,
      poolProvider: SmartRouter.createStaticPoolProvider([
        ...v2Pools,
        ...v3Pools,
      ]),
      quoteProvider,
      quoterOptimization: true,
    }
  );

  const routerAddress = SMART_ROUTER_ADDRESSES[chainId];
  const { value, calldata } = SwapRouter.swapCallParameters(trade, {
    recipient: address,
    slippageTolerance: new Percent(1),
  });

  const tx = {
    account: address,
    to: routerAddress,
    data: calldata,
    value: hexToBigInt(value).toString(),
  };

  //const gasEstimate = (await publicClient.estimateGas(tx)).toString();

  //tx.gas = gasEstimate;
  return tx;
}

async function getPancakeSwapTokens() {
  try {
    const tokenLists = [
      "https://tokens.pancakeswap.finance/pancakeswap-top-100.json",
    ];

    const allTokens = [];

    for (const listUrl of tokenLists) {
      const response = await fetch(listUrl);
      const tokenList = await response.json();

      const bscTokens = tokenList.tokens.filter(
        (token) => token.chainId === 56
      );

      allTokens.push(...bscTokens);
    }

    return allTokens;
  } catch (error) {
    console.error("Error fetching PancakeSwap tokens:", error);
    return [];
  }
}

async function getQuoteForSwap(swapFromData, swapToData, userAmount) {
  try {
    const swapFrom = convertToERC20Token(swapFromData);
    const swapTo = convertToERC20Token(swapToData);

    const [v2Pools, v3Pools] = await Promise.all([
      SmartRouter.getV2CandidatePools({
        onChainProvider: () => publicClient,
        v2SubgraphProvider: () => v2SubgraphClient,
        v3SubgraphProvider: () => v3SubgraphClient,
        currencyA: swapFrom,
        currencyB: swapTo,
      }),

      SmartRouter.getV3CandidatePools({
        onChainProvider: () => publicClient,
        subgraphProvider: () => v3SubgraphClient,
        currencyA: swapFrom,
        currencyB: swapTo,
      }),
    ]);

    const rawAmount = parseUnits(userAmount, swapFrom.decimals);
    const amount = CurrencyAmount.fromRawAmount(swapFrom, rawAmount);

    const trade = await SmartRouter.getBestTrade(
      amount,
      swapTo,
      TradeType.EXACT_INPUT,
      {
        gasPriceWei: () => publicClient.getGasPrice(),
        maxHops: 2,
        maxSplits: 2,
        poolProvider: SmartRouter.createStaticPoolProvider([
          ...v2Pools,
          ...v3Pools,
        ]),
        quoteProvider,
        quoterOptimization: true,
      }
    );
    return trade.outputAmount;
  } catch (error) {
    console.error("Error fetching quote for swap:", error);
    throw error;
  }
}

function convertToERC20Token(token) {
  return token.isNative
    ? Native.onChain(token.chainId)
    : new ERC20Token(
        token.chainId,
        token.address,
        token.decimals,
        token.symbol,
        token.name
      );
}
