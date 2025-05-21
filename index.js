import express from 'express';
import cors from 'cors';
import path from 'node:path';
import http from 'node:http';
import { createBareServer } from "@tomphttp/bare-server-node";
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const server = http.createServer();
const app = express(server);
const bareServer = createBareServer('/bare/');
const PORT = 80;

async function startServer() {
  try {
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use(cors());

    app.use("/uv", express.static(path.join(__dirname, '/@')));
    app.use(express.static(path.join(__dirname, '/public')));

    app.get('/', (req, res) => {
      try {
        res.sendFile(path.join(__dirname, '/public/index.html'));
      } catch {
        res.status(500).end();
      }
    });

    server.on('request', (req, res) => {
      try {
        if (bareServer.shouldRoute(req)) {
          bareServer.routeRequest(req, res);
        } else {
          app(req, res);
        }
      } catch {}
    });

    server.on('upgrade', (req, socket, head) => {
      try {
        bareServer.routeUpgrade(req, socket, head);
      } catch {}
    });

    server.on('listening', () => {
      console.log(`Listening on port ${PORT}.`);
    });

    server.listen({ port: PORT });
  } catch {}
}

function shutdown() {
  try {
    server.close();
    bareServer.close();
  } catch {}
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

startServer();
