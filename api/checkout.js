export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    const action = req.query.action || (req.body && req.body.action);
    
    let dbUrl = process.env.FIREBASE_DB_URL || "https://dayline-nexify-default-rtdb.firebaseio.com";
    if (!dbUrl.endsWith('/')) dbUrl += '/'; 
    
    const authQuery = process.env.FIREBASE_SECRET ? `?auth=${process.env.FIREBASE_SECRET}` : '';

    const CF_APP_ID = process.env.CASHFREE_APP_ID;
    const CF_SECRET = process.env.CASHFREE_SECRET_KEY;
    const CF_ENV_URL = "https://sandbox.cashfree.com/pg/orders"; // Use api.cashfree.com for production

    function generateOrderId() {
        const now = new Date();
        const dd = String(now.getDate()).padStart(2, '0');
        const mm = String(now.getMonth() + 1).padStart(2, '0');
        const yyyy = now.getFullYear();
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let randomStr = '';
        for (let i = 0; i < 10; i++) randomStr += chars.charAt(Math.floor(Math.random() * chars.length));
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

            const initialData = {
                orderId: orderId,
                userId: userId,
                daylineCode: activeDaylineCode,
                paymentChannel: "web",
                paymentType: `User Purchase (${planType || "Unknown"})`,
                amount: parseFloat(planAmount),
                planType: planType || "Unknown",
                couponApplied: couponCode || "None",
                status: "INITIATED",
                gatewayStatus: "INITIATED",
                timestamp: nowIso
            };

            await Promise.all([
                fetch(`${dbUrl}transactions/${userId}/${orderId}.json${authQuery}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(initialData) }),
                fetch(`${dbUrl}mytransactions/${userId}/${orderId}.json${authQuery}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(initialData) }),
                fetch(`${dbUrl}Daylinecode_transactions/${activeDaylineCode}/${orderId}.json${authQuery}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(initialData) })
            ]);
            
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
                    customer_details: { customer_id: userId, customer_phone: "9999999999" },
                    order_meta: { return_url: "https://your-domain.com/success?order_id={order_id}" }
                })
            });

            const cfData = await cfResponse.json();

            if (cfData.payment_session_id) {
                const pendingUpdates = { status: "PENDING", gatewayStatus: "PENDING", lastUpdatedAt: new Date().toISOString() };
                await Promise.all([
                    fetch(`${dbUrl}transactions/${userId}/${orderId}.json${authQuery}`, { method: 'PATCH', body: JSON.stringify(pendingUpdates) }),
                    fetch(`${dbUrl}mytransactions/${userId}/${orderId}.json${authQuery}`, { method: 'PATCH', body: JSON.stringify(pendingUpdates) }),
                    fetch(`${dbUrl}Daylinecode_transactions/${activeDaylineCode}/${orderId}.json${authQuery}`, { method: 'PATCH', body: JSON.stringify(pendingUpdates) })
                ]);
                return res.status(200).json({ status: "success", payment_session_id: cfData.payment_session_id, order_id: orderId });
            } else {
                const failedUpdates = { status: "FAILED", gatewayStatus: "API_REJECTED", lastUpdatedAt: new Date().toISOString() };
                await Promise.all([
                    fetch(`${dbUrl}transactions/${userId}/${orderId}.json${authQuery}`, { method: 'PATCH', body: JSON.stringify(failedUpdates) }),
                    fetch(`${dbUrl}mytransactions/${userId}/${orderId}.json${authQuery}`, { method: 'PATCH', body: JSON.stringify(failedUpdates) }),
                    fetch(`${dbUrl}Daylinecode_transactions/${activeDaylineCode}/${orderId}.json${authQuery}`, { method: 'PATCH', body: JSON.stringify(failedUpdates) })
                ]);
                return res.status(400).json({ status: "error", message: "Cashfree Error: " + cfData.message });
            }
        }

        // ====================================================
        // 2. FINALIZE PAYMENT (SUCCESS or FAILED)
        // ====================================================
        else if (action === "finalize_payment") {
            const { orderId, paymentStatus, userId, planType, amountPaid, daylineCode } = req.body;
            const nowIso = new Date().toISOString();
            const activeDaylineCode = daylineCode || "UNKNOWN_CODE";

            // 1. Update Transaction Statuses
            const finalUpdates = {
                status: paymentStatus.toUpperCase(),
                gatewayStatus: paymentStatus.toUpperCase(),
                lastUpdatedAt: nowIso
            };

            await Promise.all([
                fetch(`${dbUrl}transactions/${userId}/${orderId}.json${authQuery}`, { method: 'PATCH', body: JSON.stringify(finalUpdates) }),
                fetch(`${dbUrl}mytransactions/${userId}/${orderId}.json${authQuery}`, { method: 'PATCH', body: JSON.stringify(finalUpdates) }),
                fetch(`${dbUrl}Daylinecode_transactions/${activeDaylineCode}/${orderId}.json${authQuery}`, { method: 'PATCH', body: JSON.stringify(finalUpdates) })
            ]);

            // 2. ONLY DO THIS IF SUCCESSFUL
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

                // A. Activate Premium Plan
                await fetch(`${dbUrl}users/${userId}.json${authQuery}`, {
                    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ isPremium: true, current_plan: cleanPlan, premiumActivatedAt: nowIso })
                });

                await fetch(`${dbUrl}Active_plan/${userId}.json${authQuery}`, {
                    method: 'PUT', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        uid: userId, amount: amountPaid, expiry_date: expiryDate.toISOString(), plan_type: cleanPlan, premium_purchase_date: nowIso
                    })
                });

                // B. Move Dayline Code (Deactivation)
                if (activeDaylineCode !== "UNKNOWN_CODE") {
                    // Write to Used Codes
                    await fetch(`${dbUrl}used_codes/${userId}/${activeDaylineCode}.json${authQuery}`, {
                        method: 'PUT', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            code: activeDaylineCode,
                            usedBy: userId,
                            usedAt: nowIso,
                            orderId: orderId,
                            planType: cleanPlan
                        })
                    });
                    
                    // Delete from Generated Codes
                    await fetch(`${dbUrl}generated_codes/${activeDaylineCode}.json${authQuery}`, {
                        method: 'DELETE'
                    });
                }

                // C. Write In-App Notification directly to Firebase DB
                const notificationId = `notif_${Date.now()}`;
                await fetch(`${dbUrl}notifications/${userId}/${notificationId}.json${authQuery}`, {
                    method: 'PUT', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        title: "Payment Successful! 🎉",
                        message: `Your payment of ₹${amountPaid} for the ${cleanPlan.toUpperCase()} plan was received successfully.`,
                        type: "PAYMENT_RECEIPT",
                        orderId: orderId,
                        timestamp: nowIso,
                        isRead: false
                    })
                });

                // D. Email Confirmation Trigger (Optional)
                // If you use an external email API like Resend, SendGrid, or an Apps Script endpoint, call it here:
                /*
                try {
                    await fetch("https://your-email-api-endpoint.com/send", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            toUserId: userId,
                            subject: "Dayline Payment Receipt",
                            orderId: orderId,
                            amount: amountPaid
                        })
                    });
                } catch(e) { console.error("Email failed", e); }
                */
            }

            return res.status(200).json({ status: "success", message: "Database updated" });
        }

        return res.status(400).json({ status: "error", message: "Invalid action" });

    } catch (err) {
        return res.status(500).json({ status: "error", message: err.message });
    }
}