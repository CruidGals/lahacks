require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { checkSupabaseConnection } = require("./config/db");

const app = express();
const PORT = Number(process.env.PORT || 3001);

app.use(cors());
app.use(express.json());

app.get("/health", async (_req, res) => {
  try {
    await checkSupabaseConnection();
    res.json({ status: "ok", database: "connected", provider: "supabase" });
  } catch (error) {
    res.status(500).json({
      status: "error",
      database: "disconnected",
      provider: "supabase",
      message: error.message,
    });
  }
});

app.get("/", (_req, res) => {
  res.json({ message: "API is running" });
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
