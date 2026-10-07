import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    return {
      server: {
        port: 3000,
        host: '0.0.0.0',
        proxy: {
          '/download-artifact': { target: 'http://127.0.0.1:8081', changeOrigin: true },
          '/run-mcmc': { target: 'http://127.0.0.1:8081', changeOrigin: true, secure: false, configure: (proxy, _options) => { proxy.removeAllListeners('error'); proxy.on('error', (err, _req, res) => { if ('writeHead' in res && !res.headersSent) { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Proxy error', message: err.message })); } }); } },
          '/abort-mcmc': { target: 'http://127.0.0.1:8081', changeOrigin: true, secure: false, configure: (proxy, _options) => { proxy.removeAllListeners('error'); proxy.on('error', (err, _req, res) => { if ('writeHead' in res && !res.headersSent) { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Proxy error', message: err.message })); } }); } },
          '/validate-mcmc': { target: 'http://127.0.0.1:8081', changeOrigin: true, secure: false, configure: (proxy, _options) => { proxy.removeAllListeners('error'); proxy.on('error', (err, _req, res) => { if ('writeHead' in res && !res.headersSent) { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Proxy error', message: err.message })); } }); } },
          '/analyze-mcmc': { target: 'http://127.0.0.1:8081', changeOrigin: true, secure: false, configure: (proxy, _options) => { proxy.removeAllListeners('error'); proxy.on('error', (err, _req, res) => { if ('writeHead' in res && !res.headersSent) { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Proxy error', message: err.message })); } }); } },
          '/stream-mcmc': { target: 'http://127.0.0.1:8081', changeOrigin: true, secure: false, configure: (proxy, _options) => { proxy.removeAllListeners('error'); proxy.on('error', (err, _req, res) => { if ('writeHead' in res && !res.headersSent) { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Proxy error', message: err.message })); } }); } },
          '/analysis': { target: 'http://127.0.0.1:8081', changeOrigin: true, secure: false, configure: (proxy, _options) => { proxy.removeAllListeners('error'); proxy.on('error', (err, _req, res) => { if ('writeHead' in res && !res.headersSent) { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Proxy error', message: err.message })); } }); } },
          '/run-espei': { target: 'http://127.0.0.1:8081', changeOrigin: true, secure: false, configure: (proxy, _options) => { proxy.removeAllListeners('error'); proxy.on('error', (err, _req, res) => { if ('writeHead' in res && !res.headersSent) { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Proxy error', message: err.message })); } }); } },
          '/plot-property': { target: 'http://127.0.0.1:8081', changeOrigin: true, secure: false, configure: (proxy, _options) => { proxy.removeAllListeners('error'); proxy.on('error', (err, _req, res) => { if ('writeHead' in res && !res.headersSent) { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Proxy error', message: err.message })); } }); } },
          '/plot-uncertainty': { target: 'http://127.0.0.1:8081', changeOrigin: true, secure: false, configure: (proxy, _options) => { proxy.removeAllListeners('error'); proxy.on('error', (err, _req, res) => { if ('writeHead' in res && !res.headersSent) { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Proxy error', message: err.message })); } }); } },
          '/run-adv-opt': { target: 'http://127.0.0.1:8081', changeOrigin: true, secure: false },
          '/stop-adv-opt': { target: 'http://127.0.0.1:8081', changeOrigin: true, secure: false },
          '/stream-adv-opt': { target: 'http://127.0.0.1:8081', changeOrigin: true, secure: false },
          '/extract-best-adv-opt': { target: 'http://127.0.0.1:8081', changeOrigin: true, secure: false },
          '/commit-adv-opt': { target: 'http://127.0.0.1:8081', changeOrigin: true, secure: false },
        }
      },
      plugins: [react()],
      define: {
        'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
        'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY)
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
