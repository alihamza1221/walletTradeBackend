import { MongoClient, ServerApiVersion } from "mongodb";
import dotenv from "dotenv";
dotenv.config();
const uri = process.env.MONGODB_URI;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
export const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: false,
  },
});

const state = {
  isConnected: 0,
};
async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    if (state.isConnected) {
      console.log("Already connected to MongoDB");
      return;
    }
    await client.connect();
    state.isConnected = 1;
    // Send a ping to confirm a successful connection
    await client.db("tradewallet").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } catch (err) {
    console.error("Error connecting to MongoDB:", err);
  }
}

run().catch(console.error);
export default run;
