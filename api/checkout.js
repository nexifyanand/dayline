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
    const CF_ENV_URL = "https://sandbox.cashfree.com/pg/orders"; // Change to api.cashfree.com for prod

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
        if (action === "create_order") {
            // Added new coupon and discount fields to the request
            const { userId, planAmount, finalAmount, planType, txType, couponCode, discountAmount, daylineCode } = req.body;
            
            // If Sketchware sends an orderId, use it. Otherwise, generate one.
            const orderId = req.body.orderId || generateOrderId(); 
            const nowIso = new Date().toISOString();
            const activeDaylineCode = daylineCode || "UNKNOWN_CODE";
            const actualTxType = txType || "New Purchase";

            // UPDATED: Comprehensive Transaction Payload
            const initialData = {
                orderId: orderId,
                userId: userId,
                daylineCode: activeDaylineCode,
                paymentChannel: "Cashfree",
                paymentType: actualTxType, 
                amount: parseFloat(finalAmount || planAmount),
                planAmount: parseFloat(planAmount),
                discountAmount: parseFloat(discountAmount || 0),
                couponApplied: couponCode ? "yes" : "no",
                coupon: couponCode || "None",
                couponAmount: parseFloat(discountAmount || 0),
                planType: planType || "Unknown",
                status: "INITIATED",
                gatewayStatus: "INITIATED",
                paymentRemarks: "Order initiated securely.",
                timestamp: nowIso,
                lastUpdatedAt: nowIso
            };

            await Promise.all([
                fetch(`${dbUrl}transactions/${userId}/${orderId}.json${authQuery}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(initialData) }),
                fetch(`${dbUrl}mytransactions/${userId}/${orderId}.json${authQuery}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(initialData) }),
                fetch(`${dbUrl}Daylinecode_transactions/${activeDaylineCode}/${orderId}.json${authQuery}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(initialData) })
            ]);
            
            const cfResponse = await fetch(CF_ENV_URL, {
                method: "POST",
                headers: {
                    "accept": "application/json", "content-type": "application/json", "x-api-version": "2023-08-01",
                    "x-client-id": CF_APP_ID, "x-client-secret": CF_SECRET
                },
                body: JSON.stringify({
                    order_id: orderId, order_amount: parseFloat(finalAmount || planAmount), order_currency: "INR",
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
                return res.status(400).json({ status: "error", message: "Cashfree Error: " + cfData.message });
            }
        }

        else if (action === "finalize_payment") {
            const { orderId, userId, planType, txType, amountPaid, daylineCode, frontendRemarks } = req.body;
            const nowIso = new Date().toISOString();
            const activeDaylineCode = daylineCode || "UNKNOWN_CODE";

            // ==========================================
            // SECURE SERVER-SIDE VERIFICATION
            // ==========================================
            const cfVerifyResponse = await fetch(`${CF_ENV_URL}/${orderId}`, {
                method: "GET",
                headers: {
                    "accept": "application/json", "x-api-version": "2023-08-01",
                    "x-client-id": CF_APP_ID, "x-client-secret": CF_SECRET
                }
            });
            const cfVerifyData = await cfVerifyResponse.json();

            let secureStatus = "FAILED";
            let gatewayRemarks = frontendRemarks || "Transaction Failed";

            // Cashfree returns "PAID" for successful orders
            if (cfVerifyData.order_status === "PAID") {
                secureStatus = "SUCCESS";
                gatewayRemarks = "Payment processed successfully.";
            } else if (cfVerifyData.order_status === "ACTIVE") {
                secureStatus = "PENDING";
                gatewayRemarks = "Payment is pending at gateway.";
            } else {
                secureStatus = "FAILED";
                // Capture exact error from Cashfree if available (e.g. "User cancelled", "Declined by bank")
                if (cfVerifyData.error_details && cfVerifyData.error_details.error_description) {
                    gatewayRemarks = cfVerifyData.error_details.error_description;
                } else if (frontendRemarks) {
                    gatewayRemarks = frontendRemarks;
                } else {
                    gatewayRemarks = "Transaction failed or cancelled.";
                }
            }

           // 1. UPDATE TRANSACTION HISTORY (mytransactions)
            const finalUpdates = {
                status: secureStatus, 
                gatewayStatus: secureStatus, 
                paymentRemarks: gatewayRemarks,
                lastUpdatedAt: nowIso
            };

            await Promise.all([
                fetch(`${dbUrl}transactions/${userId}/${orderId}.json${authQuery}`, { method: 'PATCH', body: JSON.stringify(finalUpdates) }),
                fetch(`${dbUrl}mytransactions/${userId}/${orderId}.json${authQuery}`, { method: 'PATCH', body: JSON.stringify(finalUpdates) }),
                fetch(`${dbUrl}Daylinecode_transactions/${activeDaylineCode}/${orderId}.json${authQuery}`, { method: 'PATCH', body: JSON.stringify(finalUpdates) })
            ]);

            // ONLY UPGRADE IF SECURE STATUS IS SUCCESS
            if (secureStatus === "SUCCESS") {
                // Ensure plan name is UPPERCASE as requested (e.g., MONTHLY, YEARLY)
                const cleanPlan = (planType || "MONTHLY").toUpperCase(); 
                let expiryDate = new Date();
                let finalPlanAmount = parseFloat(amountPaid) || 0;

                // Existing Proration/Top-up Math
                if (txType === "Top-up") {
                    const planRes = await fetch(`${dbUrl}Active_plan/${userId}.json${authQuery}`);
                    const currentPlan = await planRes.json() || {};
                    
                    let baseExpiry = currentPlan.expiry_date ? new Date(parseInt(currentPlan.expiry_date)) : new Date();
                    if (baseExpiry.getTime() < Date.now()) baseExpiry = new Date();
                    
                    if (cleanPlan === "YEARLY") baseExpiry.setDate(baseExpiry.getDate() + 365);
                    else baseExpiry.setDate(baseExpiry.getDate() + 30);
                    
                    expiryDate = baseExpiry;
                    finalPlanAmount += parseFloat(currentPlan.amount || 0); 
                } else {
                    if (cleanPlan === "LIFETIME") expiryDate = new Date("9999-12-31T23:59:59.999Z");
                    else if (cleanPlan === "YEARLY") expiryDate.setDate(expiryDate.getDate() + 365);
                    else expiryDate.setDate(expiryDate.getDate() + 30);
                }

                // 2. UPDATE USERS NODE
                await fetch(`${dbUrl}users/${userId}.json${authQuery}`, {
                    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        isPremium: true, 
                        current_plan: cleanPlan, 
                        premiumActivatedAt: nowIso 
                    })
                });

                // 3. UPDATE ACTIVE_PLAN NODE (Including new lastpaymentid)
                await fetch(`${dbUrl}Active_plan/${userId}.json${authQuery}`, {
                    method: 'PUT', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        uid: userId, 
                        amount: finalPlanAmount, 
                        expiry_date: expiryDate.getTime().toString(), // Saved as a timestamp string for Android Java to read
                        plan_type: cleanPlan, 
                        premium_purchase_date: nowIso,
                        lastpaymentid: orderId 
                    })
                });

                // (Optional) Clear generated codes if used
                if (activeDaylineCode !== "UNKNOWN_CODE") {
                    await fetch(`${dbUrl}used_codes/${userId}/${activeDaylineCode}.json${authQuery}`, {
                        method: 'PUT', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ code: activeDaylineCode, usedBy: userId, usedAt: nowIso, orderId: orderId, planType: cleanPlan })
                    });
                    await fetch(`${dbUrl}generated_codes/${activeDaylineCode}.json${authQuery}`, { method: 'DELETE' });
                }

                // Push Notification Entry
                const notificationId = `notif_${Date.now()}`;
                await fetch(`${dbUrl}notifications/${userId}/${notificationId}.json${authQuery}`, {
                    method: 'PUT', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        title: "Payment Successful! 🎉",
                        message: `Your payment of ₹${amountPaid} for the ${cleanPlan} plan was received successfully.`,
                        type: "PAYMENT_RECEIPT", orderId: orderId, timestamp: nowIso, isRead: false
                    })
                });
            }

            return res.status(200).json({ status: "success", payment_status: secureStatus, message: "Database updated" });
        }

        return res.status(400).json({ status: "error", message: "Invalid action" });
    } catch (err) {
        return res.status(500).json({ status: "error", message: err.message });
    }
}