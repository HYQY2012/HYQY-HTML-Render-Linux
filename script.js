const express = require('express');
const { Client } = require('ssh2');
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { exec } = require('child_process');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const upload = multer({ dest: './uploads/' });

app.use(express.json());
app.use(express.static('public'));

let sshClient = null;

app.post('/connect', (req, res) => {
    const { host, port, username, password } = req.body;
    if (sshClient) sshClient.end();
    sshClient = new Client();
    sshClient.connect({ host, port: parseInt(port), username, password, readyTimeout: 10000 });
    sshClient.on('ready', () => res.json({ success: true }));
    sshClient.on('error', (err) => res.json({ success: false, message: err.message }));
});

app.get('/system-info', (req, res) => {
    if (!sshClient) return res.json({});
    sshClient.exec('uptime -p && hostname -I && curl -s icanhazip.com', (err, stream) => {
        let data = '';
        stream.on('data', (chunk) => data += chunk);
        stream.on('close', () => {
            const lines = data.split('\n');
            res.json({
                uptime: lines[0] || '',
                internalIp: lines[1] ? lines[1].trim() : '',
                externalIp: lines[2] ? lines[2].trim() : ''
            });
        });
    });
});

app.get('/system-stats', (req, res) => {
    if (!sshClient) return res.json({ cpu: 0, memory: 0, disk: 0 });
    const cmd = `top -bn1 | grep 'Cpu(s)' | sed 's/.*, *\\([0-9.]*\\)%* id.*/\\1/' | awk '{print 100 - $1}' && free | grep Mem | awk '{print $3/$2 * 100.0}' | cut -d. -f1 && df -h / | grep / | awk '{print $5}' | sed 's/%//g'`;
    sshClient.exec(cmd, (err, stream) => {
        let data = '';
        stream.on('data', (chunk) => data += chunk);
        stream.on('close', () => {
            const lines = data.split('\n');
            res.json({
                cpu: lines[0] || 0,
                memory: lines[1] || 0,
                disk: lines[2] || 0
            });
        });
    });
});

app.post('/files', (req, res) => {
    if (!sshClient) return res.json([]);
    const { path: dirPath } = req.body;
    sshClient.sftp((err, sftp) => {
        sftp.readdir(dirPath, (err, files) => {
            if (err) return res.json([]);
            const result = files.map(file => ({
                name: file.filename,
                type: file.attrs.isDirectory() ? 'directory' : 'file'
            }));
            res.json(result);
        });
    });
});

app.post('/upload-file', upload.single('file'), (req, res) => {
    if (!sshClient) return res.json({ success: false, message: '未连接服务器' });
    const { targetPath } = req.body;
    const localPath = req.file.path;
    const fileName = req.file.originalname;
    const remotePath = path.join(targetPath, fileName);
    const readStream = fs.createReadStream(localPath);
    const writeStream = sshClient.sftp().createWriteStream(remotePath);
    writeStream.on('close', () => {
        fs.unlinkSync(localPath);
        res.json({ success: true, message: '上传成功' });
    });
    writeStream.on('error', (err) => {
        fs.unlinkSync(localPath);
        res.json({ success: false, message: err.message });
    });
    readStream.pipe(writeStream);
});

app.get('/download-file', (req, res) => {
    if (!sshClient) return res.json({ success: false });
    const { filePath } = req.query;
    const readStream = sshClient.sftp().createReadStream(filePath);
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`);
    readStream.pipe(res);
});

app.post('/new-folder', (req, res) => {
    if (!sshClient) return res.json({ success: false });
    const { path: folderPath } = req.body;
    sshClient.exec(`mkdir -p "${folderPath}"`, (err) => {
        if (err) res.json({ success: false, message: err.message });
        else res.json({ success: true, message: '文件夹创建成功' });
    });
});

app.post('/read-file', (req, res) => {
    if (!sshClient) return res.send('');
    const { filePath } = req.body;
    const readStream = sshClient.sftp().createReadStream(filePath);
    let content = '';
    readStream.on('data', (chunk) => content += chunk);
    readStream.on('close', () => res.send(content));
});

app.post('/write-file', (req, res) => {
    if (!sshClient) return res.json({ success: false });
    const { filePath, content } = req.body;
    const writeStream = sshClient.sftp().createWriteStream(filePath);
    writeStream.on('close', () => res.json({ success: true, message: '文件保存成功' }));
    writeStream.on('error', (err) => res.json({ success: false, message: err.message }));
    writeStream.end(content);
});

app.post('/rename-file', (req, res) => {
    if (!sshClient) return res.json({ success: false });
    const { oldPath, newPath } = req.body;
    sshClient.sftp((err, sftp) => {
        sftp.rename(oldPath, newPath, (err) => {
            if (err) res.json({ success: false, message: err.message });
            else res.json({ success: true, message: '重命名成功' });
        });
    });
});

app.post('/copy-file', (req, res) => {
    if (!sshClient) return res.json({ success: false });
    const { srcPath, destPath } = req.body;
    sshClient.exec(`cp "${srcPath}" "${destPath}"`, (err) => {
        if (err) res.json({ success: false, message: err.message });
        else res.json({ success: true, message: '复制成功' });
    });
});

app.post('/move-file', (req, res) => {
    if (!sshClient) return res.json({ success: false });
    const { srcPath, destPath } = req.body;
    sshClient.exec(`mv "${srcPath}" "${destPath}"`, (err) => {
        if (err) res.json({ success: false, message: err.message });
        else res.json({ success: true, message: '移动成功' });
    });
});

app.post('/delete-file', (req, res) => {
    if (!sshClient) return res.json({ success: false });
    const { filePath } = req.body;
    sshClient.exec(`rm -rf "${filePath}"`, (err) => {
        if (err) res.json({ success: false, message: err.message });
        else res.json({ success: true, message: '删除成功' });
    });
});

app.post('/device-action', (req, res) => {
    if (!sshClient) return res.json({ success: false });
    const { action } = req.body;
    let cmd = '';
    if (action === 'restart') cmd = 'shutdown -r now';
    if (action === 'shutdown') cmd = 'shutdown -h now';
    sshClient.exec(cmd, (err) => {
        if (err) res.json({ success: false, message: err.message });
        else res.json({ success: true, message: `${action} 指令已执行` });
    });
});

wss.on('connection', (ws, req) => {
    const params = new URLSearchParams(req.url.slice(1));
    const { host, port, username, password } = Object.fromEntries(params);
    const termClient = new Client();
    termClient.connect({ host, port: parseInt(port), username, password });
    termClient.on('ready', () => {
        termClient.shell((err, stream) => {
            stream.on('data', (data) => ws.send(data.toString()));
            ws.on('message', (data) => stream.write(data));
            ws.on('close', () => termClient.end());
        });
    });
});

server.listen(3000, () => console.log('服务器运行在 http://localhost:3000'));