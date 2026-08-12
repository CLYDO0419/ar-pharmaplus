// Data Storage
let currentUser = null;
let sessionStartTime = null;
let users = [
    { username: 'superadmin', password: 'super123',   role: 'superadmin' },
    { username: 'admin',      password: 'admin123',   role: 'admin'      },
    { username: 'cashier',    password: 'cashier123', role: 'cashier'    },
    { username: 'monitoring', password: 'monitor123', role: 'monitor'    }
];

let products = [
    { barcode: '001', name: 'Paracetamol 500mg', brand: 'Biogesic', price: 5.50, stock: 100 },
    { barcode: '002', name: 'Amoxicillin 500mg', brand: 'Amoxil', price: 12.00, stock: 50 },
    { barcode: '003', name: 'Ibuprofen 200mg', brand: 'Advil', price: 8.75, stock: 75 },
    { barcode: '004', name: 'Cetirizine 10mg', brand: 'Zyrtec', price: 6.50, stock: 80 },
    { barcode: '005', name: 'Vitamin C 500mg', brand: 'Ceelin', price: 15.00, stock: 120 }
];

let transactions = [];
let cart = [];
let calcValue = '';
let isLocked = false;
let deleteCallback = null;
let deleteItemInfo = null;
let cashValue = '';
let paymentMethod = 'cash'; // cash, ecash, card

// ===== DATA LAYER — Supabase with localStorage fallback =====

let sbReady = false; // true once Supabase loaded successfully

async function loadData() {
    // Always load from localStorage first for instant startup
    const savedUsers        = localStorage.getItem('pharmacyUsers');
    const savedProducts     = localStorage.getItem('pharmacyProducts');
    const savedTransactions = localStorage.getItem('pharmacyTransactions');
    const savedSession      = localStorage.getItem('pharmacySession');

    if (savedUsers)        users        = JSON.parse(savedUsers);
    if (savedProducts)     products     = JSON.parse(savedProducts);
    if (savedTransactions) transactions = JSON.parse(savedTransactions);

    // Ensure monitoring user always exists locally
    if (!users.find(u => u.role === 'monitor')) {
        users.push({ username: 'monitoring', password: 'monitor123', role: 'monitor' });
    }
    if (!users.find(u => u.role === 'superadmin')) {
        users = [
            { username: 'superadmin', password: 'super123',   role: 'superadmin' },
            { username: 'admin',      password: 'admin123',   role: 'admin'      },
            { username: 'cashier',    password: 'cashier123', role: 'cashier'    },
            { username: 'monitoring', password: 'monitor123', role: 'monitor'    }
        ];
    }

    // Try to sync from Supabase if online
    if (navigator.onLine) {
        await syncFromSupabase();
    }

    // Restore session
    if (savedSession) {
        const session = JSON.parse(savedSession);
        const user    = users.find(u => u.username === session.username);
        if (user) {
            currentUser      = user;
            sessionStartTime = new Date(session.startTime);
            isLocked         = session.isLocked || false;
            restoreSession();
        }
    }
}

async function syncFromSupabase() {
    try {
        // Sync users
        const sbUsers = await sbGetUsers();
        if (sbUsers && sbUsers.length > 0) {
            users = sbUsers.map(u => ({
                username: u.username,
                password: u.password,
                role:     u.role
            }));
            localStorage.setItem('pharmacyUsers', JSON.stringify(users));
        }

        // Sync products
        const sbProds = await sbGetProducts();
        if (sbProds && sbProds.length > 0) {
            products = sbProds.map(p => ({
                barcode: p.barcode,
                name:    p.name,
                brand:   p.brand,
                price:   parseFloat(p.price),
                stock:   parseInt(p.stock)
            }));
            localStorage.setItem('pharmacyProducts', JSON.stringify(products));
        }

        // Sync transactions
        const sbTxns = await sbGetTransactions();
        if (sbTxns && sbTxns.length > 0) {
            transactions = sbTxns;
            localStorage.setItem('pharmacyTransactions', JSON.stringify(transactions));
        }

        sbReady = true;
        console.log('[sb] Sync complete ✅');

        // Push any offline queued transactions to Supabase
        await syncOfflineQueue();

    } catch (e) {
        console.warn('[sb] Sync failed, using localStorage:', e.message);
    }
}

// Save data — writes to BOTH Supabase and localStorage
function saveData() {
    localStorage.setItem('pharmacyUsers',        JSON.stringify(users));
    localStorage.setItem('pharmacyProducts',     JSON.stringify(products));
    localStorage.setItem('pharmacyTransactions', JSON.stringify(transactions));
}

// ===== ONLINE / OFFLINE SYSTEM =====
let isOnline = navigator.onLine;

function getOfflineQueue() {
    return JSON.parse(localStorage.getItem('pharmacyOfflineQueue') || '[]');
}

function saveOfflineQueue(queue) {
    localStorage.setItem('pharmacyOfflineQueue', JSON.stringify(queue));
}

function queueTransactionOffline(transaction) {
    const queue = getOfflineQueue();
    transaction._queued  = new Date().toISOString();
    transaction._synced  = false;
    queue.push(transaction);
    saveOfflineQueue(queue);
    updateConnUI();
}

async function syncOfflineQueue() {
    const queue = getOfflineQueue();
    if (queue.length === 0) return;

    const synced = [];
    for (const t of queue) {
        const ok = await sbSaveTransaction(t);
        if (ok) {
            // Also ensure it's in local transactions
            if (!transactions.find(tx => tx.id === t.id)) {
                transactions.push(t);
            }
            synced.push(t.id);
        }
    }

    if (synced.length > 0) {
        const remaining = queue.filter(t => !synced.includes(t.id));
        saveOfflineQueue(remaining);
        saveData();
        updateConnUI();
        console.log(`[sb] ${synced.length} offline transaction(s) synced to Supabase.`);
        showSyncToast(synced.length);
        if (currentUser && currentUser.role === 'monitor') refreshMonitoring();
    }
}

function showSyncToast(count) {
    const msg = `✅ ${count} offline transaction${count !== 1 ? 's' : ''} synced successfully!`;
    showAlert(msg, 'Sync Complete');
}

function updateConnUI() {
    const online    = navigator.onLine;
    const queue     = getOfflineQueue();
    const pending   = queue.length;

    // Nav badge
    const dot       = document.getElementById('connDot');
    const text      = document.getElementById('connText');
    const pendBadge = document.getElementById('pendingBadge');
    const banner    = document.getElementById('offlineBanner');
    const syncCount = document.getElementById('offlineSyncCount');

    // Header badge
    const hDot  = document.getElementById('headerOnlineDot');
    const hText = document.getElementById('headerOnlineText');

    // Footer badge
    const fDot  = document.getElementById('footerOnlineDot');
    const fText = document.getElementById('footerOnlineText');

    if (online) {
        if (dot)  { dot.classList.remove('offline'); }
        if (text) { text.textContent = 'ONLINE'; }
        if (banner) { banner.classList.remove('visible'); }
        if (hDot)  { hDot.classList.remove('offline'); }
        if (hText) { hText.textContent = 'ONLINE'; }
        if (fDot)  { fDot.classList.remove('offline'); }
        if (fText) { fText.textContent = 'ONLINE'; }
    } else {
        if (dot)  { dot.classList.add('offline'); }
        if (text) { text.textContent = 'OFFLINE'; }
        if (banner) { banner.classList.add('visible'); }
        if (hDot)  { hDot.classList.add('offline'); }
        if (hText) { hText.textContent = 'OFFLINE'; }
        if (fDot)  { fDot.classList.add('offline'); }
        if (fText) { fText.textContent = 'OFFLINE'; }
    }

    if (pendBadge) {
        if (pending > 0) {
            pendBadge.style.display = 'inline';
            pendBadge.textContent   = pending + ' pending';
        } else {
            pendBadge.style.display = 'none';
        }
    }
    if (syncCount) {
        syncCount.textContent = pending + ' pending';
    }

    // Also refresh monitoring panel if open
    const monDot  = document.getElementById('monitorConnDot');
    const monText = document.getElementById('monitorConnText');
    if (monDot)  { monDot.classList.toggle('offline', !online); }
    if (monText) { monText.textContent = online ? 'ONLINE' : 'OFFLINE'; }

    isOnline = online;
}

// Listen for online/offline events
window.addEventListener('online', async () => {
    isOnline = true;
    updateConnUI();
    await syncFromSupabase();
    await syncOfflineQueue();
    if (currentUser && currentUser.role === 'monitor') refreshMonitoring();
});

window.addEventListener('offline', () => {
    isOnline = false;
    updateConnUI();
});

// Save session to localStorage
function saveSession() {
    if (currentUser && sessionStartTime) {
        const session = {
            username: currentUser.username,
            startTime: sessionStartTime.toISOString(),
            isLocked: isLocked
        };
        localStorage.setItem('pharmacySession', JSON.stringify(session));
    }
}

// Clear session from localStorage
function clearSession() {
    localStorage.removeItem('pharmacySession');
}

// Restore session after page reload
function restoreSession() {
    document.getElementById('currentUser').textContent = currentUser.username + ' (' + currentUser.role + ')';
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('navigationBar').style.display = 'flex';
    document.getElementById('mainContent').style.display = 'block';
    
    // Show/hide tabs based on role
    applyRolePermissions();
    
    displayProducts();
    displayInventory();
    displayUsers();
    
    // Show default tab based on role
    if (currentUser.role === 'cashier') {
        showTab('pos');
        // Re-enter fullscreen lock if was locked
        if (isLocked) {
            setTimeout(() => {
                enterFullscreen();
            }, 500);
        }
    } else if (currentUser.role === 'admin') {
        showTab('inventory');
    } else if (currentUser.role === 'monitor') {
        showTab('monitoring');
        refreshMonitoring();
    } else {
        showTab('pos');
    }
}

// Custom Alert (replaces browser alert)
function showAlert(message, title = 'Notice') {
    document.getElementById('alertTitle').textContent = title;
    document.getElementById('alertMessage').textContent = message;
    document.getElementById('alertModal').style.display = 'block';
}

function closeAlertModal() {
    document.getElementById('alertModal').style.display = 'none';
}

// Delete Confirmation Modal
function showDeleteConfirm(message, callback, itemInfo) {
    document.getElementById('deleteMessage').textContent = message;
    document.getElementById('deleteConfirmInput').value = '';
    document.getElementById('deleteModal').style.display = 'block';
    document.getElementById('deleteConfirmInput').focus();
    deleteCallback = callback;
    deleteItemInfo = itemInfo;
}

function closeDeleteModal() {
    document.getElementById('deleteModal').style.display = 'none';
    deleteCallback = null;
    deleteItemInfo = null;
}

function confirmDelete() {
    const input = document.getElementById('deleteConfirmInput').value;
    if (input === 'Y' || input === 'y') {
        if (deleteCallback) {
            deleteCallback(deleteItemInfo);
        }
        closeDeleteModal();
    } else {
        showAlert('Please type Y or y to confirm deletion', 'Invalid Input');
    }
}

// Checkout Modal
function showCheckoutModal() {
    document.getElementById('checkoutModal').style.display = 'block';
    
    // Focus on the OK button for Enter key
    setTimeout(() => {
        document.getElementById('checkoutOkBtn').focus();
    }, 100);
}

function closeCheckoutModal() {
    document.getElementById('checkoutModal').style.display = 'none';
    
    // Focus back to barcode scanner for next transaction
    const barcodeInput = document.getElementById('barcodeInput');
    if (barcodeInput) {
        barcodeInput.focus();
    }
}

// Show Change User (redirect to login)
function showChangeUser() {
    logout();
}

// Quick Login (Temporary for testing)
function quickLogin(role) {
    const user = users.find(u => u.role === role);
    if (user) {
        currentUser = user;
        sessionStartTime = new Date();
        document.getElementById('currentUser').textContent = user.username + ' (' + user.role + ')';
        document.getElementById('loginScreen').style.display = 'none';
        document.getElementById('navigationBar').style.display = 'flex';
        document.getElementById('mainContent').style.display = 'block';
        
        // Show/hide tabs based on role
        applyRolePermissions();
        
        displayProducts();
        displayInventory();
        displayUsers();
        
        // Save session + mark online
        saveSession();
        markUserOnline(user.username);
        
        // Show default tab based on role
        if (user.role === 'cashier') {
            showTab('pos');
            // Auto-lock fullscreen for cashiers
            setTimeout(() => {
                enterFullscreen();
            }, 500);
        } else if (user.role === 'admin') {
            showTab('inventory');
        } else if (user.role === 'monitor') {
            showTab('monitoring');
            refreshMonitoring();
        } else {
            showTab('pos');
        }
    }
}

// Login
function login() {
    const username = document.getElementById('loginUsername').value;
    const password = document.getElementById('loginPassword').value;
    
    const user = users.find(u => u.username === username && u.password === password);
    
    if (user) {
        currentUser = user;
        sessionStartTime = new Date();
        document.getElementById('currentUser').textContent = user.username + ' (' + user.role + ')';
        document.getElementById('loginScreen').style.display = 'none';
        document.getElementById('navigationBar').style.display = 'flex';
        document.getElementById('mainContent').style.display = 'block';
        
        // Show/hide tabs based on role
        applyRolePermissions();
        
        displayProducts();
        displayInventory();
        displayUsers();
        
        // Save session
        saveSession();
        markUserOnline(user.username);
        
        // Show default tab based on role
        if (user.role === 'cashier') {
            showTab('pos');
            // Auto-lock fullscreen for cashiers
            setTimeout(() => {
                enterFullscreen();
            }, 500);
        } else if (user.role === 'admin') {
            showTab('inventory');
        } else if (user.role === 'monitor') {
            showTab('monitoring');
            refreshMonitoring();
        } else {
            showTab('pos');
        }
    } else {
        showAlert('Invalid username or password', 'Login Failed');
    }
}

// Apply role-based permissions
function applyRolePermissions() {
    const posTab = document.querySelector('[onclick="showTab(\'pos\')"]');
    const inventoryTab = document.querySelector('[onclick="showTab(\'inventory\')"]');
    const dataEntryTab = document.querySelector('[onclick="showTab(\'dataEntry\')"]');
    const reportsTab = document.querySelector('[onclick="showTab(\'reports\')"]');
    const usersTab = document.querySelector('[onclick="showTab(\'users\')"]');
    
    // Hide all tabs first
    posTab.style.display = 'none';
    inventoryTab.style.display = 'none';
    dataEntryTab.style.display = 'none';
    reportsTab.style.display = 'none';
    usersTab.style.display = 'none';

    // Hide monitor tab
    document.querySelectorAll('.monitor-only').forEach(el => el.style.display = 'none');
    
    if (currentUser.role === 'superadmin') {
        posTab.style.display = 'block';
        inventoryTab.style.display = 'block';
        dataEntryTab.style.display = 'block';
        reportsTab.style.display = 'block';
        usersTab.style.display = 'block';
        document.querySelectorAll('.superadmin-only').forEach(el => el.style.display = 'table-cell');
        initializeReports();
    } else if (currentUser.role === 'admin') {
        inventoryTab.style.display = 'block';
        dataEntryTab.style.display = 'block';
        reportsTab.style.display = 'block';
        document.querySelectorAll('.superadmin-only').forEach(el => el.style.display = 'none');
        initializeReports();
    } else if (currentUser.role === 'cashier') {
        posTab.style.display = 'block';
        document.querySelectorAll('.superadmin-only').forEach(el => el.style.display = 'none');
    } else if (currentUser.role === 'monitor') {
        // Monitor: only sees the monitoring dashboard
        document.querySelectorAll('.monitor-only').forEach(el => el.style.display = 'block');
        document.querySelectorAll('.superadmin-only').forEach(el => el.style.display = 'none');
    }
}

// Logout
function logout() {
    // Generate session report before logout
    if (currentUser && sessionStartTime) {
        generateSessionReport(currentUser, sessionStartTime);
    }
    
    // Mark user offline before clearing
    if (currentUser) {
        markUserOffline(currentUser.username);
    }
    
    // Clear session
    clearSession();
    
    currentUser = null;
    sessionStartTime = null;
    cart = [];
    isLocked = false;
    document.getElementById('loginScreen').style.display = 'flex';
    document.getElementById('navigationBar').style.display = 'none';
    document.getElementById('mainContent').style.display = 'none';
    document.getElementById('loginUsername').value = '';
    document.getElementById('loginPassword').value = '';
    
    // Exit fullscreen if locked
    if (document.fullscreenElement) {
        if (document.exitFullscreen) {
            document.exitFullscreen();
        } else if (document.webkitExitFullscreen) {
            document.webkitExitFullscreen();
        }
    }
    
    // Reset lock button
    document.getElementById('lockBtn').classList.remove('locked');
    document.getElementById('lockIcon').textContent = '🔓';
    const lockBtnText = document.getElementById('lockBtn');
    lockBtnText.innerHTML = '<span id="lockIcon">🔓</span> LOCK SCREEN';
}

// Tab Navigation
function showTab(tabName) {
    document.querySelectorAll('.tab-content').forEach(tab => tab.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    
    const tabEl = document.getElementById(tabName + 'Tab');
    if (tabEl) tabEl.classList.add('active');

    // Highlight the matching nav button
    document.querySelectorAll('.tab-btn').forEach(btn => {
        if (btn.getAttribute('onclick') === "showTab('" + tabName + "')") {
            btn.classList.add('active');
        }
    });
}

// Display Products in POS
function displayProducts(filter = '') {
    const list = document.getElementById('productsGrid');
    list.innerHTML = '';
    
    const filtered = products.filter(p => 
        p.name.toLowerCase().includes(filter.toLowerCase()) ||
        p.barcode.includes(filter) ||
        p.price.toString().includes(filter) ||
        p.brand.toLowerCase().includes(filter.toLowerCase())
    );
    
    filtered.forEach(product => {
        const row = document.createElement('div');
        row.className = 'product-row';
        row.onclick = () => addToCart(product);
        row.innerHTML = `
            <div class="product-info">
                <div class="product-name">${product.name}</div>
                <div class="product-brand">${product.brand}</div>
            </div>
            <div class="product-stock">Stock: ${product.stock}</div>
            <div class="product-price">₱${product.price.toFixed(2)}</div>
        `;
        list.appendChild(row);
    });
}

// Search Products
function searchProducts() {
    const searchTerm = document.getElementById('searchInput').value;
    displayProducts(searchTerm);
}

// Add to Cart
function addToCart(product) {
    if (product.stock <= 0) {
        showAlert('Product out of stock!', 'Out of Stock');
        return;
    }
    
    const existingItem = cart.find(item => item.barcode === product.barcode);
    
    if (existingItem) {
        if (existingItem.quantity < product.stock) {
            existingItem.quantity++;
        } else {
            showAlert('Not enough stock!', 'Stock Limit');
            return;
        }
    } else {
        cart.push({ ...product, quantity: 1 });
    }
    
    updateCart();
}

// Remove from Cart
function removeFromCart(barcode) {
    cart = cart.filter(item => item.barcode !== barcode);
    updateCart();
}

// Update Cart Display
function updateCart() {
    const cartItems = document.getElementById('cartItems');
    cartItems.innerHTML = '';
    
    let total = 0;
    
    cart.forEach(item => {
        const itemTotal = item.price * item.quantity;
        total += itemTotal;
        
        const cartItem = document.createElement('div');
        cartItem.className = 'cart-item';
        cartItem.innerHTML = `
            <div class="cart-item-info">
                <div class="cart-item-name">${item.name}</div>
                <div class="cart-item-price">₱${item.price.toFixed(2)}</div>
            </div>
            <div class="cart-item-controls">
                <button onclick="decreaseQuantity('${item.barcode}')" class="qty-btn">-</button>
                <input type="number" value="${item.quantity}" min="1" max="${item.stock}" 
                       onchange="setQuantity('${item.barcode}', this.value)" 
                       class="qty-input">
                <button onclick="increaseQuantity('${item.barcode}')" class="qty-btn">+</button>
            </div>
            <div class="cart-item-total">₱${itemTotal.toFixed(2)}</div>
            <button onclick="removeFromCart('${item.barcode}')" class="cart-remove-btn">X</button>
        `;
        cartItems.appendChild(cartItem);
    });
    
    document.getElementById('cartTotal').textContent = total.toFixed(2);
    document.getElementById('paymentTotal').textContent = total.toFixed(2);
    
    // Update change calculation
    updateChange();
}

// Set quantity directly
function setQuantity(barcode, value) {
    const cartItem = cart.find(item => item.barcode === barcode);
    const product = products.find(p => p.barcode === barcode);
    
    if (cartItem && product) {
        const newQty = parseInt(value);
        
        if (isNaN(newQty) || newQty < 1) {
            showAlert('Quantity must be at least 1', 'Invalid Quantity');
            updateCart();
            return;
        }
        
        if (newQty > product.stock) {
            showAlert(`Only ${product.stock} items available in stock!`, 'Stock Limit');
            cartItem.quantity = product.stock;
        } else {
            cartItem.quantity = newQty;
        }
        
        updateCart();
    }
}

// Increase quantity
function increaseQuantity(barcode) {
    const cartItem = cart.find(item => item.barcode === barcode);
    const product = products.find(p => p.barcode === barcode);
    
    if (cartItem && product) {
        if (cartItem.quantity < product.stock) {
            cartItem.quantity++;
            updateCart();
        } else {
            showAlert('Not enough stock!', 'Stock Limit');
        }
    }
}

// Decrease quantity
function decreaseQuantity(barcode) {
    const cartItem = cart.find(item => item.barcode === barcode);
    
    if (cartItem) {
        if (cartItem.quantity > 1) {
            cartItem.quantity--;
            updateCart();
        } else {
            removeFromCart(barcode);
        }
    }
}

// Checkout
function checkout() {
    if (cart.length === 0) {
        showAlert('Cart is empty!', 'Empty Cart');
        return;
    }
    
    const total = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    const amount = parseFloat(cashValue) || 0;
    const customerName = document.getElementById('customerNameInput').value.trim();
    
    let change = 0;
    let paymentLabel = '';
    
    // Validate based on payment method
    if (paymentMethod === 'cash') {
        if (amount < total) {
            showAlert('Insufficient cash amount!', 'Payment Error');
            return;
        }
        change = amount - total;
        paymentLabel = 'Cash';
    } else if (paymentMethod === 'ecash') {
        if (amount === 0) {
            showAlert('Please enter E-Cash amount!', 'Payment Error');
            return;
        }
        paymentLabel = 'E-Cash';
    } else if (paymentMethod === 'card') {
        if (amount === 0) {
            showAlert('Please enter Card amount!', 'Payment Error');
            return;
        }
        paymentLabel = 'Card';
    }
    
    // Save transaction
    const transaction = {
        id: Date.now(),
        date: new Date().toISOString(),
        user: currentUser.username,
        paymentMethod: paymentMethod,
        customerName: customerName || 'N/A',
        items: cart.map(item => ({
            barcode: item.barcode,
            name: item.name,
            brand: item.brand,
            price: item.price,
            quantity: item.quantity,
            total: item.price * item.quantity
        })),
        totalItems: cart.reduce((sum, item) => sum + item.quantity, 0),
        subtotal: total,
        cash: amount,
        change: change
    };
    
    transactions.push(transaction);
    
    // Save to Supabase if online, otherwise queue offline
    if (navigator.onLine) {
        sbSaveTransaction(transaction).then(ok => {
            if (!ok) queueTransactionOffline({ ...transaction });
        });
        // Deduct stock in Supabase
        cart.forEach(item => sbDeductStock(item.barcode, item.quantity));
    } else {
        queueTransactionOffline({ ...transaction });
    }
    
    // Update stock
    cart.forEach(cartItem => {
        const product = products.find(p => p.barcode === cartItem.barcode);
        if (product) {
            product.stock -= cartItem.quantity;
        }
    });
    
    // Show appropriate message
    let message = '';
    
    if (paymentMethod === 'cash') {
        message = `
            <div class="receipt-line">
                <span class="receipt-label">TOTAL:</span>
                <span class="receipt-value">₱${total.toFixed(2)}</span>
            </div>
            <div class="receipt-line">
                <span class="receipt-label">CASH:</span>
                <span class="receipt-value">₱${amount.toFixed(2)}</span>
            </div>
            <div class="receipt-divider"></div>
            <div class="receipt-change">
                <div class="change-label">CHANGE</div>
                <div class="change-amount">₱${change.toFixed(2)}</div>
            </div>
        `;
    } else {
        const methodLabel = paymentMethod === 'ecash' ? 'E-CASH' : 'CARD';
        message = `
            <div class="receipt-line">
                <span class="receipt-label">TOTAL:</span>
                <span class="receipt-value">₱${total.toFixed(2)}</span>
            </div>
            <div class="receipt-line">
                <span class="receipt-label">${methodLabel}:</span>
                <span class="receipt-value">₱${amount.toFixed(2)}</span>
            </div>
            <div class="receipt-divider"></div>
            <div class="receipt-thankyou">THANK YOU!</div>
        `;
    }
    
    document.getElementById('checkoutMessage').innerHTML = message;
    showCheckoutModal();
    
    cart = [];
    cashValue = '';
    paymentMethod = 'cash';
    selectPaymentMethod('cash');
    updateCart();
    cashClear();
    displayProducts();
    displayInventory();
    saveData();
}

// Void Transaction
function voidTransaction() {
    if (cart.length === 0) {
        showAlert('Cart is already empty!', 'Nothing to Void');
        return;
    }
    
    showDeleteConfirm(
        `Are you sure you want to void this transaction?\n\nThis will clear all ${cart.length} item(s) from the cart.`,
        () => {
            cart = [];
            cashValue = '';
            updateCart();
            cashClear();
            showAlert('Transaction voided successfully!', 'Transaction Voided');
            
            // Refocus on barcode scanner
            const barcodeInput = document.getElementById('barcodeInput');
            if (barcodeInput) {
                barcodeInput.focus();
            }
        },
        null
    );
}

// Payment Method Selection
function selectPaymentMethod(method) {
    paymentMethod = method;
    
    // Update button states
    document.querySelectorAll('.payment-method-btn').forEach(btn => btn.classList.remove('active'));
    document.getElementById(method + 'MethodBtn').classList.add('active');
    
    // Update display rows
    const cashRow = document.getElementById('cashRow');
    const ecashRow = document.getElementById('ecashRow');
    const cardRow = document.getElementById('cardRow');
    const changeRow = document.getElementById('changeRow');
    const customerNameInput = document.getElementById('customerNameInput');
    const cashInput = document.getElementById('cashInput');
    
    // Hide all payment rows
    cashRow.style.display = 'none';
    ecashRow.style.display = 'none';
    cardRow.style.display = 'none';
    customerNameInput.style.display = 'none';
    
    // Show relevant row and change row
    if (method === 'cash') {
        cashRow.style.display = 'flex';
        changeRow.style.display = 'flex';
        cashInput.placeholder = 'Enter cash amount';
    } else if (method === 'ecash') {
        ecashRow.style.display = 'flex';
        changeRow.style.display = 'none';
        cashInput.placeholder = 'Enter E-Cash amount';
    } else if (method === 'card') {
        cardRow.style.display = 'flex';
        changeRow.style.display = 'none';
        cashInput.placeholder = 'Enter Card amount';
    }
    
    // Clear inputs
    cashClear();
    customerNameInput.value = '';
}

// Payment Calculator Functions
function cashInput(value) {
    cashValue += value;
    document.getElementById('cashInput').value = cashValue;
    
    const amount = parseFloat(cashValue || 0);
    
    if (paymentMethod === 'cash') {
        document.getElementById('cashAmount').textContent = amount.toFixed(2);
        updateChange();
    } else if (paymentMethod === 'ecash') {
        document.getElementById('ecashAmount').textContent = amount.toFixed(2);
    } else if (paymentMethod === 'card') {
        document.getElementById('cardAmount').textContent = amount.toFixed(2);
    }
}

function cashClear() {
    cashValue = '';
    document.getElementById('cashInput').value = '';
    document.getElementById('cashAmount').textContent = '0.00';
    document.getElementById('ecashAmount').textContent = '0.00';
    document.getElementById('cardAmount').textContent = '0.00';
    document.getElementById('changeAmount').textContent = '0.00';
}

function quickCash(amount) {
    cashValue = amount.toString();
    document.getElementById('cashInput').value = cashValue;
    document.getElementById('cashAmount').textContent = amount.toFixed(2);
    updateChange();
}

function updateChange() {
    const total = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    const cash = parseFloat(cashValue) || 0;
    const change = cash - total;
    
    if (change >= 0) {
        document.getElementById('changeAmount').textContent = change.toFixed(2);
    } else {
        document.getElementById('changeAmount').textContent = '0.00';
    }
}

// Barcode Scanner
function initBarcodeScanner() {
    const barcodeInput = document.getElementById('barcodeInput');
    if (!barcodeInput) return;
    
    barcodeInput.addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
            const barcode = barcodeInput.value.trim();
            if (barcode) {
                const product = products.find(p => p.barcode === barcode);
                if (product) {
                    addToCart(product);
                    barcodeInput.value = '';
                } else {
                    showAlert('Product not found!', 'Invalid Barcode');
                    barcodeInput.value = '';
                }
            }
        }
    });
    
    // Keep focus on barcode input
    barcodeInput.addEventListener('blur', function() {
        setTimeout(() => {
            if (document.getElementById('posTab').classList.contains('active')) {
                barcodeInput.focus();
            }
        }, 100);
    });
}

// Calculator Functions (Legacy - kept for compatibility)
function calcInput(value) {
    calcValue += value;
    document.getElementById('calcDisplay').value = calcValue;
}

function calcEqual() {
    try {
        calcValue = eval(calcValue).toString();
        document.getElementById('calcDisplay').value = calcValue;
    } catch (e) {
        document.getElementById('calcDisplay').value = 'Error';
        calcValue = '';
    }
}

function calcClear() {
    calcValue = '';
    document.getElementById('calcDisplay').value = '';
}

// Display Inventory
function displayInventory(filter = '') {
    const tbody = document.getElementById('inventoryTableBody');
    tbody.innerHTML = '';
    
    const filtered = products.filter(p => 
        p.name.toLowerCase().includes(filter.toLowerCase()) ||
        p.barcode.includes(filter) ||
        p.brand.toLowerCase().includes(filter.toLowerCase())
    );
    
    const isSuperAdmin = currentUser && currentUser.role === 'superadmin';
    
    filtered.forEach((product) => {
        const row = document.createElement('tr');
        
        if (isSuperAdmin) {
            row.innerHTML = `
                <td>${product.barcode}</td>
                <td>${product.name}</td>
                <td>${product.brand}</td>
                <td>₱${product.price.toFixed(2)}</td>
                <td>${product.stock}</td>
                <td class="superadmin-only">
                    <button class="btn-edit" onclick="openEditModal('${product.barcode}')">Edit</button>
                    <button class="btn-delete" onclick="deleteProduct('${product.barcode}')">Delete</button>
                </td>
            `;
        } else {
            row.innerHTML = `
                <td>${product.barcode}</td>
                <td>${product.name}</td>
                <td>${product.brand}</td>
                <td>₱${product.price.toFixed(2)}</td>
                <td>${product.stock}</td>
            `;
        }
        
        tbody.appendChild(row);
    });
}

// Open Edit Modal
function openEditModal(barcode) {
    const product = products.find(p => p.barcode === barcode);
    if (!product) return;
    
    document.getElementById('editOldBarcode').value = product.barcode;
    document.getElementById('editBarcode').value = product.barcode;
    document.getElementById('editName').value = product.name;
    document.getElementById('editBrand').value = product.brand;
    document.getElementById('editPrice').value = product.price;
    document.getElementById('editStock').value = product.stock;
    
    document.getElementById('editModal').style.display = 'block';
}

// Close Edit Modal
function closeEditModal() {
    document.getElementById('editModal').style.display = 'none';
}

// Save Product Edit
async function saveProductEdit(event) {
    event.preventDefault();
    
    if (!currentUser || currentUser.role !== 'superadmin') {
        showAlert('Only super admins can edit inventory!', 'Access Denied');
        return;
    }
    
    const oldBarcode = document.getElementById('editOldBarcode').value;
    const newBarcode = document.getElementById('editBarcode').value;
    const name       = document.getElementById('editName').value;
    const brand      = document.getElementById('editBrand').value;
    const price      = parseFloat(document.getElementById('editPrice').value);
    const stock      = parseInt(document.getElementById('editStock').value);
    
    if (newBarcode !== oldBarcode && products.find(p => p.barcode === newBarcode)) {
        showAlert('Barcode already exists!', 'Duplicate Barcode');
        return;
    }
    
    const product = products.find(p => p.barcode === oldBarcode);
    if (product) {
        product.barcode = newBarcode;
        product.name    = name;
        product.brand   = brand;
        product.price   = price;
        product.stock   = stock;

        if (navigator.onLine) {
            await sbUpdateProduct(oldBarcode, product);
        }
        
        saveData();
        displayInventory();
        displayProducts();
        closeEditModal();
        showAlert('Product updated successfully!', 'Success');
    }
}

// Delete Product (Super Admin only)
function deleteProduct(barcode) {
    if (!currentUser || currentUser.role !== 'superadmin') {
        showAlert('Only super admins can delete products!', 'Access Denied');
        return;
    }
    
    const product = products.find(p => p.barcode === barcode);
    if (!product) return;
    
    showDeleteConfirm(
        `Are you sure you want to delete: ${product.name}?`,
        async (barcode) => {
            products = products.filter(p => p.barcode !== barcode);
            if (navigator.onLine) await sbDeleteProduct(barcode);
            displayInventory();
            displayProducts();
            saveData();
            showAlert('Product deleted successfully!', 'Deleted');
        },
        barcode
    );
}

// Filter Inventory
function filterInventory() {
    const searchTerm = document.getElementById('invSearchInput').value;
    displayInventory(searchTerm);
}

// Add Product
async function addProduct(event) {
    event.preventDefault();
    
    const barcode = document.getElementById('productBarcode').value.trim();
    const name    = document.getElementById('productName').value.trim();
    const brand   = document.getElementById('productBrand').value.trim();
    const price   = parseFloat(document.getElementById('productPrice').value);
    const stock   = parseInt(document.getElementById('productStock').value);
    
    if (products.find(p => p.barcode === barcode)) {
        showAlert('Product with this barcode already exists!', 'Duplicate Barcode');
        return;
    }
    
    const product = { barcode, name, brand, price, stock };
    products.push(product);
    
    // Save to Supabase if online
    if (navigator.onLine) {
        const ok = await sbAddProduct(product);
        if (!ok) showAlert('Saved locally — will sync when connection is stable.', 'Notice');
    }

    saveData();
    displayProducts();
    displayInventory();
    showAlert('Product added successfully!', 'Success');
    
    document.getElementById('productBarcode').value = '';
    document.getElementById('productName').value    = '';
    document.getElementById('productBrand').value   = '';
    document.getElementById('productPrice').value   = '';
    document.getElementById('productStock').value   = '';
}

// Display Users
function displayUsers() {
    if (!currentUser || currentUser.role !== 'superadmin') return;
    
    const tbody = document.getElementById('usersTableBody');
    tbody.innerHTML = '';
    
    users.forEach(user => {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${user.username}</td>
            <td>${user.role}</td>
            <td>
                <button class="btn-edit" onclick="openEditUserModal('${user.username}')">Edit</button>
                <button class="btn-delete" onclick="deleteUser('${user.username}')">Delete</button>
            </td>
        `;
        tbody.appendChild(row);
    });
}

// Open Edit User Modal
function openEditUserModal(username) {
    const user = users.find(u => u.username === username);
    if (!user) return;
    
    document.getElementById('editUserOldUsername').value = user.username;
    document.getElementById('editUsername').value = user.username;
    document.getElementById('editUserPassword').value = user.password;
    document.getElementById('editUserRole').value = user.role;
    
    document.getElementById('editUserModal').style.display = 'block';
}

// Close Edit User Modal
function closeEditUserModal() {
    document.getElementById('editUserModal').style.display = 'none';
}

// Save User Edit
async function saveUserEdit(event) {
    event.preventDefault();
    
    if (!currentUser || currentUser.role !== 'superadmin') {
        showAlert('Only super admins can edit users!', 'Access Denied');
        return;
    }
    
    const oldUsername = document.getElementById('editUserOldUsername').value;
    const newUsername = document.getElementById('editUsername').value;
    const password    = document.getElementById('editUserPassword').value;
    const role        = document.getElementById('editUserRole').value;
    
    if (newUsername !== oldUsername && users.find(u => u.username === newUsername)) {
        showAlert('Username already exists!', 'Duplicate Username');
        return;
    }
    
    const user = users.find(u => u.username === oldUsername);
    if (user) {
        user.username = newUsername;
        user.password = password;
        user.role     = role;
        
        if (currentUser.username === oldUsername) {
            currentUser = user;
            document.getElementById('currentUser').textContent = user.username + ' (' + user.role + ')';
        }

        if (navigator.onLine) await sbUpdateUser(oldUsername, user);
        
        saveData();
        displayUsers();
        closeEditUserModal();
        showAlert('User updated successfully!', 'Success');
    }
}

// Add User (Super Admin only)
async function addUser(event) {
    event.preventDefault();
    
    if (!currentUser || currentUser.role !== 'superadmin') {
        showAlert('Only super admins can add users!', 'Access Denied');
        return;
    }
    
    const username = document.getElementById('newUsername').value.trim();
    const password = document.getElementById('newPassword').value;
    const role     = document.getElementById('newUserRole').value;
    
    if (users.find(u => u.username === username)) {
        showAlert('Username already exists!', 'Duplicate Username');
        return;
    }
    
    const newUser = { username, password, role };
    users.push(newUser);

    if (navigator.onLine) await sbAddUser(newUser);
    
    saveData();
    displayUsers();
    showAlert('User added successfully!', 'Success');
    
    document.getElementById('newUsername').value = '';
    document.getElementById('newPassword').value = '';
}

// Delete User (Super Admin only)
function deleteUser(username) {
    if (!currentUser || currentUser.role !== 'superadmin') {
        showAlert('Only super admins can delete users!', 'Access Denied');
        return;
    }
    
    if (username === currentUser.username) {
        showAlert('You cannot delete yourself!', 'Error');
        return;
    }
    
    showDeleteConfirm(
        `Are you sure you want to delete user: ${username}?`,
        async (username) => {
            users = users.filter(u => u.username !== username);
            if (navigator.onLine) await sbDeleteUser(username);
            displayUsers();
            saveData();
            showAlert('User deleted successfully!', 'Deleted');
        },
        username
    );
}

// Lock Fullscreen Mode
function toggleLockFullscreen() {
    if (!currentUser) {
        showAlert('Please login first!', 'Not Logged In');
        return;
    }
    
    if (isLocked) {
        // Show unlock overlay and focus password field
        const overlay = document.getElementById('unlockOverlay');
        overlay.classList.add('active');
        // Small delay to ensure overlay is visible before focusing
        setTimeout(() => {
            const input = document.getElementById('unlockPassword');
            input.value = '';
            input.focus();
        }, 50);
    } else {
        // Enter fullscreen and lock
        enterFullscreen();
    }
}

function enterFullscreen() {
    const elem = document.documentElement;
    
    if (elem.requestFullscreen) {
        elem.requestFullscreen();
    } else if (elem.webkitRequestFullscreen) {
        elem.webkitRequestFullscreen();
    } else if (elem.msRequestFullscreen) {
        elem.msRequestFullscreen();
    }
    
    setTimeout(() => {
        isLocked = true;
        document.getElementById('lockBtn').classList.add('locked');
        document.getElementById('lockIcon').textContent = '🔒';
        const lockBtnText = document.getElementById('lockBtn');
        lockBtnText.innerHTML = '<span id="lockIcon">🔒</span> UNLOCK';
        
        // Save session state
        saveSession();
        
        // Prevent ESC key from exiting fullscreen
        document.addEventListener('keydown', preventEscape);
        document.addEventListener('fullscreenchange', handleFullscreenChange);
        document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    }, 500);
}

function preventEscape(e) {
    if (isLocked && e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        document.getElementById('unlockOverlay').classList.add('active');
        document.getElementById('unlockPassword').focus();
        return false;
    }
    // When overlay is active, make sure unlock input keeps focus for typing
    if (isLocked) {
        const overlay = document.getElementById('unlockOverlay');
        if (overlay && overlay.classList.contains('active')) {
            const unlockInput = document.getElementById('unlockPassword');
            // Re-focus the password field if something else stole focus
            if (document.activeElement !== unlockInput && e.key.length === 1) {
                unlockInput.focus();
            }
        }
    }
}

function handleFullscreenChange() {
    if (isLocked && !document.fullscreenElement && !document.webkitFullscreenElement) {
        // Re-enter fullscreen if locked
        setTimeout(() => {
            enterFullscreen();
        }, 100);
    }
}

function unlockFullscreen() {
    const password = document.getElementById('unlockPassword').value;
    
    // Check if password matches super admin user
    const superAdminUser = users.find(u => u.role === 'superadmin' && u.password === password);
    
    if (superAdminUser) {
        isLocked = false;
        document.getElementById('unlockOverlay').classList.remove('active');
        document.getElementById('unlockPassword').value = '';
        document.getElementById('lockBtn').classList.remove('locked');
        document.getElementById('lockIcon').textContent = '🔓';
        const lockBtnText = document.getElementById('lockBtn');
        lockBtnText.innerHTML = '<span id="lockIcon">🔓</span> LOCK SCREEN';
        
        // Save session state
        saveSession();
        
        // Remove event listeners
        document.removeEventListener('keydown', preventEscape);
        document.removeEventListener('fullscreenchange', handleFullscreenChange);
        document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
        
        // Exit fullscreen
        if (document.exitFullscreen) {
            document.exitFullscreen();
        } else if (document.webkitExitFullscreen) {
            document.webkitExitFullscreen();
        } else if (document.msExitFullscreen) {
            document.msExitFullscreen();
        }
        
        alert('Fullscreen unlocked!');
    } else {
        showAlert('Invalid super admin password!', 'Access Denied');
        document.getElementById('unlockPassword').value = '';
    }
}

// Allow Enter key to unlock
document.addEventListener('DOMContentLoaded', function() {
    const unlockInput = document.getElementById('unlockPassword');
    if (unlockInput) {
        unlockInput.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                unlockFullscreen();
            }
        });
    }

    // Click OUTSIDE the unlock box = close overlay (cancel unlock attempt)
    const unlockOverlay = document.getElementById('unlockOverlay');
    if (unlockOverlay) {
        unlockOverlay.addEventListener('click', function(e) {
            // Only close if clicking the dark backdrop, not the box itself
            if (e.target === unlockOverlay) {
                unlockOverlay.classList.remove('active');
                document.getElementById('unlockPassword').value = '';
            } else {
                // Clicking inside the box — keep focus on password field
                document.getElementById('unlockPassword').focus();
            }
        });
    }
    
    // Allow Enter key for login
    const loginUsername = document.getElementById('loginUsername');
    const loginPassword = document.getElementById('loginPassword');
    if (loginUsername && loginPassword) {
        loginUsername.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                login();
            }
        });
        loginPassword.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                login();
            }
        });
    }
    
    // Allow Enter key for delete confirmation
    const deleteInput = document.getElementById('deleteConfirmInput');
    if (deleteInput) {
        deleteInput.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                confirmDelete();
            }
        });
    }
    
    // Allow Enter key for checkout modal
    document.addEventListener('keydown', function(e) {
        const checkoutModal = document.getElementById('checkoutModal');
        if (checkoutModal && checkoutModal.style.display === 'block' && e.key === 'Enter') {
            closeCheckoutModal();
        }
    });
});

// Initialize
loadData();
initBarcodeScanner();
initKeyboardInput();

// Initialize keyboard input for payment calculator
function initKeyboardInput() {
    // Handle all keyboard input for calculator
    document.addEventListener('keydown', function(e) {
        // Don't handle keyboard if login screen is visible
        const loginScreen = document.getElementById('loginScreen');
        if (loginScreen && loginScreen.style.display !== 'none') {
            return;
        }

        // Don't handle keyboard if lock/unlock overlay is active
        const unlockOverlay = document.getElementById('unlockOverlay');
        if (unlockOverlay && unlockOverlay.classList.contains('active')) {
            return;
        }

        // Don't handle keyboard if any modal is open
        const anyModal = document.querySelector('.modal[style*="block"]');
        if (anyModal) {
            return;
        }
        
        // Only handle keyboard input when POS tab is active
        const posTab = document.getElementById('posTab');
        if (!posTab || !posTab.classList.contains('active')) {
            return;
        }
        
        // Get active element
        const activeElement = document.activeElement;
        const customerNameInput = document.getElementById('customerNameInput');
        const barcodeInput = document.getElementById('barcodeInput');
        const cashInputField = document.getElementById('cashInput');
        
        // Don't handle if user is typing in customer name field or barcode (but allow cash input)
        if (activeElement === customerNameInput || activeElement === barcodeInput) {
            return;
        }
        
        // Handle number keys (0-9) and decimal point
        if ((e.key >= '0' && e.key <= '9') || e.key === '.') {
            e.preventDefault();
            
            // Blur any focused element to prevent conflicts
            if (activeElement && activeElement !== cashInputField) {
                activeElement.blur();
            }
            
            // Animate the corresponding button
            animateCalcButton(e.key);
            
            // Add to cash value using the calculator function
            cashInput(e.key);
        }
        // Handle Backspace to remove last digit
        else if (e.key === 'Backspace' && (activeElement === cashInputField || activeElement === document.body)) {
            e.preventDefault();
            
            // Animate clear button
            const clearBtn = document.querySelector('.calc-clear-btn');
            if (clearBtn) {
                clearBtn.classList.add('btn-pressed');
                setTimeout(() => clearBtn.classList.remove('btn-pressed'), 150);
            }
            
            // Remove last character
            cashBackspace();
        }
        // Handle Enter for checkout
        else if (e.key === 'Enter' && cashValue) {
            e.preventDefault();
            checkout();
        }
        // Handle Escape to clear
        else if (e.key === 'Escape') {
            e.preventDefault();
            
            // Animate clear button
            const clearBtn = document.querySelector('.calc-clear-btn');
            if (clearBtn) {
                clearBtn.classList.add('btn-pressed');
                setTimeout(() => clearBtn.classList.remove('btn-pressed'), 150);
            }
            
            cashClear();
        }
    });
}

// Animate calculator button when keyboard key is pressed
function animateCalcButton(key) {
    // Find the button with matching text
    const buttons = document.querySelectorAll('.calc-buttons button');
    let targetButton = null;
    
    buttons.forEach(btn => {
        if (btn.textContent.trim() === key) {
            targetButton = btn;
        }
    });
    
    if (targetButton) {
        targetButton.classList.add('btn-pressed');
        setTimeout(() => {
            targetButton.classList.remove('btn-pressed');
        }, 150);
    }
}

// Add backspace function for calculator
function cashBackspace() {
    if (cashValue.length > 0) {
        cashValue = cashValue.slice(0, -1);
        document.getElementById('cashInput').value = cashValue;
        
        const amount = parseFloat(cashValue || 0);
        
        if (paymentMethod === 'cash') {
            document.getElementById('cashAmount').textContent = amount.toFixed(2);
            updateChange();
        } else if (paymentMethod === 'ecash') {
            document.getElementById('ecashAmount').textContent = amount.toFixed(2);
        } else if (paymentMethod === 'card') {
            document.getElementById('cardAmount').textContent = amount.toFixed(2);
        }
    }
}

// Update date and time
function updateDateTime() {
    const now = new Date();
    const options = { 
        weekday: 'long', 
        year: 'numeric', 
        month: 'long', 
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
    };
    const dateTimeString = now.toLocaleString('en-US', options);
    const dateTimeElement = document.getElementById('currentDateTime');
    if (dateTimeElement) {
        dateTimeElement.textContent = dateTimeString;
    }
}

// Update time every second
setInterval(updateDateTime, 1000);
updateDateTime(); // Initial call

// Bulk Import Variables
let previewData = [];

// Switch Data Entry Mode
function switchDataEntryMode(mode) {
    // Update mode buttons
    document.querySelectorAll('.mode-btn').forEach(btn => btn.classList.remove('active'));
    event.target.classList.add('active');
    
    // Update mode sections
    document.querySelectorAll('.entry-mode').forEach(section => section.classList.remove('active'));
    
    if (mode === 'single') {
        document.getElementById('singleEntryMode').classList.add('active');
    } else if (mode === 'bulk') {
        document.getElementById('bulkEntryMode').classList.add('active');
    }
}

// Handle Excel File Upload
function handleExcelFile(event) {
    const file = event.target.files[0];
    
    if (!file) return;
    
    // Display file name
    document.getElementById('fileName').textContent = `Selected: ${file.name}`;
    
    const reader = new FileReader();
    
    reader.onload = function(e) {
        try {
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, { type: 'array' });
            
            console.log('Workbook loaded:', workbook);
            console.log('Sheet names:', workbook.SheetNames);
            
            // Get first sheet
            const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
            
            console.log('First sheet:', firstSheet);
            
            // Convert to array of arrays (no headers)
            const jsonData = XLSX.utils.sheet_to_json(firstSheet, { header: 1 });
            
            console.log('JSON Data:', jsonData);
            console.log('Number of rows:', jsonData.length);
            
            if (jsonData.length === 0) {
                showAlert('Excel file is empty!', 'Empty File');
                return;
            }
            
            // Process and validate data
            processExcelData(jsonData);
            
        } catch (error) {
            showAlert('Error reading Excel file: ' + error.message, 'File Error');
            console.error('Full error:', error);
        }
    };
    
    reader.onerror = function(error) {
        showAlert('Error reading file: ' + error, 'File Read Error');
        console.error('FileReader error:', error);
    };
    
    reader.readAsArrayBuffer(file);
}

// Process Excel Data
function processExcelData(jsonData) {
    console.log('Processing Excel data...');
    previewData = [];
    
    jsonData.forEach((row, index) => {
        console.log(`Row ${index}:`, row);
        
        // Skip empty rows
        if (!row || row.length === 0) {
            console.log(`Skipping empty row ${index}`);
            return;
        }
        
        // Get values by column position (A, B, C, D, E)
        const barcode = row[0]; // Column A
        const name = row[1];    // Column B
        const brand = row[2];   // Column C
        const price = row[3];   // Column D
        const stock = row[4];   // Column E
        
        console.log(`Parsed - Barcode: ${barcode}, Name: ${name}, Brand: ${brand}, Price: ${price}, Stock: ${stock}`);
        
        // Validate row
        let status = 'Valid';
        let statusClass = 'status-valid';
        
        if (!barcode || !name || !brand || price === undefined || stock === undefined) {
            status = 'Missing Data';
            statusClass = 'status-error';
            console.log(`Row ${index} - Missing data`);
        } else if (isNaN(parseFloat(price)) || isNaN(parseInt(stock))) {
            status = 'Invalid Number';
            statusClass = 'status-error';
            console.log(`Row ${index} - Invalid number`);
        } else if (products.find(p => p.barcode === String(barcode))) {
            status = 'Duplicate Barcode';
            statusClass = 'status-duplicate';
            console.log(`Row ${index} - Duplicate barcode`);
        } else if (previewData.find(p => p.barcode === String(barcode))) {
            status = 'Duplicate in File';
            statusClass = 'status-duplicate';
            console.log(`Row ${index} - Duplicate in file`);
        }
        
        const productData = {
            barcode: String(barcode || ''),
            name: String(name || ''),
            brand: String(brand || ''),
            price: parseFloat(price) || 0,
            stock: parseInt(stock) || 0,
            status: status,
            statusClass: statusClass,
            rowIndex: index + 1 // Excel row number
        };
        
        console.log(`Adding product:`, productData);
        previewData.push(productData);
    });
    
    console.log('Preview data:', previewData);
    displayPreview();
}

// Display Preview
function displayPreview() {
    const tbody = document.getElementById('previewTableBody');
    tbody.innerHTML = '';
    
    const validCount = previewData.filter(p => p.status === 'Valid').length;
    document.getElementById('previewCount').textContent = 
        `${validCount} of ${previewData.length} products ready to import`;
    
    previewData.forEach(item => {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${item.barcode}</td>
            <td>${item.name}</td>
            <td>${item.brand}</td>
            <td>₱${item.price.toFixed(2)}</td>
            <td>${item.stock}</td>
            <td class="${item.statusClass}">${item.status}</td>
        `;
        tbody.appendChild(row);
    });
    
    document.getElementById('previewSection').style.display = 'block';
}

// Import Products
function importProducts() {
    const validProducts = previewData.filter(p => p.status === 'Valid');
    
    if (validProducts.length === 0) {
        showAlert('No valid products to import!', 'Import Error');
        return;
    }
    
    // Add products to inventory
    validProducts.forEach(item => {
        products.push({
            barcode: item.barcode,
            name: item.name,
            brand: item.brand,
            price: item.price,
            stock: item.stock
        });
    });
    
    saveData();
    displayProducts();
    displayInventory();
    
    showAlert(
        `Successfully imported ${validProducts.length} products!\n` +
        `Skipped: ${previewData.length - validProducts.length}`,
        'Import Complete'
    );
    
    // Reset
    cancelImport();
}

// Cancel Import
function cancelImport() {
    previewData = [];
    document.getElementById('excelFileInput').value = '';
    document.getElementById('fileName').textContent = '';
    document.getElementById('previewSection').style.display = 'none';
    document.getElementById('previewTableBody').innerHTML = '';
}

// Reports Functions
function initializeReports() {
    // Set default dates
    const today = new Date();
    const endDate = today.toISOString().split('T')[0];
    const startDate = new Date(today.setDate(today.getDate() - 30)).toISOString().split('T')[0];
    
    document.getElementById('startDate').value = startDate;
    document.getElementById('endDate').value = endDate;
    
    // Populate user filter
    const userFilter = document.getElementById('userFilter');
    userFilter.innerHTML = '<option value="all">All Users</option>';
    users.forEach(user => {
        const option = document.createElement('option');
        option.value = user.username;
        option.textContent = `${user.username} (${user.role})`;
        userFilter.appendChild(option);
    });
    
    // Add event listener for report type change
    document.getElementById('reportType').addEventListener('change', function() {
        const userFilterGroup = document.getElementById('userFilterGroup');
        if (this.value === 'user') {
            userFilterGroup.style.display = 'flex';
        } else {
            userFilterGroup.style.display = 'none';
        }
    });
}

function generateReport() {
    const reportType = document.getElementById('reportType').value;
    const startDate = new Date(document.getElementById('startDate').value);
    const endDate = new Date(document.getElementById('endDate').value);
    endDate.setHours(23, 59, 59, 999); // Include full end date
    
    const userFilter = document.getElementById('userFilter').value;
    
    // Filter transactions
    let filteredTransactions = transactions.filter(t => {
        const transDate = new Date(t.date);
        return transDate >= startDate && transDate <= endDate;
    });
    
    // Apply user filter if needed
    if (reportType === 'user' && userFilter !== 'all') {
        filteredTransactions = filteredTransactions.filter(t => t.user === userFilter);
    }
    
    // Apply payment method filter
    if (reportType === 'cash') {
        filteredTransactions = filteredTransactions.filter(t => t.paymentMethod === 'cash');
    } else if (reportType === 'ecash') {
        filteredTransactions = filteredTransactions.filter(t => t.paymentMethod === 'ecash');
    } else if (reportType === 'card') {
        filteredTransactions = filteredTransactions.filter(t => t.paymentMethod === 'card');
    }
    
    // Calculate summary
    const totalSales = filteredTransactions.reduce((sum, t) => sum + t.subtotal, 0);
    const totalTransactions = filteredTransactions.length;
    const totalItems = filteredTransactions.reduce((sum, t) => sum + t.totalItems, 0);
    const avgSale = totalTransactions > 0 ? totalSales / totalTransactions : 0;
    
    // Update summary cards
    document.getElementById('totalSales').textContent = `₱${totalSales.toFixed(2)}`;
    document.getElementById('totalTransactions').textContent = totalTransactions;
    document.getElementById('totalItems').textContent = totalItems;
    document.getElementById('avgSale').textContent = `₱${avgSale.toFixed(2)}`;
    
    // Display transactions
    displayReportTable(filteredTransactions, reportType);
}

function displayReportTable(filteredTransactions, reportType) {
    const tbody = document.getElementById('reportTableBody');
    const tfoot = document.getElementById('reportTableFooter');
    tbody.innerHTML = '';
    
    if (filteredTransactions.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="7" style="text-align: center; padding: 40px; color: #7a7773;">
                    No transactions found for the selected criteria.
                </td>
            </tr>
        `;
        tfoot.style.display = 'none';
        return;
    }
    
    // Sort by date (newest first)
    filteredTransactions.sort((a, b) => new Date(b.date) - new Date(a.date));
    
    // Calculate totals
    let totalAmount = 0;
    let totalPayment = 0;
    let totalChange = 0;
    
    filteredTransactions.forEach(transaction => {
        const date = new Date(transaction.date);
        const dateStr = date.toLocaleDateString('en-US', { 
            year: 'numeric', 
            month: 'short', 
            day: 'numeric' 
        });
        const timeStr = date.toLocaleTimeString('en-US', { 
            hour: '2-digit', 
            minute: '2-digit' 
        });
        
        const itemsList = transaction.items.map(item => 
            `${item.name} (x${item.quantity})`
        ).join(', ');
        
        const customerName = transaction.customerName || 'N/A';
        const paymentDisplay = transaction.paymentMethod === 'cash' ? `₱${transaction.cash.toFixed(2)}` : 
                              transaction.paymentMethod === 'ecash' ? 'E-Cash' : 'Card';
        const changeDisplay = transaction.paymentMethod === 'cash' ? `₱${transaction.change.toFixed(2)}` : '-';
        
        // Add to totals
        totalAmount += transaction.subtotal;
        totalPayment += transaction.cash;
        totalChange += transaction.change;
        
        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${dateStr}<br><small style="color: #a8a5a1;">${timeStr}</small></td>
            <td>${transaction.user}</td>
            <td>${customerName}</td>
            <td style="max-width: 300px; overflow: hidden; text-overflow: ellipsis;" title="${itemsList}">
                ${itemsList}
            </td>
            <td style="font-weight: bold; color: #dc143c;">₱${transaction.subtotal.toFixed(2)}</td>
            <td>${paymentDisplay}</td>
            <td>${changeDisplay}</td>
        `;
        tbody.appendChild(row);
    });
    
    // Update footer totals
    document.getElementById('footerTotal').textContent = `₱${totalAmount.toFixed(2)}`;
    document.getElementById('footerPayment').textContent = `₱${totalPayment.toFixed(2)}`;
    document.getElementById('footerChange').textContent = `₱${totalChange.toFixed(2)}`;
    tfoot.style.display = 'table-footer-group';
}

function saveReport() {
    const reportType = document.getElementById('reportType').value;
    const startDate = new Date(document.getElementById('startDate').value);
    const endDate = new Date(document.getElementById('endDate').value);
    endDate.setHours(23, 59, 59, 999);
    
    const userFilter = document.getElementById('userFilter').value;
    
    // Filter transactions
    let filteredTransactions = transactions.filter(t => {
        const transDate = new Date(t.date);
        return transDate >= startDate && transDate <= endDate;
    });
    
    if (reportType === 'user' && userFilter !== 'all') {
        filteredTransactions = filteredTransactions.filter(t => t.user === userFilter);
    }
    
    // Apply payment method filter
    if (reportType === 'cash') {
        filteredTransactions = filteredTransactions.filter(t => t.paymentMethod === 'cash');
    } else if (reportType === 'ecash') {
        filteredTransactions = filteredTransactions.filter(t => t.paymentMethod === 'ecash');
    } else if (reportType === 'card') {
        filteredTransactions = filteredTransactions.filter(t => t.paymentMethod === 'card');
    }
    
    if (filteredTransactions.length === 0) {
        showAlert('No transactions to save!', 'Save Error');
        return;
    }
    
    // Calculate totals
    let totalItems = 0;
    let totalSubtotal = 0;
    let totalCash = 0;
    let totalChange = 0;
    
    // Create CSV content with BOM for Excel compatibility
    let csv = '\uFEFF'; // UTF-8 BOM
    csv += 'A&R PHARMAPLUS - SALES REPORT\n';
    csv += `Report Type: ${reportType.toUpperCase()}\n`;
    csv += `Date Range: ${startDate.toLocaleDateString('en-US')} to ${endDate.toLocaleDateString('en-US')}\n`;
    csv += `Generated: ${new Date().toLocaleString('en-US')}\n`;
    csv += '\n';
    csv += 'Date,Time,User,Customer,Payment Method,Items,Total Items,Subtotal,Cash,Change\n';
    
    filteredTransactions.forEach(transaction => {
        const date = new Date(transaction.date);
        const dateStr = date.toLocaleDateString('en-US');
        const timeStr = date.toLocaleTimeString('en-US');
        const itemsList = transaction.items.map(item => 
            `${item.name} (x${item.quantity})`
        ).join('; ');
        const customerName = transaction.customerName || 'N/A';
        const paymentMethodLabel = transaction.paymentMethod === 'cash' ? 'Cash' : 
                                   transaction.paymentMethod === 'ecash' ? 'E-Cash' : 'Card';
        const paymentDisplay = transaction.paymentMethod === 'cash' ? transaction.cash.toFixed(2) : 
                              transaction.paymentMethod === 'ecash' ? 'E-Cash' : 'Card';
        const changeDisplay = transaction.paymentMethod === 'cash' ? transaction.change.toFixed(2) : '0.00';
        
        // Add to totals
        totalItems += transaction.totalItems;
        totalSubtotal += transaction.subtotal;
        totalCash += transaction.cash;
        totalChange += transaction.change;
        
        csv += `"${dateStr}","${timeStr}","${transaction.user}","${customerName}","${paymentMethodLabel}","${itemsList}",${transaction.totalItems},${transaction.subtotal.toFixed(2)},${paymentDisplay},${changeDisplay}\n`;
    });
    
    // Add total row
    csv += '\n';
    csv += `"","","","","TOTAL","",${totalItems},${totalSubtotal.toFixed(2)},${totalCash.toFixed(2)},${totalChange.toFixed(2)}\n`;
    
    // Add summary section
    csv += '\n';
    csv += 'SUMMARY\n';
    csv += `Total Transactions,${filteredTransactions.length}\n`;
    csv += `Total Items Sold,${totalItems}\n`;
    csv += `Total Sales,₱${totalSubtotal.toFixed(2)}\n`;
    csv += `Total Cash Received,₱${totalCash.toFixed(2)}\n`;
    csv += `Total Change Given,₱${totalChange.toFixed(2)}\n`;
    csv += `Average Sale,₱${(totalSubtotal / filteredTransactions.length).toFixed(2)}\n`;
    
    // Create filename with date
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD
    const timeStr = now.toTimeString().split(' ')[0].replace(/:/g, '-'); // HH-MM-SS
    const filename = `AR_PHARMAPLUS_${reportType}_${dateStr}_${timeStr}.csv`;
    
    // Download CSV
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
    
    showAlert(`Report saved successfully!\n\nFilename: ${filename}\n\nThe file has been saved to your Downloads folder.`, 'Report Saved');
}

// Generate Session Report on Logout
function generateSessionReport(user, startTime) {
    const endTime = new Date();
    
    // Filter transactions for this user's session
    const sessionTransactions = transactions.filter(t => {
        const transDate = new Date(t.date);
        return t.user === user.username && transDate >= startTime && transDate <= endTime;
    });
    
    // Only generate report if there are transactions
    if (sessionTransactions.length === 0) {
        console.log('No transactions in this session');
        return;
    }
    
    // Calculate totals
    let totalItems = 0;
    let totalSubtotal = 0;
    let totalCash = 0;
    let totalChange = 0;
    
    // Create CSV content with BOM for Excel compatibility
    let csv = '\uFEFF'; // UTF-8 BOM
    csv += 'A&R PHARMAPLUS - SESSION REPORT\n';
    csv += `User: ${user.username} (${user.role})\n`;
    csv += `Session Start: ${startTime.toLocaleString('en-US')}\n`;
    csv += `Session End: ${endTime.toLocaleString('en-US')}\n`;
    csv += `Duration: ${formatDuration(endTime - startTime)}\n`;
    csv += '\n';
    csv += 'Date,Time,Items,Total Items,Subtotal,Cash,Change\n';
    
    sessionTransactions.forEach(transaction => {
        const date = new Date(transaction.date);
        const dateStr = date.toLocaleDateString('en-US');
        const timeStr = date.toLocaleTimeString('en-US');
        const itemsList = transaction.items.map(item => 
            `${item.name} (x${item.quantity})`
        ).join('; ');
        
        // Add to totals
        totalItems += transaction.totalItems;
        totalSubtotal += transaction.subtotal;
        totalCash += transaction.cash;
        totalChange += transaction.change;
        
        csv += `"${dateStr}","${timeStr}","${itemsList}",${transaction.totalItems},${transaction.subtotal.toFixed(2)},${transaction.cash.toFixed(2)},${transaction.change.toFixed(2)}\n`;
    });
    
    // Add total row
    csv += '\n';
    csv += `"","TOTAL","",${totalItems},${totalSubtotal.toFixed(2)},${totalCash.toFixed(2)},${totalChange.toFixed(2)}\n`;
    
    // Add summary section
    csv += '\n';
    csv += 'SESSION SUMMARY\n';
    csv += `Total Transactions,${sessionTransactions.length}\n`;
    csv += `Total Items Sold,${totalItems}\n`;
    csv += `Total Sales,₱${totalSubtotal.toFixed(2)}\n`;
    csv += `Total Cash Received,₱${totalCash.toFixed(2)}\n`;
    csv += `Total Change Given,₱${totalChange.toFixed(2)}\n`;
    csv += `Average Sale,₱${(totalSubtotal / sessionTransactions.length).toFixed(2)}\n`;
    
    // Create filename with date and time
    const dateStr = startTime.toISOString().split('T')[0]; // YYYY-MM-DD
    const timeStr = startTime.toTimeString().split(' ')[0].replace(/:/g, '-'); // HH-MM-SS
    const filename = `AR_PHARMAPLUS_SESSION_${user.username}_${dateStr}_${timeStr}.csv`;
    
    // Download CSV
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
    
    console.log(`Session report saved: ${filename}`);
}

// Format duration in hours and minutes
function formatDuration(milliseconds) {
    const totalMinutes = Math.floor(milliseconds / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    
    if (hours > 0) {
        return `${hours} hour${hours !== 1 ? 's' : ''} ${minutes} minute${minutes !== 1 ? 's' : ''}`;
    } else {
        return `${minutes} minute${minutes !== 1 ? 's' : ''}`;
    }
}

// ===== MONITORING DASHBOARD =====

// Track active (online) sessions in localStorage
function markUserOnline(username) {
    // Local
    const sessions = JSON.parse(localStorage.getItem('pharmacyActiveSessions') || '{}');
    sessions[username] = { online: true, lastSeen: new Date().toISOString() };
    localStorage.setItem('pharmacyActiveSessions', JSON.stringify(sessions));
    // Supabase
    if (navigator.onLine) sbMarkOnline(username);
}

function markUserOffline(username) {
    // Local
    const sessions = JSON.parse(localStorage.getItem('pharmacyActiveSessions') || '{}');
    if (sessions[username]) {
        sessions[username].online   = false;
        sessions[username].lastSeen = new Date().toISOString();
        localStorage.setItem('pharmacyActiveSessions', JSON.stringify(sessions));
    }
    // Supabase
    if (navigator.onLine) sbMarkOffline(username);
}

async function getActiveSessions() {
    // Try Supabase first if online
    if (navigator.onLine) {
        const sbSessions = await sbGetSessions();
        if (sbSessions && Object.keys(sbSessions).length > 0) return sbSessions;
    }
    // Fallback to localStorage
    const local = JSON.parse(localStorage.getItem('pharmacyActiveSessions') || '{}');
    // Normalize to same shape as Supabase response
    const normalized = {};
    Object.entries(local).forEach(([k, v]) => {
        normalized[k] = { username: k, online: v.online, last_seen: v.lastSeen };
    });
    return normalized;
}

function refreshMonitoring() {
    updateConnUI();
    renderMonitorSummary();
    renderMonitorSessions();
    populateMonitorTxnFilter();
    renderMonitorTransactions();
    renderOfflineQueue();

    const el = document.getElementById('monitorLastSync');
    if (el) {
        const now = new Date();
        el.textContent = 'Last sync: ' + now.toLocaleTimeString('en-US', {
            hour: '2-digit', minute: '2-digit', second: '2-digit'
        });
    }
}

function renderMonitorSummary() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Only cashier transactions count for summary
    const cashierUsers = users.filter(u => u.role === 'cashier').map(u => u.username);
    const todayTxns    = transactions.filter(t => new Date(t.date) >= today && cashierUsers.includes(t.user));
    const todaySales   = todayTxns.reduce((s, t) => s + t.subtotal, 0);
    const todayItems   = todayTxns.reduce((s, t) => s + t.totalItems, 0);
    const pending      = getOfflineQueue().length;

    const s = document.getElementById('monTodaySales');
    const x = document.getElementById('monTodayTxn');
    const i = document.getElementById('monTodayItems');
    const p = document.getElementById('monPending');

    if (s) s.textContent = '₱' + todaySales.toFixed(2);
    if (x) x.textContent = todayTxns.length;
    if (i) i.textContent = todayItems;
    if (p) {
        p.textContent  = pending;
        p.style.color  = pending > 0 ? '#ff9800' : '#0a7c5c';
    }
}

function renderMonitorSessions() {
    const tbody = document.getElementById('monitorSessionsBody');
    if (!tbody) return;
    tbody.innerHTML = '';

    // === CASHIERS ONLY — admin/superadmin excluded ===
    const cashiers = users.filter(u => u.role === 'cashier');

    if (cashiers.length === 0) {
        tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:20px;color:#7a7773;">No cashier accounts found.</td></tr>';
        return;
    }

    const today    = new Date(); today.setHours(0,0,0,0);
    const sessions = getActiveSessions();

    // Build stats per cashier from ALL transactions (not just today for session info)
    cashiers.forEach(u => {
        const todayTxns = transactions.filter(t =>
            t.user === u.username && new Date(t.date) >= today
        );
        const allTxns = transactions.filter(t => t.user === u.username);

        const todaySales  = todayTxns.reduce((s, t) => s + t.subtotal, 0);
        const todayItems  = todayTxns.reduce((s, t) => s + t.totalItems, 0);
        const cashSales   = todayTxns.filter(t => t.paymentMethod === 'cash').reduce((s,t) => s + t.subtotal, 0);
        const ecashSales  = todayTxns.filter(t => t.paymentMethod === 'ecash').reduce((s,t) => s + t.subtotal, 0);
        const cardSales   = todayTxns.filter(t => t.paymentMethod === 'card').reduce((s,t) => s + t.subtotal, 0);

        // Online/offline from active sessions
        const sess     = sessions[u.username];
        const isOnline = sess && sess.online === true;
        const lastSeen = sess && sess.lastSeen
            ? new Date(sess.lastSeen).toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit' })
            : '—';

        const statusDot   = isOnline
            ? '<span style="display:inline-flex;align-items:center;gap:5px;"><span class="conn-dot" style="width:10px;height:10px;"></span><span class="status-online">ONLINE</span></span>'
            : '<span style="display:inline-flex;align-items:center;gap:5px;"><span class="conn-dot offline" style="width:10px;height:10px;animation:pulse-red 1.5s infinite;"></span><span class="status-offline">OFFLINE</span></span>';

        const hasDetail = allTxns.length > 0;
        const detailBtn = hasDetail
            ? `<button onclick="showCashierDetail('${u.username}')" class="btn-view-detail">View Transactions</button>`
            : '<span style="color:#a8a5a1;font-size:11px;">No transactions</span>';

        const row = document.createElement('tr');
        row.innerHTML = `
            <td>
                <strong>${u.username}</strong><br>
                <small style="color:#a8a5a1;">${detailBtn}</small>
            </td>
            <td>${statusDot}</td>
            <td style="font-size:12px;color:#7a7773;">${isOnline ? '🟢 Now' : lastSeen}</td>
            <td style="text-align:center;font-weight:bold;">${todayTxns.length}</td>
            <td style="font-weight:bold;color:#0a7c5c;">₱${todaySales.toFixed(2)}</td>
            <td style="text-align:center;">${todayItems}</td>
            <td style="color:#1565c0;">₱${cashSales.toFixed(2)}</td>
            <td style="color:#0288d1;">₱${ecashSales.toFixed(2)}</td>
            <td style="color:#6a1b9a;">₱${cardSales.toFixed(2)}</td>
        `;
        tbody.appendChild(row);
    });
}

function showCashierDetail(username) {
    const section = document.getElementById('cashierDetailSection');
    const title   = document.getElementById('cashierDetailTitle');
    const tbody   = document.getElementById('cashierDetailBody');
    const summary = document.getElementById('cashierDetailSummary');
    if (!section || !tbody) return;

    const userTxns = [...transactions]
        .filter(t => t.user === username)
        .sort((a, b) => new Date(b.date) - new Date(a.date));

    title.textContent = '🧾 Transactions — ' + username;
    tbody.innerHTML   = '';

    if (userTxns.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:20px;color:#7a7773;">No transactions found for this cashier.</td></tr>';
    } else {
        userTxns.forEach(t => {
            const d     = new Date(t.date);
            const dStr  = d.toLocaleDateString('en-US', { year:'numeric', month:'short', day:'numeric' });
            const tStr  = d.toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit' });
            const items = t.items.map(i => `${i.name} ×${i.quantity} @ ₱${i.price.toFixed(2)}`).join('<br>');
            const pm    = t.paymentMethod === 'cash'  ? '💵 Cash'
                        : t.paymentMethod === 'ecash' ? '📱 E-Cash' : '💳 Card';
            const change = t.paymentMethod === 'cash' ? '₱' + t.change.toFixed(2) : '—';
            const queue  = getOfflineQueue();
            const isPending = queue.some(q => q.id === t.id);
            const statusCell = isPending
                ? '<span class="status-pending">⏳ Pending</span>'
                : '<span class="status-synced">✅ Synced</span>';

            const row = document.createElement('tr');
            row.innerHTML = `
                <td>${dStr}<br><small style="color:#a8a5a1;">${tStr}</small></td>
                <td style="font-size:12px;line-height:1.6;">${items}</td>
                <td style="font-weight:bold;color:#0a7c5c;">₱${t.subtotal.toFixed(2)}</td>
                <td>${pm}</td>
                <td>${change}</td>
                <td>${statusCell}</td>
            `;
            tbody.appendChild(row);
        });

        // Summary footer
        const total    = userTxns.reduce((s, t) => s + t.subtotal, 0);
        const totalQty = userTxns.reduce((s, t) => s + t.totalItems, 0);
        summary.innerHTML = `
            <strong>Total Transactions:</strong> ${userTxns.length} &nbsp;|&nbsp;
            <strong>Total Items Sold:</strong> ${totalQty} &nbsp;|&nbsp;
            <strong>Grand Total Sales:</strong> <span style="color:#0a7c5c;font-weight:bold;">₱${total.toFixed(2)}</span>
        `;
    }

    section.style.display = 'block';
    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closeCashierDetail() {
    const section = document.getElementById('cashierDetailSection');
    if (section) section.style.display = 'none';
}

function populateMonitorTxnFilter() {
    const sel = document.getElementById('monTxnFilter');
    if (!sel) return;
    const current = sel.value;
    sel.innerHTML = '<option value="all">All Cashiers</option>';

    // Only cashier roles
    users.filter(u => u.role === 'cashier').forEach(u => {
        const opt = document.createElement('option');
        opt.value       = u.username;
        opt.textContent = u.username;
        if (u.username === current) opt.selected = true;
        sel.appendChild(opt);
    });
}

function renderMonitorTransactions() {
    const tbody      = document.getElementById('monitorTxnBody');
    const totalsEl   = document.getElementById('monitorTxnTotals');
    if (!tbody) return;
    tbody.innerHTML  = '';

    const userFilter = document.getElementById('monTxnFilter')?.value || 'all';
    const dateFilter = document.getElementById('monTxnDateFilter')?.value || 'today';

    const now   = new Date();
    const today = new Date(now); today.setHours(0,0,0,0);
    const weekAgo = new Date(now); weekAgo.setDate(now.getDate() - 7); weekAgo.setHours(0,0,0,0);

    // Only cashier transactions
    const cashierNames = users.filter(u => u.role === 'cashier').map(u => u.username);

    let filtered = transactions.filter(t => cashierNames.includes(t.user));

    // Date filter
    if (dateFilter === 'today') {
        filtered = filtered.filter(t => new Date(t.date) >= today);
    } else if (dateFilter === 'week') {
        filtered = filtered.filter(t => new Date(t.date) >= weekAgo);
    }

    // User filter
    if (userFilter !== 'all') {
        filtered = filtered.filter(t => t.user === userFilter);
    }

    filtered.sort((a, b) => new Date(b.date) - new Date(a.date));

    if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:30px;color:#7a7773;">No transactions found.</td></tr>';
        if (totalsEl) totalsEl.innerHTML = '';
        return;
    }

    const queue = getOfflineQueue();
    let grandTotal = 0;

    filtered.forEach(t => {
        const d      = new Date(t.date);
        const dStr   = d.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
        const tStr   = d.toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit' });
        const items  = t.items.map(i => `${i.name} ×${i.quantity}`).join(', ');
        const pm     = t.paymentMethod === 'cash'  ? '💵 Cash'
                     : t.paymentMethod === 'ecash' ? '📱 E-Cash' : '💳 Card';
        const change = t.paymentMethod === 'cash' ? '₱' + t.change.toFixed(2) : '—';
        const pending = queue.some(q => q.id === t.id);
        const statusCell = pending
            ? '<span class="status-pending">⏳ Pending</span>'
            : '<span class="status-synced">✅ Synced</span>';

        grandTotal += t.subtotal;

        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${dStr}<br><small style="color:#a8a5a1;">${tStr}</small></td>
            <td><strong>${t.user}</strong></td>
            <td style="max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${items}">${items}</td>
            <td style="font-weight:bold;color:#0a7c5c;">₱${t.subtotal.toFixed(2)}</td>
            <td>${pm}</td>
            <td>${change}</td>
            <td>${statusCell}</td>
        `;
        tbody.appendChild(row);
    });

    if (totalsEl) {
        totalsEl.innerHTML = `
            <span><strong>Showing:</strong> ${filtered.length} transaction${filtered.length !== 1 ? 's' : ''}</span>
            <span><strong>Grand Total:</strong> <span style="color:#0a7c5c;font-weight:bold;">₱${grandTotal.toFixed(2)}</span></span>
        `;
    }
}

function renderOfflineQueue() {
    const queue  = getOfflineQueue();
    const tbody  = document.getElementById('offlineQueueBody');
    const count  = document.getElementById('offlineQueueCount');
    const syncEl = document.getElementById('offlineSyncCount');

    if (count) count.textContent = queue.length;
    if (syncEl) syncEl.textContent = queue.length + ' pending';

    if (!tbody) return;
    tbody.innerHTML = '';

    if (queue.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:20px;color:#0a7c5c;font-weight:bold;">✅ No pending transactions — all synced.</td></tr>';
        return;
    }

    queue.forEach(t => {
        const d    = new Date(t._queued || t.date);
        const dStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        const tStr = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        const items = t.items.map(i => i.name + ' x' + i.quantity).join(', ');
        const pm   = t.paymentMethod === 'cash' ? '💵 Cash'
                   : t.paymentMethod === 'ecash' ? '📱 E-Cash' : '💳 Card';

        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${dStr}<br><small style="color:#a8a5a1">${tStr}</small></td>
            <td>${t.user}</td>
            <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${items}">${items}</td>
            <td style="font-weight:bold;color:#ff9800;">₱${t.subtotal.toFixed(2)}</td>
            <td>${pm}</td>
        `;
        tbody.appendChild(row);
    });
}

// Auto-refresh monitoring dashboard every 30s when logged in as monitor
setInterval(() => {
    if (currentUser && currentUser.role === 'monitor') {
        refreshMonitoring();
    }
    updateConnUI();
}, 30000);

// Initial connection UI update (runs after loadData)
setTimeout(updateConnUI, 200);
