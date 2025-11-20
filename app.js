// State management
let currentUser = null;
let currentRoom = 'general';
let selectedDM = null;
let showModPanel = false;
let unsubscribeMessages = null;
let unsubscribeDMs = null;
let cachedUsers = {};
let cachedRooms = {};

// Initialize
document.addEventListener('DOMContentLoaded', function() {
    checkLogin();
    // Run cleanup on startup (for moderators)
    setTimeout(function() {
        if (currentUser && currentUser.isModerator) {
            autoDeleteOldMessages();
        }
    }, 5000);
});

// Auto-delete messages older than 24 hours (runs once per day)
async function autoDeleteOldMessages() {
    if (!currentUser || !currentUser.isModerator) return;
    
    const lastCleanup = localStorage.getItem('lastMessageCleanup');
    const now = new Date().getTime();
    
    // Only run once per day
    if (lastCleanup && (now - parseInt(lastCleanup)) < 24 * 60 * 60 * 1000) {
        console.log('Cleanup already ran today');
        return;
    }
    
    console.log('Running automatic message cleanup...');
    
    try {
        const oneDayAgo = new Date();
        oneDayAgo.setDate(oneDayAgo.getDate() - 1);
        
        // Delete old room messages
        const messagesSnapshot = await db.collection('messages')
            .where('timestamp', '<', oneDayAgo)
            .get();
        
        // Delete old DM messages
        const dmSnapshot = await db.collection('directMessages')
            .where('timestamp', '<', oneDayAgo)
            .get();
        
        const batch = db.batch();
        let deleteCount = 0;
        
        messagesSnapshot.docs.forEach(function(doc) {
            batch.delete(doc.ref);
            deleteCount++;
        });
        
        dmSnapshot.docs.forEach(function(doc) {
            batch.delete(doc.ref);
            deleteCount++;
        });
        
        if (deleteCount > 0) {
            await batch.commit();
            console.log('Deleted ' + deleteCount + ' old messages (older than 24 hours)');
        } else {
            console.log('No old messages to delete');
        }
        
        // Save last cleanup time
        localStorage.setItem('lastMessageCleanup', now.toString());
        
    } catch (error) {
        console.error('Error during auto-cleanup:', error);
    }
}

// Check if user is logged in
function checkLogin() {
    const savedUser = localStorage.getItem('chatUser');
    if (savedUser) {
        const userData = JSON.parse(savedUser);
        // Verify user still exists in database
        db.collection('accounts').doc(userData.username).get().then(function(doc) {
            if (doc.exists) {
                currentUser = {
                    username: userData.username,
                    isModerator: doc.data().isModerator || false
                };
                updateUserOnlineStatus(true);
                setupRoomsListener();
                setupUsersListener();
                setupModerationListener();
                renderApp();
                switchRoom('general');
            } else {
                // Account deleted, log out
                localStorage.removeItem('chatUser');
                renderAuthScreen();
            }
        });
    } else {
        renderAuthScreen();
    }
}

// Signup handler
async function handleSignup(username, password) {
    if (!username.trim() || !password.trim()) {
        alert('Username and password are required');
        return;
    }
    
    if (username.length < 3) {
        alert('Username must be at least 3 characters');
        return;
    }
    
    if (password.length < 4) {
        alert('Password must be at least 4 characters');
        return;
    }
    
    try {
        // Check if username already exists
        const userDoc = await db.collection('accounts').doc(username.trim()).get();
        
        if (userDoc.exists) {
            alert('Username already taken. Please choose another one.');
            return;
        }
        
        // Create new account
        await db.collection('accounts').doc(username.trim()).set({
            username: username.trim(),
            password: password,
            isModerator: false,
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            online: false
        });
        
        alert('Account created successfully! You can now log in.');
        showLoginScreen();
        
    } catch (error) {
        console.error('Signup error:', error);
        alert('Failed to create account. Please try again.');
    }
}

// Login handler
async function handleLogin(username, password) {
    if (!username.trim() || !password.trim()) {
        alert('Username and password are required');
        return;
    }
    
    try {
        const userDoc = await db.collection('accounts').doc(username.trim()).get();
        
        if (!userDoc.exists) {
            alert('Account not found. Please sign up first.');
            return;
        }
        
        const userData = userDoc.data();
        
        if (userData.password !== password) {
            alert('Incorrect password. Please try again.');
            return;
        }
        
        // Login successful
        currentUser = {
            username: userData.username,
            isModerator: userData.isModerator || false
        };
        
        localStorage.setItem('chatUser', JSON.stringify(currentUser));
        updateUserOnlineStatus(true);
        
        setupRoomsListener();
        setupUsersListener();
        setupModerationListener();
        renderApp();
        switchRoom('general');
        
    } catch (error) {
        console.error('Login error:', error);
        alert('Failed to login. Please try again.');
    }
}

// Update user online status
function updateUserOnlineStatus(online) {
    if (!currentUser) return;
    
    db.collection('accounts').doc(currentUser.username).update({ 
        online: online,
        lastSeen: firebase.firestore.FieldValue.serverTimestamp()
    }).catch(function(err) {
        console.log('Update online status error:', err);
    });
}

// Logout
function logout() {
    if (currentUser) {
        updateUserOnlineStatus(false);
    }
    localStorage.removeItem('chatUser');
    location.reload();
}

// Setup listeners
function setupRoomsListener() {
    // Ensure general room exists
    db.collection('rooms').doc('general').set({
        name: 'General',
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        type: 'public'
    }, { merge: true });
    
    db.collection('rooms').onSnapshot(function(snapshot) {
        const rooms = snapshot.docs.map(function(doc) {
            return { id: doc.id, ...doc.data() };
        });
        rooms.forEach(function(room) {
            cachedRooms[room.id] = room;
        });
        renderRoomsList(rooms);
    });
}

function setupUsersListener() {
    db.collection('accounts').where('online', '==', true).onSnapshot(function(snapshot) {
        const users = snapshot.docs.map(function(doc) {
            return { username: doc.id, ...doc.data() };
        });
        
        // Cache all users for lookup
        users.forEach(function(user) {
            cachedUsers[user.username] = user;
        });
        
        renderUsersList(users.filter(function(u) {
            return u.username !== currentUser.username;
        }));
    });
}

function setupModerationListener() {
    db.collection('moderation').doc('config').onSnapshot(function(doc) {
        if (doc.exists) {
            const config = doc.data();
            updateModerationUI(config);
        }
    });
}

// Switch room
function switchRoom(roomId) {
    currentRoom = roomId;
    selectedDM = null;
    showModPanel = false;
    
    // Unsubscribe from previous listener
    if (unsubscribeMessages) unsubscribeMessages();
    if (unsubscribeDMs) unsubscribeDMs();
    
    // Subscribe to room messages - limit to last 50 to save bandwidth
    unsubscribeMessages = db.collection('messages')
        .where('roomId', '==', roomId)
        .orderBy('timestamp', 'desc')
        .limit(50)
        .onSnapshot(function(snapshot) {
            const messages = snapshot.docs.map(function(doc) {
                const data = doc.data();
                return { 
                    id: doc.id, 
                    ...data,
                    timestamp: data.timestamp || new Date()
                };
            });
            
            // Sort messages client-side (reverse because we got desc order)
            messages.sort(function(a, b) {
                const timeA = a.timestamp.toDate ? a.timestamp.toDate() : new Date(a.timestamp);
                const timeB = b.timestamp.toDate ? b.timestamp.toDate() : new Date(b.timestamp);
                return timeA - timeB;
            });
            
            console.log('Messages for room ' + roomId + ':', messages.length);
            renderMessages(messages);
        }, function(error) {
            console.error('Error fetching messages:', error);
        });
    
    renderApp();
}

// Switch to DM
function switchToDM(username) {
    selectedDM = username;
    currentRoom = null;
    showModPanel = false;
    
    if (unsubscribeMessages) unsubscribeMessages();
    if (unsubscribeDMs) unsubscribeDMs();
    
    // Create DM room ID (sorted to ensure consistency)
    const dmRoomId = [currentUser.username, username].sort().join('_');
    
    // Limit DMs to last 50 messages to save bandwidth
    unsubscribeDMs = db.collection('directMessages')
        .where('roomId', '==', dmRoomId)
        .orderBy('timestamp', 'desc')
        .limit(50)
        .onSnapshot(function(snapshot) {
            const messages = snapshot.docs.map(function(doc) {
                const data = doc.data();
                return { 
                    id: doc.id, 
                    ...data,
                    timestamp: data.timestamp || new Date()
                };
            });
            
            // Sort messages client-side (reverse because we got desc order)
            messages.sort(function(a, b) {
                const timeA = a.timestamp.toDate ? a.timestamp.toDate() : new Date(a.timestamp);
                const timeB = b.timestamp.toDate ? b.timestamp.toDate() : new Date(b.timestamp);
                return timeA - timeB;
            });
            
            renderMessages(messages);
        });
    
    renderApp();
}

// Send message
async function sendMessage(text, imageUrl) {
    if (!imageUrl) imageUrl = null;
    if ((!text.trim() && !imageUrl) || !currentUser) return;
    
    // Check if user is banned
    const modConfig = await db.collection('moderation').doc('config').get();
    const bannedUsers = modConfig.exists ? (modConfig.data().bannedUsers || []) : [];
    const filteredWords = modConfig.exists ? (modConfig.data().filteredWords || []) : [];
    
    if (bannedUsers.includes(currentUser.username)) {
        alert('You are banned from chatting');
        return;
    }
    
    // Filter message
    let filteredText = text;
    filteredWords.forEach(function(word) {
        const regex = new RegExp(word, 'gi');
        filteredText = filteredText.replace(regex, '*'.repeat(word.length));
    });
    
    const message = {
        username: currentUser.username,
        text: filteredText,
        imageUrl: imageUrl,
        timestamp: firebase.firestore.FieldValue.serverTimestamp(),
        type: imageUrl ? 'image' : 'text'
    };
    
    try {
        if (selectedDM) {
            const dmRoomId = [currentUser.username, selectedDM].sort().join('_');
            message.roomId = dmRoomId;
            
            // Check message count before sending
            const dmCount = await db.collection('directMessages').where('roomId', '==', dmRoomId).get();
            
            // If 50 or more messages, clear all
            if (dmCount.size >= 50) {
                console.log('DM has 50 messages, clearing all...');
                const batch = db.batch();
                dmCount.docs.forEach(function(doc) {
                    batch.delete(doc.ref);
                });
                await batch.commit();
                console.log('Cleared ' + dmCount.size + ' messages from DM');
            }
            
            await db.collection('directMessages').add(message);
        } else {
            message.roomId = currentRoom;
            
            // Check message count before sending
            const roomCount = await db.collection('messages').where('roomId', '==', currentRoom).get();
            
            // If 50 or more messages, clear all
            if (roomCount.size >= 50) {
                console.log('Room has 50 messages, clearing all...');
                const batch = db.batch();
                roomCount.docs.forEach(function(doc) {
                    batch.delete(doc.ref);
                });
                await batch.commit();
                console.log('Cleared ' + roomCount.size + ' messages from room: ' + getRoomName(currentRoom));
            }
            
            await db.collection('messages').add(message);
        }
        console.log('Message sent successfully');
    } catch (error) {
        console.error('Error sending message:', error);
        alert('Failed to send message. Check console for details.');
    }
}

// Upload image
async function uploadImage(file) {
    if (!file) return null;
    
    const storageRef = storage.ref();
    const imageRef = storageRef.child('images/' + Date.now() + '_' + file.name);
    
    try {
        await imageRef.put(file);
        const url = await imageRef.getDownloadURL();
        return url;
    } catch (error) {
        console.error('Error uploading image:', error);
        return null;
    }
}

// Create room
async function createRoom(roomName) {
    if (!roomName.trim()) return;
    
    await db.collection('rooms').add({
        name: roomName.trim(),
        createdBy: currentUser.username,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        type: 'public'
    });
}

// Moderation functions
async function toggleBanUser(username) {
    if (!currentUser.isModerator) return;
    
    const modRef = db.collection('moderation').doc('config');
    const doc = await modRef.get();
    
    let bannedUsers = doc.exists ? (doc.data().bannedUsers || []) : [];
    
    if (bannedUsers.includes(username)) {
        bannedUsers = bannedUsers.filter(function(u) { return u !== username; });
    } else {
        bannedUsers.push(username);
    }
    
    await modRef.set({ bannedUsers: bannedUsers }, { merge: true });
}

async function clearAllMessages() {
    if (!currentUser.isModerator) {
        alert('Only moderators can clear messages');
        return;
    }
    
    const confirmClear = confirm('⚠️ Are you sure you want to clear ALL messages in this room? This cannot be undone!');
    if (!confirmClear) return;
    
    try {
        if (selectedDM) {
            // Clear DM messages
            const dmRoomId = [currentUser.username, selectedDM].sort().join('_');
            const snapshot = await db.collection('directMessages').where('roomId', '==', dmRoomId).get();
            
            const batch = db.batch();
            snapshot.docs.forEach(function(doc) {
                batch.delete(doc.ref);
            });
            await batch.commit();
            
            alert('Cleared ' + snapshot.size + ' messages from this DM');
        } else {
            // Clear room messages
            const snapshot = await db.collection('messages').where('roomId', '==', currentRoom).get();
            
            const batch = db.batch();
            snapshot.docs.forEach(function(doc) {
                batch.delete(doc.ref);
            });
            await batch.commit();
            
            alert('Cleared ' + snapshot.size + ' messages from # ' + getRoomName(currentRoom));
        }
    } catch (error) {
        console.error('Error clearing messages:', error);
        alert('Failed to clear messages. Check console for details.');
    }
}

async function clearAllChats() {
    if (!currentUser.isModerator) {
        alert('Only moderators can clear all chats');
        return;
    }
    
    const confirmClear = confirm('⚠️ WARNING: This will delete ALL messages from ALL rooms and DMs for EVERYONE. Are you absolutely sure?');
    if (!confirmClear) return;
    
    const doubleConfirm = confirm('This action cannot be undone. Type YES in the next prompt to confirm.');
    if (!doubleConfirm) return;
    
    const finalConfirm = prompt('Type YES in all caps to confirm deletion of all messages:');
    if (finalConfirm !== 'YES') {
        alert('Cancelled');
        return;
    }
    
    try {
        // Clear all room messages
        const messagesSnapshot = await db.collection('messages').get();
        const dmSnapshot = await db.collection('directMessages').get();
        
        const batch = db.batch();
        
        messagesSnapshot.docs.forEach(function(doc) {
            batch.delete(doc.ref);
        });
        
        dmSnapshot.docs.forEach(function(doc) {
            batch.delete(doc.ref);
        });
        
        await batch.commit();
        
        alert('Successfully cleared ' + (messagesSnapshot.size + dmSnapshot.size) + ' total messages from all chats!');
    } catch (error) {
        console.error('Error clearing all chats:', error);
        alert('Failed to clear all chats. Check console for details.');
    }
}

async function deleteRoom(roomId) {
    if (!currentUser.isModerator) {
        alert('Only moderators can delete rooms');
        return;
    }
    
    if (roomId === 'general') {
        alert('Cannot delete the General room');
        return;
    }
    
    const confirmDelete = confirm('Delete room "' + getRoomName(roomId) + '" and all its messages?');
    if (!confirmDelete) return;
    
    try {
        // Delete room
        await db.collection('rooms').doc(roomId).delete();
        
        // Delete all messages in the room
        const snapshot = await db.collection('messages').where('roomId', '==', roomId).get();
        const batch = db.batch();
        snapshot.docs.forEach(function(doc) {
            batch.delete(doc.ref);
        });
        await batch.commit();
        
        // Switch back to general
        switchRoom('general');
        
        alert('Room deleted successfully');
    } catch (error) {
        console.error('Error deleting room:', error);
        alert('Failed to delete room. Check console for details.');
    }
}

async function toggleModStatus(username) {
    if (!currentUser.isModerator) {
        alert('Only moderators can change mod status');
        return;
    }
    
    if (username === currentUser.username) {
        alert('You cannot change your own moderator status');
        return;
    }
    
    try {
        const userDoc = await db.collection('accounts').doc(username).get();
        if (!userDoc.exists) {
            alert('User not found');
            return;
        }
        
        const isMod = userDoc.data().isModerator || false;
        await db.collection('accounts').doc(username).update({
            isModerator: !isMod
        });
        
        alert(username + ' is now ' + (!isMod ? 'a moderator' : 'no longer a moderator'));
    } catch (error) {
        console.error('Error toggling mod status:', error);
        alert('Failed to change mod status');
    }
}

async function deleteAccount(username) {
    if (!currentUser.isModerator) {
        alert('Only moderators can delete accounts');
        return;
    }
    
    if (username === currentUser.username) {
        alert('You cannot delete your own account');
        return;
    }
    
    const confirmDelete = confirm('Delete account "' + username + '"? This will remove their account and all their messages.');
    if (!confirmDelete) return;
    
    try {
        // Delete account
        await db.collection('accounts').doc(username).delete();
        
        // Delete all messages by this user
        const messagesSnapshot = await db.collection('messages').where('username', '==', username).get();
        const dmSnapshot = await db.collection('directMessages').where('username', '==', username).get();
        
        const batch = db.batch();
        messagesSnapshot.docs.forEach(function(doc) { batch.delete(doc.ref); });
        dmSnapshot.docs.forEach(function(doc) { batch.delete(doc.ref); });
        await batch.commit();
        
        alert('Account "' + username + '" deleted successfully');
    } catch (error) {
        console.error('Error deleting account:', error);
        alert('Failed to delete account');
    }
}

async function addFilterWord(word) {
    if (!currentUser.isModerator || !word.trim()) return;
    
    const modRef = db.collection('moderation').doc('config');
    const doc = await modRef.get();
    
    let filteredWords = doc.exists ? (doc.data().filteredWords || []) : [];
    
    if (!filteredWords.includes(word.toLowerCase())) {
        filteredWords.push(word.toLowerCase());
        await modRef.set({ filteredWords: filteredWords }, { merge: true });
    }
}

async function removeFilterWord(word) {
    if (!currentUser.isModerator) return;
    
    const modRef = db.collection('moderation').doc('config');
    const doc = await modRef.get();
    
    if (doc.exists) {
        let filteredWords = doc.data().filteredWords || [];
        filteredWords = filteredWords.filter(function(w) { return w !== word; });
        await modRef.set({ filteredWords: filteredWords }, { merge: true });
    }
}

// View user password (moderator only)
async function viewUserPassword(username) {
    if (!currentUser.isModerator) {
        alert('Only moderators can view passwords');
        return;
    }
    
    try {
        const userDoc = await db.collection('accounts').doc(username).get();
        if (!userDoc.exists) {
            alert('User not found');
            return;
        }
        
        const password = userDoc.data().password;
        alert('Password for "' + username + '": ' + password);
    } catch (error) {
        console.error('Error retrieving password:', error);
        alert('Failed to retrieve password');
    }
}

// UI Rendering functions
function renderAuthScreen() {
    document.getElementById('app').innerHTML = `
        <div class="login-screen">
            <div class="login-box">
                <h1>💬 ChatApp</h1>
                <p>Welcome! Please login or create an account</p>
                
                <div class="auth-tabs">
                    <button id="loginTab" class="auth-tab active" onclick="showLoginScreen()">Login</button>
                    <button id="signupTab" class="auth-tab" onclick="showSignupScreen()">Sign Up</button>
                </div>
                
                <div id="authFormContainer"></div>
            </div>
        </div>
    `;
    
    showLoginScreen();
}

function showLoginScreen() {
    document.getElementById('loginTab').classList.add('active');
    document.getElementById('signupTab').classList.remove('active');
    
    document.getElementById('authFormContainer').innerHTML = `
        <div class="auth-form">
            <input type="text" id="loginUsername" placeholder="Username" />
            <input type="password" id="loginPassword" placeholder="Password" />
            <button onclick="handleLogin(document.getElementById('loginUsername').value, document.getElementById('loginPassword').value)">
                Login
            </button>
        </div>
    `;
    
    // Add enter key support
    setTimeout(function() {
        const usernameInput = document.getElementById('loginUsername');
        const passwordInput = document.getElementById('loginPassword');
        if (usernameInput) usernameInput.focus();
        
        [usernameInput, passwordInput].forEach(function(input) {
            if (input) {
                input.addEventListener('keypress', function(e) {
                    if (e.key === 'Enter') {
                        handleLogin(
                            document.getElementById('loginUsername').value,
                            document.getElementById('loginPassword').value
                        );
                    }
                });
            }
        });
    }, 100);
}

function showSignupScreen() {
    document.getElementById('loginTab').classList.remove('active');
    document.getElementById('signupTab').classList.add('active');
    
    document.getElementById('authFormContainer').innerHTML = `
        <div class="auth-form">
            <input type="text" id="signupUsername" placeholder="Choose a username (min 3 characters)" />
            <input type="password" id="signupPassword" placeholder="Choose a password (min 4 characters)" />
            <input type="password" id="signupPasswordConfirm" placeholder="Confirm password" />
            <button onclick="handleSignupClick()">
                Create Account
            </button>
        </div>
    `;
    
    // Add enter key support
    setTimeout(function() {
        const usernameInput = document.getElementById('signupUsername');
        if (usernameInput) usernameInput.focus();
        
        ['signupUsername', 'signupPassword', 'signupPasswordConfirm'].forEach(function(id) {
            const input = document.getElementById(id);
            if (input) {
                input.addEventListener('keypress', function(e) {
                    if (e.key === 'Enter') {
                        handleSignupClick();
                    }
                });
            }
        });
    }, 100);
}

function handleSignupClick() {
    const username = document.getElementById('signupUsername').value;
    const password = document.getElementById('signupPassword').value;
    const confirmPassword = document.getElementById('signupPasswordConfirm').value;
    
    if (password !== confirmPassword) {
        alert('Passwords do not match');
        return;
    }
    
    handleSignup(username, password);
}

function renderApp() {
    const app = document.getElementById('app');
    app.innerHTML = `
        <div class="chat-container">
            <div class="sidebar">
                <div class="sidebar-header">
                    <h2>💬 ChatApp</h2>
                    <p>${currentUser.username} ${currentUser.isModerator ? '👑' : ''}</p>
                </div>
                <div class="sidebar-content">
                    <div class="rooms-section">
                        <div class="section-header">
                            <h3>ROOMS</h3>
                            <button onclick="createRoomPrompt()">+</button>
                        </div>
                        <div id="roomsList"></div>
                    </div>
                    <div class="users-section">
                        <h3>DIRECT MESSAGES</h3>
                        <div id="usersList"></div>
                    </div>
                </div>
                <div class="sidebar-footer">
                    ${currentUser.isModerator ? 
                        '<button onclick="toggleModPanel()" class="mod-btn">🛡️ Mod Panel</button>' : ''
                    }
                    <button onclick="logout()" class="logout-btn">Logout</button>
                </div>
            </div>
            <div class="main-content">
                ${showModPanel ? renderModPanel() : renderChat()}
            </div>
        </div>
    `;
    
    // Re-render rooms and users lists to maintain visibility
    if (cachedRooms && Object.keys(cachedRooms).length > 0) {
        const rooms = Object.values(cachedRooms);
        renderRoomsList(rooms);
    }
    
    // Trigger users list update
    setupUsersListener();
}

function renderChat() {
    const header = selectedDM ? 'DM: ' + selectedDM : '# ' + getRoomName(currentRoom);
    const adminControls = currentUser.isModerator ? `
        <div class="admin-controls">
            <button onclick="clearAllMessages()" class="admin-btn" title="Clear messages in this room/DM">🗑️ Clear Chat</button>
            ${!selectedDM && currentRoom !== 'general' ? 
                '<button onclick="deleteRoom(\'' + currentRoom + '\')" class="admin-btn danger" title="Delete this room">❌ Delete Room</button>' : ''
            }
        </div>
    ` : '';
    
    const emojis = ['😀', '😂', '😍', '🤔', '👍', '❤️', '🎉', '🔥', '✨', '💯'];
    const emojiButtons = emojis.map(function(e) {
        return '<button onclick="addEmoji(\'' + e + '\')">' + e + '</button>';
    }).join('');
    
    return `
        <div class="chat-header">
            <h2>${header}</h2>
            ${adminControls}
        </div>
        <div class="messages-container" id="messagesContainer"></div>
        <div class="input-area">
            <div id="emojiPicker" class="emoji-picker" style="display: none;">
                ${emojiButtons}
            </div>
            <button onclick="document.getElementById('imageInput').click()">🖼️</button>
            <input type="file" id="imageInput" accept="image/*" style="display:none" onchange="handleImageUpload(event)" />
            <button onclick="toggleEmojiPicker()">😊</button>
            <input type="text" id="messageInput" placeholder="Type a message..." onkeypress="handleKeyPress(event)" />
            <button onclick="sendMessageFromInput()">Send</button>
        </div>
    `;
}

function renderModPanel() {
    return `
        <div class="mod-panel">
            <h2>🛡️ Moderation Panel</h2>
            
            <div class="mod-section">
                <h3>⚠️ Danger Zone</h3>
                <button onclick="clearAllChats()" class="danger-btn">🗑️ Clear ALL Messages (All Rooms & DMs)</button>
                <p style="color: #94a3b8; font-size: 0.9rem; margin-top: 0.5rem;">
                    This will permanently delete every message from every room and DM for all users.
                </p>
                
                <button onclick="manualCleanupOldMessages()" class="danger-btn" style="margin-top: 1rem; background: #f59e0b;">
                    🕒 Delete Messages Older Than 24 Hours
                </button>
                <p style="color: #94a3b8; font-size: 0.9rem; margin-top: 0.5rem;">
                    Automatically runs daily. Click to run manually. Helps save Firebase data limits.
                </p>
            </div>
            
            <div class="mod-section">
                <h3>👥 User Management</h3>
                <div id="userManagementList"></div>
            </div>
            
            <div class="mod-section">
                <h3>🚫 Banned Users</h3>
                <div id="bannedUsersList"></div>
            </div>
            
            <div class="mod-section">
                <h3>🔒 Word Filter</h3>
                <div class="filter-input">
                    <input type="text" id="filterWordInput" placeholder="Add word to filter..." />
                    <button onclick="addFilterWordFromInput()">Add</button>
                </div>
                <div id="filteredWordsList"></div>
            </div>
        </div>
    `;
}

function renderMessages(messages) {
    const container = document.getElementById('messagesContainer');
    if (!container) return;
    
    if (messages.length === 0) {
        container.innerHTML = '<div style="text-align: center; color: #94a3b8; padding: 2rem;">No messages yet. Start the conversation!</div>';
        return;
    }
    
    container.innerHTML = messages.map(function(msg) {
        const isMod = cachedUsers[msg.username] && cachedUsers[msg.username].isModerator;
        const banBtn = currentUser.isModerator && msg.username !== currentUser.username ? 
            '<button onclick="toggleBanUser(\'' + msg.username + '\')" class="ban-btn">🚫</button>' : '';
        
        return `
            <div class="message">
                <div class="message-avatar">${msg.username ? msg.username[0].toUpperCase() : '?'}</div>
                <div class="message-content">
                    <div class="message-header">
                        <span class="username">${msg.username || 'Unknown'} ${isMod ? '👑' : ''}</span>
                        <span class="timestamp">${formatTimestamp(msg.timestamp)}</span>
                    </div>
                    ${msg.type === 'image' ? 
                        '<img src="' + msg.imageUrl + '" alt="Shared image" class="message-image" />' :
                        '<p>' + (msg.text || '') + '</p>'
                    }
                </div>
                ${banBtn}
            </div>
        `;
    }).join('');
    
    container.scrollTop = container.scrollHeight;
}

function renderRoomsList(rooms) {
    const container = document.getElementById('roomsList');
    if (!container) return;
    
    // Ensure general is always first
    const sortedRooms = rooms.slice().sort(function(a, b) {
        if (a.id === 'general') return -1;
        if (b.id === 'general') return 1;
        return 0;
    });
    
    container.innerHTML = sortedRooms.map(function(room) {
        const isActive = currentRoom === room.id && !selectedDM && !showModPanel;
        return `
            <button class="room-item ${isActive ? 'active' : ''}" 
                    onclick="event.preventDefault(); switchRoom('${room.id}')">
                # ${room.name}
            </button>
        `;
    }).join('');
}

function renderUsersList(users) {
    const container = document.getElementById('usersList');
    if (!container) return;
    
    container.innerHTML = users.map(function(user) {
        const isActive = selectedDM === user.username && !showModPanel;
        return `
            <button class="user-item ${isActive ? 'active' : ''}" 
                    onclick="event.preventDefault(); switchToDM('${user.username}')">
                <span class="online-dot"></span>
                ${user.username}
                ${user.isModerator ? '👑' : ''}
            </button>
        `;
    }).join('');
}

function updateModerationUI(config) {
    const bannedList = document.getElementById('bannedUsersList');
    const filteredList = document.getElementById('filteredWordsList');
    const userMgmtList = document.getElementById('userManagementList');
    
    if (bannedList && config.bannedUsers) {
        bannedList.innerHTML = config.bannedUsers.length > 0 ? config.bannedUsers.map(function(username) {
            return `
                <div class="banned-user">
                    <span>${username}</span>
                    <button onclick="toggleBanUser('${username}')">Unban</button>
                </div>
            `;
        }).join('') : '<p style="color: #94a3b8;">No banned users</p>';
    }
    
    if (filteredList && config.filteredWords) {
        filteredList.innerHTML = config.filteredWords.length > 0 ? config.filteredWords.map(function(word) {
            return `
                <span class="filter-tag">
                    ${word}
                    <button onclick="removeFilterWord('${word}')">×</button>
                </span>
            `;
        }).join('') : '<p style="color: #94a3b8;">No filtered words</p>';
    }
    
    if (userMgmtList) {
        // Get all accounts for user management
        db.collection('accounts').get().then(function(snapshot) {
            const users = snapshot.docs.map(function(doc) {
                return { username: doc.id, ...doc.data() };
            }).filter(function(u) {
                return u.username !== currentUser.username;
            }).sort(function(a, b) {
                return a.username.localeCompare(b.username);
            });
            
            userMgmtList.innerHTML = users.length > 0 ? users.map(function(user) {
                return `
                    <div class="user-mgmt-item">
                        <div class="user-info">
                            <span class="username-display">${user.username} ${user.isModerator ? '👑' : ''}</span>
                            <span class="user-status ${user.online ? 'online' : 'offline'}">${user.online ? 'Online' : 'Offline'}</span>
                        </div>
                        <div class="user-actions">
                            <button onclick="viewUserPassword('${user.username}')" class="action-btn" title="View password">🔑</button>
                            <button onclick="toggleModStatus('${user.username}')" class="action-btn" title="${user.isModerator ? 'Remove mod' : 'Make mod'}">
                                ${user.isModerator ? '👤' : '👑'}
                            </button>
                            <button onclick="toggleBanUser('${user.username}')" class="action-btn" title="Ban/Unban">🚫</button>
                            <button onclick="deleteAccount('${user.username}')" class="action-btn danger" title="Delete account">🗑️</button>
                        </div>
                    </div>
                `;
            }).join('') : '<p style="color: #94a3b8;">No other users</p>';
        });
    }
}

// Helper functions
function getUsernameById(username) {
    return username || 'Unknown User';
}

function getRoomName(roomId) {
    if (roomId === 'general') return 'General';
    return cachedRooms[roomId] ? cachedRooms[roomId].name : 'Room';
}

function formatTimestamp(timestamp) {
    if (!timestamp) return '';
    
    try {
        const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (e) {
        return '';
    }
}

function handleKeyPress(event) {
    if (event.key === 'Enter') {
        sendMessageFromInput();
    }
}

function sendMessageFromInput() {
    const input = document.getElementById('messageInput');
    if (input && input.value.trim()) {
        sendMessage(input.value);
        input.value = '';
    }
}

async function handleImageUpload(event) {
    const file = event.target.files[0];
    if (file) {
        const imageUrl = await uploadImage(file);
        if (imageUrl) {
            await sendMessage('', imageUrl);
        }
    }
}

function toggleEmojiPicker() {
    const picker = document.getElementById('emojiPicker');
    if (picker) {
        picker.style.display = picker.style.display === 'none' ? 'flex' : 'none';
    }
}

function addEmoji(emoji) {
    const input = document.getElementById('messageInput');
    if (input) {
        input.value += emoji;
        input.focus();
        toggleEmojiPicker();
    }
}

function createRoomPrompt() {
    const roomName = prompt('Enter room name:');
    if (roomName) {
        createRoom(roomName);
    }
}

function toggleModPanel() {
    showModPanel = !showModPanel;
    renderApp();
}

function addFilterWordFromInput() {
    const input = document.getElementById('filterWordInput');
    if (input && input.value.trim()) {
        addFilterWord(input.value);
        input.value = '';
    }
}

// Manual cleanup trigger
async function manualCleanupOldMessages() {
    if (!currentUser || !currentUser.isModerator) {
        alert('Only moderators can run cleanup');
        return;
    }
    
    const confirm = window.confirm('Delete all messages older than 24 hours? This helps save Firebase storage.');
    if (!confirm) return;
    
    console.log('Running manual message cleanup...');
    
    try {
        const oneDayAgo = new Date();
        oneDayAgo.setDate(oneDayAgo.getDate() - 1);
        
        // Delete old room messages
        const messagesSnapshot = await db.collection('messages')
            .where('timestamp', '<', oneDayAgo)
            .get();
        
        // Delete old DM messages
        const dmSnapshot = await db.collection('directMessages')
            .where('timestamp', '<', oneDayAgo)
            .get();
        
        const batch = db.batch();
        let deleteCount = 0;
        
        messagesSnapshot.docs.forEach(function(doc) {
            batch.delete(doc.ref);
            deleteCount++;
        });
        
        dmSnapshot.docs.forEach(function(doc) {
            batch.delete(doc.ref);
            deleteCount++;
        });
        
        if (deleteCount > 0) {
            await batch.commit();
            alert('Successfully deleted ' + deleteCount + ' old messages (older than 24 hours)');
        } else {
            alert('No old messages to delete');
        }
        
        // Save last cleanup time
        localStorage.setItem('lastMessageCleanup', new Date().getTime().toString());
        
    } catch (error) {
        console.error('Error during manual cleanup:', error);
        alert('Failed to run cleanup. Check console for details.');
    }
}

// Clean up on page unload
window.addEventListener('beforeunload', function() {
    updateUserOnlineStatus(false);
});