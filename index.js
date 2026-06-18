const { app, ensureDatabaseConnection } = require('./app');

const port = process.env.PORT || 4000;
const host = process.env.HOST || '0.0.0.0';

function startServer() {
  const server = app.listen(port, host, () => {
    console.log(`Server listening on ${host}:${port}`);
  });

  server.on('error', error => {
    console.error('HTTP server failed to start:', error.message);
  });

  ensureDatabaseConnection()
    .then(() => {
      console.log('Database connection established.');
    })
    .catch(error => {
      console.error('Database initialization failed:', error.message);
    });
}

startServer();
