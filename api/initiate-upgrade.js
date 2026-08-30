const { initializeApp, getApps, cert } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");

let formattedPrivateKey = process.env.FIREBASE_PRIVATE_KEY;
if (formattedPrivateKey) {
    formattedPrivateKey = formattedPrivateKey.replace(/"/g, '').replace(/\\n/g, '\n');
}

if (getApps().length === 0) {
    initializeApp({
        credential: cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: formattedPrivateKey,
        }),
        databaseURL: process.env.FIREBASE_DATABASE_URL
    });
}

function maskName(name) {
    if (!name) return "U***r";
    return name.split(' ').map(word => {
        if (word.length <= 2) return word; 
        return word.charAt(0) + '*'.repeat(word.length - 2) + word.slice(-1);
    }).join(' ');
}

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Only POST requests allowed' });

    const { code } = req.body || {};
    if (!code) return res.status(400).json({ error: 'Please enter a valid code.' });

    try {
        const db = getDatabase();
        const codeRef = db.ref(`generated_codes/${code}`);
        const codeSnap = await codeRef.once('value');

        if (!codeSnap.exists()) return res.status(404).json({ error: 'Invalid code. Code does not exist.' });

        const codeData = codeSnap.val();

        // 1. Check if code was already redeemed after payment
        if (codeData.used) {
            return res.status(400).json({ error: 'This code has already been redeemed and completed.' });
        }
        
        // 2. Check if code expired (48 hours)
        const isExpired = (Date.now() - (codeData.timestamp || 0)) > (48 * 60 * 60 * 1000);
        if (isExpired) return res.status(400).json({ error: 'This code has expired (48-hour limit).' });

        // 3. CONCURRENT LOGIN PREVENTION (Active Session Lock)
        // If session is active and active within the last 15 minutes, block other users
        const fifeteenMins = 15 * 60 * 1000;
        if (codeData.sessionActive && (Date.now() - (codeData.lastActiveTimestamp || 0)) < fifeteenMins) {
            return res.status(403).json({ error: 'This code is currently in use on another device/browser session.' });
        }

        // Lock session to current active request
        await codeRef.update({
            sessionActive: true,
            lastActiveTimestamp: Date.now()
        });

        const uid = codeData.uid;
        let safeName = "A*****t";
        let currentPlan = "Free";

        if (uid) {
            const userSnap = await db.ref(`users/${uid}`).once('value');
            const userData = userSnap.val();
            
            if (userData && userData.plan === 'Lifetime') {
                return res.status(400).json({ error: 'User already has a Lifetime plan.' });
            }
            if (userData) {
                if (userData.name) safeName = maskName(userData.name);
                if (userData.plan) currentPlan = userData.plan;
            }
        }

        return res.status(200).json({ 
            success: true, 
            code: code, 
            accountName: safeName, 
            currentPlan: currentPlan 
        });

    } catch (error) {
        console.error("Backend Error:", error);
        return res.status(500).json({ error: 'Database connection error.' });
    }
};