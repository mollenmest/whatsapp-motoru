const axios = require('axios');
const { initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');
require('dotenv').config();

const API_URL = process.env.PHP_API_URL || 'http://localhost/public_html/api/auth_store.php';
const API_TOKEN = process.env.API_TOKEN;

const getHeaders = () => ({
    'Authorization': `Bearer ${API_TOKEN}`,
    'Content-Type': 'application/json'
});

async function fetchFromDb(sessionId, keyName) {
    try {
        const response = await axios.get(`${API_URL}?action=get&session_id=${sessionId}&key_name=${keyName}`, { headers: getHeaders() });
        return response.data.success ? response.data.data : null;
    } catch (error) {
        console.error(`Error fetching key ${keyName} for ${sessionId}:`, error.message);
        return null;
    }
}

async function saveToDb(sessionId, keyName, keyValue) {
    try {
        await axios.post(`${API_URL}?action=set&session_id=${sessionId}`, {
            key_name: keyName,
            key_value: keyValue
        }, { headers: getHeaders() });
    } catch (error) {
        console.error(`Error saving key ${keyName} for ${sessionId}:`, error.message);
    }
}

async function deleteFromDb(sessionId, keyName) {
    try {
        await axios.post(`${API_URL}?action=delete&session_id=${sessionId}`, {
            key_name: keyName
        }, { headers: getHeaders() });
    } catch (error) {
        console.error(`Error deleting key ${keyName} for ${sessionId}:`, error.message);
    }
}

async function deleteAllFromDb(sessionId) {
    try {
        await axios.post(`${API_URL}?action=delete_all&session_id=${sessionId}`, {}, { headers: getHeaders() });
    } catch (error) {
        console.error(`Error deleting all keys for ${sessionId}:`, error.message);
    }
}

const useRemoteAuthState = async (sessionId) => {
    let creds;
    const credsData = await fetchFromDb(sessionId, 'creds');
    
    if (credsData) {
        creds = JSON.parse(credsData, BufferJSON.reviver);
    } else {
        creds = initAuthCreds();
    }

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(
                        ids.map(async id => {
                            let value = await fetchFromDb(sessionId, `${type}-${id}`);
                            if (type === 'app-state-sync-key' && value) {
                                value = JSON.parse(value, BufferJSON.reviver);
                            }
                            data[id] = value;
                        })
                    );
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            if (value) {
                                tasks.push(saveToDb(sessionId, key, JSON.stringify(value, BufferJSON.replacer)));
                            } else {
                                tasks.push(deleteFromDb(sessionId, key));
                            }
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => saveToDb(sessionId, 'creds', JSON.stringify(creds, BufferJSON.replacer)),
        clearState: () => deleteAllFromDb(sessionId)
    };
};

module.exports = { useRemoteAuthState };
