const { initializeApp, getApps, cert } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");
const { Cashfree, CFEnvironment } = require("cashfree-pg"); // Added CFEnvironment

// BULLETPROOF PRIVATE KEY FORMATTER
let formattedPrivateKey = process.env.FIREBASE_PRIVATE_KEY;
if (formattedPrivateKey) {
    // Removes accidental quotes and fixes line breaks perfectly
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

// 2. Initialize Cashfree using the new Environment syntax
Cashfree.XClientId = process.env.CASHFREE_APP_ID;
Cashfree.XClientSecret = process.env.CASHFREE_SECRET;
Cashfree.XEnvironment = CFEnvironment ? CFEnvironment.PRODUCTION : "PRODUCTION"; 

// 3. Main Serverless Function
module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send({ message: 'Only POST requests allowed' });

    const { code, planId } = req.body;
    const db = getDatabase();

    try {
        // A. Verify Code exists and isn't expired
        const codeSnap = await db.ref(`generated_codes/${code}`).once('value');
        if (!codeSnap.exists()) return res.status(404).json({ error: 'Invalid code' });
        
        const codeData = codeSnap.val();
        const isExpired = (Date.now() - codeData.timestamp) > (48 * 60 * 60 * 1000);
        if (isExpired || codeData.used) return res.status(400).json({ error: 'Code expired or used' });

        // B. Check User's current plan
        const uid = codeData.uid;
        const userSnap = await db.ref(`users/${uid}`).once('value');
        const userData = userSnap.val();
        
        if (userData && userData.plan === 'Lifetime') {
            return res.status(400).json({ error: 'User already has a Lifetime plan.' });
        }

        // C. Create Cashfree Order
        const orderRequest = {
            order_amount: planId,
            order_currency: "INR",
            customer_details: { customer_id: uid, customer_phone: "9999999999" },
            order_tags: { uid: uid, code: code, plan: planId }
        };

        const response = await Cashfree.PGCreateOrder("2023-08-01", orderRequest);
        return res.status(200).json({ payment_session_id: response.data.payment_session_id });

    } catch (error) {
        console.error("Backend Error:", error);
        return res.status(500).json({ error: 'Payment gateway error' });
    }
};