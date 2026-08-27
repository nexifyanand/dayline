const admin = require("firebase-admin");
const { Cashfree } = require("cashfree-pg");

// Initialize Firebase Admin securely using Vercel Environment Variables
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        }),
        databaseURL: process.env.FIREBASE_DATABASE_URL
    });
}

Cashfree.XClientId = process.env.CASHFREE_APP_ID;
Cashfree.XClientSecret = process.env.CASHFREE_SECRET;
Cashfree.XEnvironment = Cashfree.Environment.PRODUCTION; 

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send({ message: 'Only POST requests allowed' });

    const { code, planId } = req.body;
    const db = admin.database();

    try {
        // 1. Verify Code exists and isn't expired
        const codeSnap = await db.ref(`generated_codes/${code}`).once('value');
        if (!codeSnap.exists()) return res.status(404).json({ error: 'Invalid code' });
        
        const codeData = codeSnap.val();
        const isExpired = (Date.now() - codeData.timestamp) > (48 * 60 * 60 * 1000);
        if (isExpired || codeData.used) return res.status(400).json({ error: 'Code expired or used' });

        // 2. Check User's current plan
        const uid = codeData.uid;
        const userSnap = await db.ref(`users/${uid}`).once('value');
        const userData = userSnap.val();
        
        if (userData && userData.plan === 'Lifetime') {
            return res.status(400).json({ error: 'User already has a Lifetime plan.' });
        }

        // 3. Create Cashfree Order
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
}