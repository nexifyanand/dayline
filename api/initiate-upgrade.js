const { initializeApp, getApps, cert } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");

// BULLETPROOF PRIVATE KEY FORMATTER
let formattedPrivateKey = process.env.FIREBASE_PRIVATE_KEY;
if (formattedPrivateKey) {
    formattedPrivateKey = formattedPrivateKey.replace(/"/g, '').replace(/\\n/g, '\n');
}

// 1. Initialize Firebase Admin safely
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

// 2. Main Verification Function
module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send({ message: 'Only POST requests allowed' });

    const { code } = req.body;
    const db = getDatabase();

    try {
        // A. Verify Code exists
        const codeSnap = await db.ref(`generated_codes/${code}`).once('value');
        if (!codeSnap.exists()) return res.status(404).json({ error: 'Invalid code' });
        
        const codeData = codeSnap.val();
        
        // B. Check Expiration and Usage
        const isExpired = (Date.now() - codeData.timestamp) > (48 * 60 * 60 * 1000);
        if (isExpired || codeData.used) return res.status(400).json({ error: 'Code expired or already used' });

        // C. Check User's current plan
        const uid = codeData.uid;
        const userSnap = await db.ref(`users/${uid}`).once('value');
        const userData = userSnap.val();
        
        if (userData && userData.plan === 'Lifetime') {
            return res.status(400).json({ error: 'User already has a Lifetime plan.' });
        }

        // D. Success! Code is valid.
        return res.status(200).json({ success: true, message: 'Code is valid!' });

    } catch (error) {
        console.error("Backend Error:", error);
        return res.status(500).json({ error: 'Internal server error while verifying code' });
    }
};