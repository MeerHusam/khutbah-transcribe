// The public listening site: Express serves the pages, the khutbahs and the admin pages; a
// WebSocket on the same port counts viewers. `npm start`.
//   routes/pages.js   /, /<slug>, the old /index.html?folder= address
//   routes/api.js     /api/*, voice tracks and word times, feedback and engagement
//   routes/admin.js   /admin/* (ADMIN_TOKEN): feedback, traffic, uploads
//   khutbahs.js       the published list (khutbahs.json) and each khutbah's result, cached
//   viewers.js        live / total / unique viewer counts and the visit log
import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { join } from 'path';
import { ROOT, PORT } from './config.js';
import { warmCache } from './khutbahs.js';
import { handleViewer } from './viewers.js';
import pages from './routes/pages.js';
import api from './routes/api.js';
import admin from './routes/admin.js';

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json({ limit: '16kb' }));
app.use(pages);
app.use(express.static(join(ROOT, 'public')));
app.use('/audio_files', express.static(join(ROOT, 'audio_files')));
app.use(api);
app.use(admin);
wss.on('connection', handleViewer);

server.listen(PORT, () => {
  console.log(`KhutbahTranscribe (public read-only) running at http://localhost:${PORT}`);
  warmCache();
});
