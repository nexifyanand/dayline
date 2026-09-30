export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    const action = req.query.action || (req.body && req.body.action);
    
    // --- CRITICAL FIX: Foolproof Database URL with automatic slash ---
    let dbUrl = process.env.FIREBASE_DB_URL || "https://dayline-nexify-default-rtdb.firebaseio.com";
    if (!dbUrl.endsWith('/')) dbUrl += '/'; 
    
    const authQuery = process.env.FIREBASE_SECRET ? `?auth=${process.env.FIREBASE_SECRET}` : '';

    const CF_APP_ID = process.env.CASHFREE_APP_ID;
    const CF_SECRET = process.env.CASHFREE_SECRET_KEY;
    const CF_ENV_URL = "https://sandbox.cashfree.com/pg/orders"; // Use api.cashfree.com for production

    // Custom Order ID Generator: DLP + DDMMYYYY + 10 Random Alphanumeric
    function generateOrderId() {
        const now = new Date();
        const dd = String(now.getDate()).padStart(2, '0');
        const mm = String(now.getMonth() + 1).padStart(2, '0');
        const yyyy = now.getFullYear();
        
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let randomStr = '';
        for (let i = 0; i < 10; i++) {
            randomStr += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return `DLP${dd}${mm}${yyyy}${randomStr}`;
    }

    try {
        // ====================================================
        // 1. SECURELY CREATE ORDER & TRACK INITIATION
        // ====================================================
        if (action === "create_order") {
            const { userId, planAmount, planType, couponCode, daylineCode } = req.body;
            
            const orderId = generateOrderId();
            const nowIso = new Date().toISOString();
            const activeDaylineCode = daylineCode || "UNKNOWN_CODE";

            // State 1: INITIATED (Pre-Cashfree)
            const initialData = {
                orderId: orderId,
                userId: userId,
                daylineCode: activeDaylineCode,
                amount: parseFloat(planAmount),
                planType: planType || "Unknown",
                couponApplied: couponCode || "None",
                status: "INITIATED",
                gatewayStatus: "INITIATED",
                timestamp: nowIso
            };

            // Write INITIATED state to both requested nodes
            await Promise.all([
                fetch(`${dbUrl}transactions/${userId}/${orderId}.json${authQuery}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(initialData)
                }),
                fetch(`${dbUrl}Daylinecode_transactions/${activeDaylineCode}/${orderId}.json${authQuery}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(initialData)
                })
            ]);
            
            // Generate Cashfree Session
            const cfResponse = await fetch(CF_ENV_URL, {
                method: "POST",
                headers: {
                    "accept": "application/json",
                    "content-type": "application/json",
                    "x-api-version": "2023-08-01",
                    "x-client-id": CF_APP_ID,
                    "x-client-secret": CF_SECRET
                },
                body: JSON.stringify({
                    order_id: orderId,
                    order_amount: parseFloat(planAmount),
                    order_currency: "INR",
                    customer_details: {
                        customer_id: userId,
                        customer_phone: "9999999999"
                    },
                    order_meta: {
                        return_url: "https://your-domain.com/success?order_id={order_id}"
                    }
                })
            });

            const cfData = await cfResponse.json();

            if (cfData.payment_session_id) {
                // State 2: PENDING (Cashfree Session Created)
                const pendingUpdates = {
                    status: "PENDING",
                    gatewayStatus: "PENDING",
                    lastUpdatedAt: new Date().toISOString()
                };

                await Promise.all([
                    fetch(`${dbUrl}transactions/${userId}/${orderId}.json${authQuery}`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(pendingUpdates)
                    }),
                    fetch(`${dbUrl}Daylinecode_transactions/${activeDaylineCode}/${orderId}.json${authQuery}`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(pendingUpdates)
                    })
                ]);

                return res.status(200).json({ 
                    status: "success", 
                    payment_session_id: cfData.payment_session_id,
                    order_id: orderId 
                });
            } else {
                // State 2a: FAILED (Cashfree Rejected Order)
                const failedUpdates = {
                    status: "FAILED",
                    gatewayStatus: "API_REJECTED",
                    lastUpdatedAt: new Date().toISOString()
                };

                await Promise.all([
                    fetch(`${dbUrl}transactions/${userId}/${orderId}.json${authQuery}`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(failedUpdates)
                    }),
                    fetch(`${dbUrl}Daylinecode_transactions/${activeDaylineCode}/${orderId}.json${authQuery}`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(failedUpdates)
                    })
                ]);

                return res.status(400).json({ status: "error", message: cfData.message });
            }
        }

        // ====================================================
        // 2. FINALIZE PAYMENT (SUCCESS or FAILED)
        // ====================================================
        else if (action === "finalize_payment") {
            const { orderId, paymentStatus, userId, planType, amountPaid, daylineCode } = req.body;
            const nowIso = new Date().toISOString();
            const activeDaylineCode = daylineCode || "UNKNOWN_CODE";

            // State 3: SUCCESS or FAILED (User completed checkout)
            const finalUpdates = {
                status: paymentStatus.toUpperCase(),
                gatewayStatus: paymentStatus.toUpperCase(),
                lastUpdatedAt: nowIso
            };

            // Update both nodes with final status
            await Promise.all([
                fetch(`${dbUrl}transactions/${userId}/${orderId}.json${authQuery}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(finalUpdates)
                }),
                fetch(`${dbUrl}Daylinecode_transactions/${activeDaylineCode}/${orderId}.json${authQuery}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(finalUpdates)
                })
            ]);

            // If Success, activate the Premium nodes in Firebase
            if (paymentStatus.toUpperCase() === "SUCCESS") {
                const cleanPlan = (planType || "monthly").toLowerCase();
                let expiryDate = new Date();
                
                if (cleanPlan === "lifetime") {
                    expiryDate = new Date("9999-12-31T23:59:59.999Z");
                } else if (cleanPlan === "yearly") {
                    expiryDate.setDate(expiryDate.getDate() + 365);
                } else {
                    expiryDate.setDate(expiryDate.getDate() + 30);
                }

                await fetch(`${dbUrl}users/${userId}.json${authQuery}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ isPremium: true, current_plan: cleanPlan, premiumActivatedAt: nowIso })
                });

                await fetch(`${dbUrl}Active_plan/${userId}.json${authQuery}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        uid: userId,
                        amount: amountPaid,
                        expiry_date: expiryDate.toISOString(),
                        plan_type: cleanPlan,
                        premium_purchase_date: nowIso
                    })
                });
            }

            return res.status(200).json({ status: "success", message: "Database updated" });
        }

        return res.status(400).json({ status: "error", message: "Invalid action" });

    } catch (err) {
        return res.status(500).json({ status: "error", message: err.message });
    }
}