// server.js — Application entry point
const app = require('./src/app');

const PORT = process.env.PORT || 3000;

// Export for serverless environments (Vercel / Lambda)
module.exports = app;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
}