const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const QRCode = require('qrcode');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const PORT = process.env.PORT || 3210;
const REMOTE_PANEL_URL = process.env.REMOTE_PANEL_URL || 'https://numaramerkezi.com/admin/whatsapp_panel.php?bridge_sync=1&key=wa_sync_nm_2026';
const AUTH_DIR = path.join(__dirname, 'auth_session');

let sock = null;
let connectionState = 'connecting'; // 'connecting' | 'qr_ready' | 'connected' | 'disconnected'
let latestQrDataUrl = null;
let connectedUser = null;
let lastError = null;
let isStarting = false;
let completedQueueBuffer = [];
let isProcessingRemoteTasks = false;

function normalizePhone(raw) {
    let digits = String(raw || '').replace(/[^0-9]/g, '');
    if (digits.startsWith('00')) digits = digits.slice(2);
    if (digits.length === 11 && digits.startsWith('05')) {
        digits = '9' + digits;
    } else if (digits.length === 10 && digits.startsWith('5')) {
        digits = '90' + digits;
    }
    return digits;
}

async function startWhatsApp() {
    if (isStarting) return;
    isStarting = true;

    try {
        if (!fs.existsSync(AUTH_DIR)) {
            fs.mkdirSync(AUTH_DIR, { recursive: true });
        }

        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
        let version = [2, 3000, 1015901307];
        try {
            const vRes = await fetchLatestBaileysVersion();
            if (vRes && vRes.version) version = vRes.version;
        } catch (e) {}

        connectionState = 'connecting';
        sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: true,
            auth: state,
            browser: ['NumaraMerkezi WhatsApp Panel', 'Chrome', '120.0.0'],
            syncFullHistory: false,
            markOnlineOnConnect: false
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                try {
                    latestQrDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
                    connectionState = 'qr_ready';
                    lastError = null;
                    console.log('[WhatsApp] Yeni QR Kod hazir! Panelden veya acilan sayfadan okutabilirsiniz.');
                } catch (err) {
                    console.error('[WhatsApp] QR olusturma hatasi:', err);
                }
            }

            if (connection === 'open') {
                connectionState = 'connected';
                latestQrDataUrl = null;
                lastError = null;
                const rawId = (sock.user && sock.user.id) ? sock.user.id : '';
                const phonePart = rawId.split(':')[0].split('@')[0];
                connectedUser = {
                    id: rawId,
                    phone: phonePart ? ('+' + phonePart) : '+90 539 139 8624',
                    name: (sock.user && sock.user.name) ? sock.user.name : 'WhatsApp Hesabi'
                };
                console.log('[WhatsApp] BAGLANDI:', connectedUser.phone, connectedUser.name);
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                console.log('[WhatsApp] Baglanti kapandi. Kod:', statusCode, 'Yeniden baglan:', shouldReconnect);

                if (statusCode === DisconnectReason.loggedOut) {
                    connectionState = 'disconnected';
                    latestQrDataUrl = null;
                    connectedUser = null;
                    try {
                        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                    } catch (e) {}
                    setTimeout(() => startWhatsApp(), 1500);
                } else if (shouldReconnect) {
                    connectionState = 'connecting';
                    setTimeout(() => startWhatsApp(), 2500);
                } else {
                    connectionState = 'disconnected';
                }
            }
        });
    } catch (err) {
        lastError = err.message || String(err);
        connectionState = 'disconnected';
        console.error('[WhatsApp] Baslatma hatasi:', err);
        setTimeout(() => startWhatsApp(), 4000);
    } finally {
        isStarting = false;
    }
}

async function sendSingleMessage(rawPhone, messageText) {
    if (!sock || connectionState !== 'connected') {
        throw new Error('WhatsApp henuz bagli degil! Lutfen once QR kodu okutun.');
    }
    const cleanPhone = normalizePhone(rawPhone);
    if (cleanPhone.length < 10) {
        throw new Error('Gecersiz telefon numarasi: ' + rawPhone);
    }

    let targetJid = cleanPhone + '@s.whatsapp.net';
    try {
        const [result] = await sock.onWhatsApp(cleanPhone);
        if (result && result.exists && result.jid) {
            targetJid = result.jid;
        } else if (result && result.exists === false) {
            throw new Error('Bu numara WhatsApp kullanmiyor: +' + cleanPhone);
        }
    } catch (checkErr) {
        if (checkErr.message && checkErr.message.includes('kullanmiyor')) {
            throw checkErr;
        }
    }

    const sent = await sock.sendMessage(targetJid, { text: String(messageText) });
    return {
        ok: true,
        phone: cleanPhone,
        messageId: sent?.key?.id || 'sent'
    };
}

// numaramerkezi.com ile HTTPS uzerinden otomatik senkronizasyon
function syncWithRemotePanel() {
    if (!REMOTE_PANEL_URL) return;

    const batchCompleted = completedQueueBuffer.splice(0, 20);
    const payload = JSON.stringify({
        status: connectionState,
        qr: latestQrDataUrl,
        user: connectedUser,
        completed: batchCompleted
    });

    try {
        const parsed = new URL(REMOTE_PANEL_URL);
        const mod = parsed.protocol === 'https:' ? https : http;
        const req = mod.request(parsed, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            },
            timeout: 8000
        }, (res) => {
            let body = '';
            res.on('data', d => body += d.toString());
            res.on('end', async () => {
                try {
                    const resp = JSON.parse(body);
                    if (!resp || !resp.ok) return;

                    if (resp.command === 'restart') {
                        console.log('[Panel Komutu] Yeniden baslatiliyor...');
                        try { if (sock && sock.ws) sock.ws.close(); } catch (e) {}
                        connectionState = 'connecting';
                        setTimeout(() => startWhatsApp(), 800);
                    } else if (resp.command === 'logout') {
                        console.log('[Panel Komutu] Oturum kapatiliyor...');
                        try { if (sock) await sock.logout(); } catch (e) {}
                        try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (e) {}
                        connectionState = 'connecting';
                        latestQrDataUrl = null;
                        connectedUser = null;
                        setTimeout(() => startWhatsApp(), 800);
                    }

                    if (Array.isArray(resp.tasks) && resp.tasks.length > 0 && !isProcessingRemoteTasks) {
                        isProcessingRemoteTasks = true;
                        for (let i = 0; i < resp.tasks.length; i++) {
                            const t = resp.tasks[i];
                            if (i > 0) await new Promise(r => setTimeout(r, 1800));
                            try {
                                const r = await sendSingleMessage(t.phone, t.message);
                                completedQueueBuffer.push({
                                    id: t.id,
                                    status: 'success',
                                    detail: 'Mesaj ID: ' + r.messageId
                                });
                            } catch (err) {
                                completedQueueBuffer.push({
                                    id: t.id,
                                    status: 'failed',
                                    detail: err.message || 'Gonderilemedi'
                                });
                            }
                        }
                        isProcessingRemoteTasks = false;
                    }
                } catch (e) {}
            });
        });

        req.on('error', () => {});
        req.write(payload);
        req.end();
    } catch (e) {}
}

setInterval(syncWithRemotePanel, 2500);

function setCorsHeaders(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
}

function sendJson(res, code, payload) {
    setCorsHeaders(res);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
}

function parseBody(req) {
    return new Promise((resolve) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
            if (body.length > 5 * 1024 * 1024) req.destroy();
        });
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (e) {
                resolve({});
            }
        });
    });
}

const server = http.createServer(async (req, res) => {
    setCorsHeaders(res);

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (url.pathname === '/status' && req.method === 'GET') {
        return sendJson(res, 200, {
            ok: true,
            status: connectionState,
            qr: latestQrDataUrl,
            user: connectedUser,
            error: lastError
        });
    }

    if (url.pathname === '/send' && req.method === 'POST') {
        const body = await parseBody(req);
        const message = String(body.message || '').trim();
        const phones = Array.isArray(body.phones)
            ? body.phones
            : (body.phone ? [body.phone] : []);
        const delayMs = Math.max(300, Math.min(10000, parseInt(body.delayMs || 1200, 10)));

        if (!phones.length || !message) {
            return sendJson(res, 400, {
                ok: false,
                error: 'Alıcı numara ve mesaj içeriği zorunludur.'
            });
        }

        const results = [];
        let okCount = 0;
        let failCount = 0;

        for (let i = 0; i < phones.length; i++) {
            if (i > 0) {
                await new Promise(r => setTimeout(r, delayMs));
            }
            const p = phones[i];
            try {
                const r = await sendSingleMessage(p, message);
                okCount++;
                results.push({ phone: r.phone, status: 'success', detail: 'Mesaj ID: ' + r.messageId });
            } catch (err) {
                failCount++;
                results.push({ phone: normalizePhone(p) || String(p), status: 'failed', detail: err.message || 'Gonderilemedi' });
            }
        }

        return sendJson(res, 200, {
            ok: okCount > 0,
            total: phones.length,
            okCount,
            failCount,
            results
        });
    }

    if (url.pathname === '/logout' && req.method === 'POST') {
        try {
            if (sock) {
                await sock.logout();
            }
        } catch (e) {}
        try {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        } catch (e) {}
        connectionState = 'connecting';
        latestQrDataUrl = null;
        connectedUser = null;
        setTimeout(() => startWhatsApp(), 800);
        return sendJson(res, 200, { ok: true, message: 'Oturum kapatildi, yeni QR kod olusturuluyor.' });
    }

    if (url.pathname === '/restart' && req.method === 'POST') {
        try {
            if (sock && sock.ws) sock.ws.close();
        } catch (e) {}
        connectionState = 'connecting';
        setTimeout(() => startWhatsApp(), 800);
        return sendJson(res, 200, { ok: true, message: 'Yeniden baslatiliyor...' });
    }

    // Tam Kapsamlı Yerel Kontrol & Toplu Mesaj Arayüzü
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>WhatsApp Doğrudan QR & Toplu Mesaj Paneli</title>
<style>
* { box-sizing: border-box; font-family: 'Segoe UI', system-ui, sans-serif; }
body { background:#0f172a; color:#f8fafc; margin:0; padding:1.5rem; }
.container { max-width: 1100px; margin: 0 auto; }
.header { display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:1rem; margin-bottom:1.5rem; padding-bottom:1rem; border-bottom:1px solid #1e293b; }
.header h1 { margin:0; font-size:1.45rem; color:#4ade80; }
.grid { display:grid; grid-template-columns: 1fr 1.2fr; gap:1.5rem; }
@media (max-width: 820px) { .grid { grid-template-columns: 1fr; } }
.card { background:#1e293b; border:1px solid #334155; border-radius:16px; padding:1.5rem; box-shadow:0 10px 25px rgba(0,0,0,0.3); }
.qr-box { background:#0f172a; border:2px dashed #334155; border-radius:12px; padding:1.5rem; text-align:center; min-height:280px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:0.75rem; }
.qr-box img { width:230px; height:230px; border-radius:12px; border:6px solid #fff; background:#fff; }
label { display:block; font-weight:600; font-size:0.9rem; margin-bottom:0.4rem; color:#cbd5e1; }
textarea, select { width:100%; background:#0f172a; border:1px solid #334155; color:#f8fafc; border-radius:10px; padding:0.75rem; font-size:0.92rem; margin-bottom:1rem; outline:none; }
textarea:focus, select:focus { border-color:#25D366; }
.btn { padding:0.75rem 1.2rem; border:none; border-radius:10px; font-weight:700; cursor:pointer; font-size:0.92rem; transition:0.2s; }
.btn-green { background:#25D366; color:#fff; width:100%; font-size:1rem; }
.btn-green:hover { background:#1da851; }
.btn-green:disabled { opacity:0.5; cursor:not-allowed; }
.btn-sec { background:#334155; color:#f8fafc; }
.btn-danger { background:#ef4444; color:#fff; }
.badge { padding:0.3rem 0.8rem; border-radius:99px; font-size:0.8rem; font-weight:700; }
.log-box { margin-top:1rem; max-height:200px; overflow-y:auto; background:#0f172a; border:1px solid #334155; border-radius:10px; padding:0.75rem; font-family:monospace; font-size:0.82rem; }
</style>
</head>
<body>
<div class="container">
    <div class="header">
        <div>
            <h1>WhatsApp Doğrudan QR & Toplu Mesaj Servisi</h1>
            <div style="color:#94a3b8; font-size:0.88rem; margin-top:0.25rem;">Meta API ve Token gerektirmeden +90 539 139 8624 numaranızla doğrudan toplu mesaj gönderin.</div>
        </div>
        <span id="topBadge" class="badge" style="background:#f59e0b; color:#000;">Kontrol Ediliyor...</span>
    </div>

    <div class="grid">
        <div class="card">
            <h3 style="margin-top:0;">1. QR Kod ile Cihaz Bağla</h3>
            <div id="qrWrap" class="qr-box">Yükleniyor...</div>
            <div style="display:flex; gap:0.6rem; margin-top:1rem;">
                <button class="btn btn-sec" style="flex:1;" onclick="restart()">Yeni QR Oluştur</button>
                <button class="btn btn-danger" style="flex:1;" onclick="logout()">Çıkış Yap</button>
            </div>
        </div>

        <div class="card">
            <h3 style="margin-top:0;">2. Doğrudan Toplu Mesaj Gönder</h3>
            <label>Alıcı Numaralar (Alt alta veya virgülle) - <span id="cnt" style="color:#4ade80;">0 Numara</span></label>
            <textarea id="phones" rows="5" placeholder="05321112233&#10;905442223344&#10;+90 555 333 44 55"></textarea>

            <label>Mesaj İçeriği</label>
            <textarea id="msg" rows="4" placeholder="Göndermek istediğiniz mesajı buraya yazın..."></textarea>

            <label>Mesajlar Arası Bekleme Süresi</label>
            <select id="delay">
                <option value="1200">1.2 Saniye (Hızlı)</option>
                <option value="2000" selected>2 Saniye (Önerilen)</option>
                <option value="3500">3.5 Saniye (Güvenli Anti-Spam)</option>
            </select>

            <button id="sendBtn" class="btn btn-green" onclick="sendBulk()">Toplu Gönderimi Başlat</button>
            <div id="logBox" class="log-box" style="display:none;"></div>
        </div>
    </div>
</div>
<script>
function parsePhones(raw) {
    const parts = String(raw || '').split(/[\\r\\n,;]+/);
    const set = new Set();
    parts.forEach(p => {
        let d = p.replace(/[^0-9]/g, '');
        if (d.startsWith('00')) d = d.slice(2);
        if (d.length === 11 && d.startsWith('05')) d = '9' + d;
        else if (d.length === 10 && d.startsWith('5')) d = '90' + d;
        if (d.length >= 10 && d.length <= 15) set.add(d);
    });
    return Array.from(set);
}
document.getElementById('phones').addEventListener('input', function() {
    document.getElementById('cnt').textContent = parsePhones(this.value).length + ' Numara';
});

async function poll() {
    try {
        const r = await fetch('/status');
        const d = await r.json();
        const badge = document.getElementById('topBadge');
        const w = document.getElementById('qrWrap');
        if (d.status === 'connected') {
            badge.style.background = '#22c55e';
            badge.style.color = '#fff';
            badge.textContent = 'Bağlı: ' + (d.user?.phone || '');
            w.innerHTML = '<div style="font-size:3rem;">✅</div><div style="font-size:1.15rem; font-weight:700; color:#4ade80;">WhatsApp Bağlandı!</div><div style="color:#cbd5e1;">' + (d.user?.phone || '') + ' (' + (d.user?.name || '') + ')</div>';
        } else if (d.status === 'qr_ready' && d.qr) {
            badge.style.background = '#f59e0b';
            badge.style.color = '#000';
            badge.textContent = 'QR Okutun';
            w.innerHTML = '<img src="' + d.qr + '" alt="QR"><div style="font-weight:700; margin-top:0.5rem;">Telefondan WhatsApp &gt; Bağlı Cihazlar &gt; Cihaz Bağla ile okutun</div>';
        } else {
            badge.style.background = '#f59e0b';
            badge.textContent = 'QR Hazırlanıyor...';
            w.innerHTML = '<div style="color:#fbbf24; font-weight:600;">QR Kod hazırlanıyor, lütfen birkaç saniye bekleyin...</div>';
        }
    } catch (e) {}
}
async function restart() { await fetch('/restart', {method:'POST'}); setTimeout(poll, 1000); }
async function logout() { if(confirm('Oturum kapatılsın mı?')) { await fetch('/logout', {method:'POST'}); setTimeout(poll, 1000); } }
async function sendBulk() {
    const phones = parsePhones(document.getElementById('phones').value);
    const msg = document.getElementById('msg').value.trim();
    const delay = parseInt(document.getElementById('delay').value || '2000', 10);
    if (!phones.length || !msg) return alert('Lütfen numara ve mesaj girin!');
    const btn = document.getElementById('sendBtn');
    const log = document.getElementById('logBox');
    btn.disabled = true;
    log.style.display = 'block';
    log.innerHTML = 'Gönderim başlatılıyor...<br>';
    let ok = 0, fail = 0;
    for (let i = 0; i < phones.length; i++) {
        if (i > 0) await new Promise(r => setTimeout(r, delay));
        try {
            const res = await fetch('/send', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ phone: phones[i], message: msg })
            });
            const data = await res.json();
            if (data.ok) {
                ok++;
                log.innerHTML += '<span style="color:#4ade80;">[OK] +' + phones[i] + ' iletildi.</span><br>';
            } else {
                fail++;
                log.innerHTML += '<span style="color:#f87171;">[HATA] +' + phones[i] + ': ' + (data.results?.[0]?.detail || data.error) + '</span><br>';
            }
        } catch (e) {
            fail++;
            log.innerHTML += '<span style="color:#f87171;">[HATA] +' + phones[i] + ' bağlantı hatası</span><br>';
        }
        log.scrollTop = log.scrollHeight;
    }
    log.innerHTML += '<strong>Tamamlandı! Başarılı: ' + ok + ', Hatalı: ' + fail + '</strong>';
    btn.disabled = false;
}
setInterval(poll, 2500);
poll();
</script>
</body>
</html>`);
});

server.listen(PORT, '0.0.0.0', () => {
    console.log('====================================================');
    console.log(' WHATSAPP QR KOPRUSU AKTIF: http://localhost:' + PORT);
    console.log(' NumaraMerkezi.com Senkronizasyonu: AKTIF');
    console.log('====================================================');
    startWhatsApp();
});
