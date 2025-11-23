const Client = require("@triton-one/yellowstone-grpc").default;
const { CommitmentLevel } = require("@triton-one/yellowstone-grpc");

async function main() {
    // Connect to your Server
    const client = new Client("http://192.168.0.91:10000", undefined, {});

    try {
        console.log("🔌 Connecting to Threadripper...");
        const stream = await client.subscribe();

        // Listen for ANY data
        stream.on("data", (data) => {
            console.log("✅ SUCCESS! Geyser is streaming.");
            console.log("📦 Sample Data (Slot):", data.slot);
            process.exit(0);
        });

        stream.on("error", (err) => {
            console.error("❌ Stream Error:", err);
            process.exit(1);
        });

        // Request Slot Updates (Simplest possible request)
        await new Promise((resolve, reject) => {
            stream.write({
                slots: { "test_slot": {} },
                accounts: {},
                transactions: {},
                transactionsStatus: {}, // must be defined or serializer blows up
                blocks: {},
                blocksMeta: {},
                entry: {},
                accountsDataSlice: [],
                commitment: CommitmentLevel.PROCESSED
            }, (err) => err ? reject(err) : resolve());
        });

    } catch (e) {
        console.error("❌ Connection Failed:", e.message);
        console.error("👉 Check: Is Port 10000 open? Is the IP 192.168.0.91 correct?");
    }
}

main();
