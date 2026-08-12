// ===== SUPABASE CLIENT =====
const SUPABASE_URL = 'https://civsimcybzcivicwwcny.supabase.co';
const SUPABASE_KEY = 'sb_publishable_CmizMWebn7lwj2Rb_yGT1A_2CJ-OWFa';

const { createClient } = supabase;
const db = createClient(SUPABASE_URL, SUPABASE_KEY);

// ===== USERS =====
async function sbGetUsers() {
    const { data, error } = await db.from('users').select('*');
    if (error) { console.error('[sb] getUsers:', error.message); return null; }
    return data;
}

async function sbAddUser(user) {
    const { error } = await db.from('users').insert({
        username: user.username,
        password: user.password,
        role:     user.role
    });
    if (error) { console.error('[sb] addUser:', error.message); return false; }
    return true;
}

async function sbUpdateUser(oldUsername, user) {
    const { error } = await db.from('users')
        .update({ username: user.username, password: user.password, role: user.role })
        .eq('username', oldUsername);
    if (error) { console.error('[sb] updateUser:', error.message); return false; }
    return true;
}

async function sbDeleteUser(username) {
    const { error } = await db.from('users').delete().eq('username', username);
    if (error) { console.error('[sb] deleteUser:', error.message); return false; }
    return true;
}

// ===== PRODUCTS =====
async function sbGetProducts() {
    const { data, error } = await db.from('products').select('*');
    if (error) { console.error('[sb] getProducts:', error.message); return null; }
    return data;
}

async function sbAddProduct(product) {
    const { error } = await db.from('products').insert({
        barcode: product.barcode,
        name:    product.name,
        brand:   product.brand,
        price:   product.price,
        stock:   product.stock
    });
    if (error) { console.error('[sb] addProduct:', error.message); return false; }
    return true;
}

async function sbUpdateProduct(barcode, product) {
    const { error } = await db.from('products')
        .update({
            barcode:     product.barcode,
            name:        product.name,
            brand:       product.brand,
            price:       product.price,
            stock:       product.stock,
            updated_at:  new Date().toISOString()
        })
        .eq('barcode', barcode);
    if (error) { console.error('[sb] updateProduct:', error.message); return false; }
    return true;
}

async function sbDeleteProduct(barcode) {
    const { error } = await db.from('products').delete().eq('barcode', barcode);
    if (error) { console.error('[sb] deleteProduct:', error.message); return false; }
    return true;
}

async function sbDeductStock(barcode, qty) {
    // Fetch current stock first
    const { data, error } = await db.from('products').select('stock').eq('barcode', barcode).single();
    if (error) { console.error('[sb] deductStock fetch:', error.message); return false; }
    const newStock = Math.max(0, (data.stock || 0) - qty);
    const { error: upErr } = await db.from('products')
        .update({ stock: newStock, updated_at: new Date().toISOString() })
        .eq('barcode', barcode);
    if (upErr) { console.error('[sb] deductStock update:', upErr.message); return false; }
    return true;
}

// ===== TRANSACTIONS =====
async function sbGetTransactions() {
    const { data, error } = await db
        .from('transactions')
        .select('*')
        .order('date', { ascending: false });
    if (error) { console.error('[sb] getTransactions:', error.message); return null; }
    // Normalize field names to match local format
    return data.map(t => ({
        id:            t.id,
        date:          t.date,
        user:          t.username,
        paymentMethod: t.payment_method,
        customerName:  t.customer_name || 'N/A',
        items:         t.items,
        totalItems:    t.total_items,
        subtotal:      parseFloat(t.subtotal),
        cash:          parseFloat(t.cash || 0),
        change:        parseFloat(t.change || 0)
    }));
}

async function sbSaveTransaction(t) {
    const { error } = await db.from('transactions').insert({
        id:             String(t.id),
        date:           t.date,
        username:       t.user,
        payment_method: t.paymentMethod,
        customer_name:  t.customerName || 'N/A',
        items:          t.items,
        total_items:    t.totalItems,
        subtotal:       t.subtotal,
        cash:           t.cash || 0,
        change:         t.change || 0,
        synced:         true
    });
    if (error) { console.error('[sb] saveTransaction:', error.message); return false; }
    return true;
}

// ===== ACTIVE SESSIONS =====
async function sbMarkOnline(username) {
    const { error } = await db.from('active_sessions').upsert({
        username: username,
        online:   true,
        last_seen: new Date().toISOString()
    }, { onConflict: 'username' });
    if (error) console.error('[sb] markOnline:', error.message);
}

async function sbMarkOffline(username) {
    const { error } = await db.from('active_sessions').upsert({
        username:  username,
        online:    false,
        last_seen: new Date().toISOString()
    }, { onConflict: 'username' });
    if (error) console.error('[sb] markOffline:', error.message);
}

async function sbGetSessions() {
    const { data, error } = await db.from('active_sessions').select('*');
    if (error) { console.error('[sb] getSessions:', error.message); return {}; }
    const map = {};
    (data || []).forEach(s => { map[s.username] = s; });
    return map;
}

// ===== REAL-TIME SUBSCRIPTIONS =====
function sbSubscribeTransactions(callback) {
    return db.channel('transactions-channel')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'transactions' }, payload => {
            const t = payload.new;
            callback({
                id:            t.id,
                date:          t.date,
                user:          t.username,
                paymentMethod: t.payment_method,
                customerName:  t.customer_name || 'N/A',
                items:         t.items,
                totalItems:    t.total_items,
                subtotal:      parseFloat(t.subtotal),
                cash:          parseFloat(t.cash || 0),
                change:        parseFloat(t.change || 0)
            });
        })
        .subscribe();
}

function sbSubscribeProducts(callback) {
    return db.channel('products-channel')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'products' }, payload => {
            callback(payload);
        })
        .subscribe();
}

function sbSubscribeSessions(callback) {
    return db.channel('sessions-channel')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'active_sessions' }, payload => {
            callback(payload);
        })
        .subscribe();
}