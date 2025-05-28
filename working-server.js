console.log("🚀 Starting server...");

require("dotenv").config();
console.log("Environment variables loaded");

const express = require("express");
console.log("Express loaded");

const app = express();
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ status: "healthy", message: "Server working!" });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`🔗 Test: http://localhost:${PORT}/health`);
});
