import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import path from 'path';
import { fileURLToPath } from 'url';
import contactRoute from './api/contact.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Add these constants at the top with other imports
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes in milliseconds
let liveStreamCache = {
    isLive: false,
    lastChecked: 0,
    videoId: null
};

app.use(cors());
app.use(express.json());

// Serve images directory statically - MUST BE BEFORE routes
app.use('/images', express.static(path.join(__dirname, 'images')));

// Add this function before the routes
async function checkLiveStreamStatus() {
    const now = Date.now();
    // Only check if cache is expired
    if (now - liveStreamCache.lastChecked < CACHE_DURATION) {
        return liveStreamCache;
    }

    try {
        const response = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${process.env.YOUTUBE_CHANNEL_ID}&type=video&eventType=live&key=${process.env.YOUTUBE_API_KEY}`);
        const data = await response.json();
        
        liveStreamCache = {
            isLive: data.items && data.items.length > 0,
            lastChecked: now,
            videoId: data.items && data.items.length > 0 ? data.items[0].id.videoId : null
        };
        
        return liveStreamCache;
    } catch (error) {
        console.error('Error checking live stream:', error);
        return liveStreamCache;
    }
}

// Serve the index page for all root requests
app.get('/', async (req, res) => {
    const liveStatus = await checkLiveStreamStatus();
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Add a new endpoint for live stream status
app.get('/api/live-status', async (req, res) => {
    const liveStatus = await checkLiveStreamStatus();
    res.set('Cache-Control', `public, max-age=${CACHE_DURATION / 1000}`);
    res.json(liveStatus);
});

// Allow direct access to main pages
app.get('/give.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'give.html'));
});

app.get('/about.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'about.html'));
});

app.get('/sermons.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'sermons.html'));
});

app.get('/events.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'events.html'));
});

app.get('/contact.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'contact.html'));
});

app.get('/give-success.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'give-success.html'));
});

// Serve static files
app.use(express.static(__dirname));

// Only redirect unknown routes to opening-soon.html
app.get('*', (req, res) => {
  if (req.path === '/opening-soon.html') {
    res.sendFile(path.join(__dirname, 'opening-soon.html'));
  } else if (!req.path.includes('.')) {  // Only redirect if it's not a file request
    res.redirect('/');
  }
});

// Add contact form API route
app.use('/api/contact', contactRoute);

// Important: We need to handle the webhook before the JSON parser
app.post('/webhook', express.raw({type: 'application/json'}), async (req, res) => {
    console.log("=== WEBHOOK RECEIVED ===");
    console.log("Headers:", req.headers);
    const sig = req.headers['stripe-signature'];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
        console.log("Event type:", event.type);
        console.log("Event data:", JSON.stringify(event.data.object, null, 2));
    } catch (err) {
        console.error("Webhook Error:", err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle different event types
    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        console.log("=== PAYMENT SUCCESSFUL ===");
        console.log("Session ID:", session.id);
        console.log("Customer Email:", session.customer_details?.email);
        console.log("Amount:", session.amount_total / 100);
        await updateTransactionStatus(session, 'successful');
    } else if (event.type === 'checkout.session.expired') {
        const session = event.data.object;
        console.log("=== SESSION EXPIRED ===");
        await updateTransactionStatus(session, 'expired');
    } else if (event.type === 'payment_intent.payment_failed') {
        const session = event.data.object;
        console.log("=== PAYMENT FAILED ===");
        await updateTransactionStatus(session, 'failed');
    }

    res.json({received: true});
});

// Add JSON parser after webhook route
app.use(express.json());

async function updateTransactionStatus(session, status) {
    try {
        // Get customer details from the session
        const customerEmail = session.customer_details?.email || '';
        const amount = session.amount_total / 100; // Convert from cents to dollars
        
        console.log("=== UPDATING TRANSACTION ===");
        console.log("Email:", customerEmail);
        console.log("Amount:", amount);
        console.log("New Status:", status);
        
        // Find the pending transaction
        const { data: transactions, error: findError } = await supabase
            .from('transactions')
            .select('*')
            .eq('email', customerEmail)
            .eq('amount', amount)
            .eq('payment_status', 'pending')
            .order('created_at', { ascending: false })
            .limit(1);

        if (findError) {
            console.error("Error finding transaction:", findError);
            throw findError;
        }
        
        console.log("Found transactions:", transactions);
        
        if (transactions && transactions.length > 0) {
            const transaction = transactions[0];
            console.log("Updating transaction:", transaction.id);
            
            // Update the transaction status
            const { data: updateData, error: updateError } = await supabase
                .from('transactions')
                .update({
                    payment_status: status,
                    session_id: session.id,
                    updated_at: new Date().toISOString()
                })
                .eq('id', transaction.id);

            if (updateError) {
                console.error("Error updating transaction:", updateError);
                throw updateError;
            }
            
            console.log("Transaction updated successfully:", updateData);
        } else {
            console.log("No pending transaction found");
        }
    } catch (err) {
        console.error("Error in updateTransactionStatus:", err);
        throw err;
    }
}

// Create checkout session endpoint
app.post('/create-checkout-session', async (req, res) => {
    const { amount, email, name, phone } = req.body;
    console.log("Creating checkout session for:", { amount, email, name, phone });

    try {
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: 'Donation',
                    },
                    unit_amount: Math.round(amount * 100), // Convert to cents
                },
                quantity: 1,
            }],
            mode: 'payment',
            success_url: `${req.headers.origin}/give-success.html?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${req.headers.origin}/give.html`,
            customer_email: email,
            metadata: {
                name: name,
                phone: phone
            }
        });

        console.log("Checkout session created:", session.id);
        res.json({ url: session.url });
    } catch (err) {
        console.error("Error creating checkout session:", err);
        res.status(500).json({ error: err.message });
    }
});

// Handle successful payment
app.post('/payment-success', async (req, res) => {
    const { session_id } = req.body;
    
    try {
        // Get session details from Stripe
        const session = await stripe.checkout.sessions.retrieve(session_id);
        
        if (session.payment_status === 'paid') {
            // Store in Supabase
            const { data, error } = await supabase
                .from('transactions')
                .insert([{
                    email: session.customer_email,
                    name: session.metadata.name,
                    phone: session.metadata.phone,
                    amount: session.amount_total / 100,
                    session_id: session.id,
                    created_at: new Date().toISOString()
                }]);

            if (error) throw error;
            res.json({ success: true });
        } else {
            res.status(400).json({ error: 'Payment not completed' });
        }
    } catch (err) {
        console.error("Error processing payment success:", err);
        res.status(500).json({ error: err.message });
    }
});

// Stripe Elements PaymentIntent endpoint
app.post('/api/create-payment-intent', async (req, res) => {
    const { amount, email } = req.body;
    try {
        const paymentIntent = await stripe.paymentIntents.create({
            amount: Math.round(amount * 100), // amount in cents
            currency: 'usd',
            receipt_email: email,
        });
        res.json({ clientSecret: paymentIntent.client_secret });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Save donation details to Supabase after successful payment
app.post('/api/save-form-data', async (req, res) => {
    const { paymentIntentId, formData } = req.body;
    try {
        // Save to Supabase (adjust table/fields as needed)
        const { data, error } = await supabase
            .from('transactions')
            .insert([{
                name: formData.name,
                email: formData.email,
                amount: formData.amount,
                payment_intent_id: paymentIntentId,
                created_at: new Date().toISOString(),
                payment_status: 'successful'
            }]);
        if (error) {
            return res.status(500).json({ error: error.message });
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to save donation.' });
    }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
}); 