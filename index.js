import express from 'express';
import cors from 'cors';
import path from 'node:path';
import http from 'node:http';
import { createBareServer } from "@tomphttp/bare-server-node";
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const server = http.createServer();
const app = express(server);
const bareServer = createBareServer('/bare/');
const PORT = 80;

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

async function promptForSubdomains() {
	console.log("Pseudo-Subdomains are simulated and temporary subdomains that don't show up on DNS records.")
	console.log("Press Enter immediately to skip pseudo-subdomains")
  const subdomains = [];

  async function ask() {
    return new Promise((resolve) => {
      rl.question('Enter a pseudo-subdomain or press Enter to finish: ', (answer) => {
        if (answer.trim()) {
          subdomains.push(answer.trim());
          resolve(true);
        } else {
          resolve(false);
        }
      });
    });
  }

  while (await ask()) {}
  rl.close();
  return subdomains;
}

function subdomainMiddleware(subdomains) {
  return async (req, res, next) => {
    try {
      const host = req.headers.host || '';
      const subdomain = host.split('.')[0];

      if (subdomains.length > 0) {
        if (subdomains.includes(subdomain)) {

          next();
        } else {

          res.sendFile(path.join(__dirname, '/public/fake-index.html'));
        }
      } else {

        next();
      }
    } catch {
      next();
    }
  };
}

async function startServer() {
  try {
    const subdomains = await promptForSubdomains();

    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use(cors());

    app.use(subdomainMiddleware(subdomains));

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
