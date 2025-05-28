console.log("🚀 Starting simple server...");

const express = require("express");
const app = express();

app.get("/health", (req, res) => {
  res.json({ 
    status: "healthy", 
    message: "Server is working!",
    timestamp: new Date().toISOString()
  });
});

app.get("/test", (req, res) => {
  res.json({ message: "Hello from Rodeo!" });
});

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`✅ Simple server running on port ${PORT}`);
  console.log(`🔗 Test it: http://localhost:${PORT}/test`);
});
