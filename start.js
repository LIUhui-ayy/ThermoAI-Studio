import fs from 'fs';
fs.writeFileSync('minimal_start.log', 'Started at ' + new Date().toISOString());
import { spawn } from 'child_process';

const backend = spawn('sh', ['-c', 'pip3 install -r requirements.txt && python3 -m uvicorn bridge:app --host 0.0.0.0 --port 8081']);
backend.stdout.pipe(process.stdout);
backend.stderr.pipe(process.stderr);

const vite = spawn('npx', ['vite', '--host', '0.0.0.0', '--port', '3000']);
vite.stdout.pipe(process.stdout);
vite.stderr.pipe(process.stderr);
