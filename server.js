require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { initializeSession, getSessionStatus, getQRCode, logoutSession, destroySession, getAllSessions } = require('./src/whatsapp');

const app = express();
const PORT = process.env.PORT || 3000;
const API_TOKEN = process.env.API_TOKEN;

app.use(cors());
app.use(express.json());

// Auth Middleware
const authMiddleware = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const token = authHeader.split(' ')[1];
    if (token !== API_TOKEN) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    next();
};

app.use(authMiddleware);

// Endpoints
app.post('/api/sessions/create', async (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
    
    try {
        await initializeSession(sessionId);
        res.json({ success: true, message: `Session ${sessionId} initialized` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/sessions/:sessionId/status', (req, res) => {
    const { sessionId } = req.params;
    const status = getSessionStatus(sessionId);
    res.json({ sessionId, status });
});

app.get('/api/sessions/:sessionId/qr', (req, res) => {
    const { sessionId } = req.params;
    const qr = getQRCode(sessionId);
    res.json({ sessionId, qr });
});

app.post('/api/sessions/:sessionId/logout', async (req, res) => {
    const { sessionId } = req.params;
    try {
        await logoutSession(sessionId);
        res.json({ success: true, message: `Session ${sessionId} logged out` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/sessions/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    try {
        await destroySession(sessionId);
        res.json({ success: true, message: `Session ${sessionId} destroyed` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Otomatik başlatma için mevcut oturumları (sessions klasörü) tara ve ayağa kaldır
app.listen(PORT, async () => {
    console.log(`Node.js WhatsApp Worker is running on port ${PORT}`);
    console.log('Restoring existing sessions...');
    await getAllSessions();
});
