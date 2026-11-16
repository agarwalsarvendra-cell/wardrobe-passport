// QuickNode Streams filter: Wardrobe Passport on Arc Testnet.
// Dataset: Block with Receipts. Paste this into the Stream's filter editor.
// Keeps only logs emitted by the marketplace (V3) and protection contracts, in a compact form.
function main(stream) {
  const CONTRACTS = [
    "0xf3ef3709c7d14e5b86b1c9e2b4a37ad97d7b9ccf", // WardrobePassportV3
    "PROTECTION_ADDRESS_LOWERCASE",               // WardrobeProtection: paste its address here, in lowercase
  ];
  const events = [];
  for (const entry of stream.data || []) {
    const blockNumber = entry.block && entry.block.number ? parseInt(entry.block.number, 16) : null;
    const blockTime = entry.block && entry.block.timestamp ? parseInt(entry.block.timestamp, 16) : null;
    for (const receipt of entry.receipts || []) {
      for (const log of receipt.logs || []) {
        const address = (log.address || "").toLowerCase();
        if (!CONTRACTS.includes(address)) continue;
        events.push({
          txHash: log.transactionHash || receipt.transactionHash,
          logIndex: parseInt(log.logIndex, 16),
          blockNumber: blockNumber ?? parseInt(log.blockNumber, 16),
          blockTime,
          address,
          topics: log.topics,
          data: log.data,
        });
      }
    }
  }
  return events.length ? { source: "quicknode-streams", events } : null;
}
