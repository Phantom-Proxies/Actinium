import express from 'express';
import cors from 'cors';
import path from 'node:path';
import http from 'node:http';
import { hostname } from 'node:os';
import { createBareServer } from '@tomphttp/bare-server-node';
import { uvPath } from '@titaniumnetwork-dev/ultraviolet';

const server = http.createServer();
const app = express(server);
const bareServer = createBareServer('/bare/');
const PORT = 80;
const __dirname = process.cwd();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());
app.use('/uv/', express.static(uvPath));
app.use(express.static(__dirname + '/public'));

app.get('/', (req, res) => {
    res.sendFile(path.join(process.cwd(), '/public/index.html'));
});

server.on('request', (req, res) => {
    if (bareServer.shouldRoute(req)) {
        bareServer.routeRequest(req, res);
    } else {
        app(req, res);
    }
});

server.on('upgrade', (req, socket, head) => {
    if (bareServer.shouldRoute(req)) {
        bareServer.routeUpgrade(req, socket, head);
    } else {
        socket.destroy();
    }
});

server.on('listening', () => {
    const address = server.address();
    console.log(`Proxy running on port ${PORT}`);
});

server.listen({ port: PORT });

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function shutdown() {
    console.log('Stopped or timed out..look in console for more information.');
    server.close();
    bareServer.close();
    process.exit(0);
}
