const express = require('express');
const cors = require('cors');
const { Client } = require('ssh2');
const WebSocket = require('ws');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());

let sshConn = null;

app.post('/connect', (req, res) => {
    const { host, port, username, password } = req.body;
    const conn = new Client();

    conn.on('ready', () => {
        sshConn = conn;
        res.json({ success: true, message: '连接成功' });
    }).on('error', (err) => {
        res.json({ success: false, message: err.message });
    }).connect({
        host,
        port: parseInt(port),
        username,
        password
    });
});

app.get('/system-info', (req, res) => {
    if (!sshConn) {
        return res.json({ error: '未连接服务器' });
    }

    let uptime = '';
    let internalIp = '';
    let externalIp = '';

    sshConn.exec('uptime -p', (err, stream) => {
        if (err) throw err;
        stream.on('data', (data) => {
            uptime = data.toString().trim();
        }).on('close', () => {
            sshConn.exec("hostname -I | awk '{print $1}'", (err, stream) => {
                if (err) throw err;
                stream.on('data', (data) => {
                    internalIp = data.toString().trim();
                }).on('close', () => {
                    sshConn.exec('curl -s ifconfig.me', (err, stream) => {
                        if (err) throw err;
                        stream.on('data', (data) => {
                            externalIp = data.toString().trim();
                        }).on('close', () => {
                            res.json({ uptime, internalIp, externalIp });
                        });
                    });
                });
            });
        });
    });
});

app.post('/files', (req, res) => {
    if (!sshConn) {
        return res.json({ error: '未连接服务器' });
    }

    const { path } = req.body;
    sshConn.exec(`ls -la ${path} | grep -v '^total'`, (err, stream) => {
        if (err) throw err;
        let data = '';
        stream.on('data', (chunk) => {
            data += chunk;
        }).on('close', () => {
            const lines = data.split('\n').filter(line => line.trim());
            const files = [];

            lines.forEach(line => {
                const parts = line.trim().split(/\s+/);
                const name = parts.slice(8).join(' ');
                if (name === '.' || name === '..') return;
                
                const type = parts[0].startsWith('d') ? 'directory' : 'file';
                files.push({ name, type });
            });

            res.json(files);
        });
    });
});

wss.on('connection', (ws, req) => {
    const params = new URLSearchParams(req.url.slice(10));
    const host = params.get('host');
    const port = params.get('port');
    const username = params.get('username');
    const password = params.get('password');

    const conn = new Client();

    conn.on('ready', () => {
        conn.shell((err, stream) => {
            if (err) {
                ws.send('终端连接失败: ' + err.message);
                return;
            }

            stream.on('data', (data) => {
                ws.send(data.toString());
            }).on('close', () => {
                ws.close();
            });

            ws.on('message', (data) => {
                stream.write(data);
            });

            ws.on('close', () => {
                stream.end();
            });
        });
    }).connect({
        host,
        port: parseInt(port),
        username,
        password
    });
});

server.listen(3000, () => {
    console.log('服务器运行在 http://localhost:3000');
});