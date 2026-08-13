const { default: makeWASocket, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const QRCode = require('qrcode');
const { useRemoteAuthState } = require('./remoteAuth');

const sessions = {};
const qrCodes = {};
const statuses = {};

const initializeSession = async (sessionId) => {
    if (sessions[sessionId]) {
        console.log(`Session ${sessionId} is already running.`);
        return sessions[sessionId];
    }

    console.log(`Initializing Baileys session ${sessionId}...`);
    statuses[sessionId] = 'pending';

    const { state, saveCreds, clearState } = await useRemoteAuthState(sessionId);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        browser: ['Hostinger Panel', 'Chrome', '1.0.0']
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log(`QR Code received for ${sessionId}`);
            // QR'i base64 data URI'ye çevirip PHP frontend'ine gönderilebilir hale getiriyoruz
            QRCode.toDataURL(qr, (err, url) => {
                if (!err) {
                    qrCodes[sessionId] = url; // Frontend QRCodejs beklediği için raw qr string lazim.
                    // Wait, frontend QRCode.js expects text, not base64. 
                    // Let's just return the raw text if frontend does QRCode rendering.
                    qrCodes[sessionId] = qr; // Or url if frontend uses <img src>
                }
            });
            statuses[sessionId] = 'pending';
        }
        
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log(`Session ${sessionId} connection closed due to`, lastDisconnect.error, ', reconnecting:', shouldReconnect);
            
            if (shouldReconnect) {
                // Yeniden bağlan
                delete sessions[sessionId];
                setTimeout(() => initializeSession(sessionId), 5000);
            } else {
                console.log(`Session ${sessionId} logged out.`);
                statuses[sessionId] = 'disconnected';
                delete sessions[sessionId];
                delete qrCodes[sessionId];
                await clearState();
            }
        } else if (connection === 'open') {
            console.log(`Session ${sessionId} connected successfully!`);
            statuses[sessionId] = 'connected';
            qrCodes[sessionId] = null;
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sessions[sessionId] = sock;
};

const getSessionStatus = (sessionId) => {
    return statuses[sessionId] || 'disconnected';
};

const getQRCode = (sessionId) => {
    return qrCodes[sessionId] || null;
};

const logoutSession = async (sessionId) => {
    const sock = sessions[sessionId];
    if (sock) {
        sock.logout();
    } else {
        // Zaten yoksa state sil
        const { clearState } = await useRemoteAuthState(sessionId);
        await clearState();
    }
    delete sessions[sessionId];
    delete qrCodes[sessionId];
    statuses[sessionId] = 'disconnected';
};

const destroySession = async (sessionId) => {
    await logoutSession(sessionId);
};

const getAllSessions = async () => {
    // Bulutta çalışırken mevcut tüm session_id'leri PHP'den çekmemiz lazım 
    // veya sadece PHP paneline girdiğimizde istek geldiğinde başlatılır.
    // Şimdilik sadece istek gelince başlatacağız.
    console.log("Baileys Cloud Worker is waiting for connection requests.");
};

module.exports = {
    initializeSession,
    getSessionStatus,
    getQRCode,
    logoutSession,
    destroySession,
    getAllSessions
};
