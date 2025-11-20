// Replace these values with your Firebase project configuration
// Get this from Firebase Console → Project Settings → Your Apps → Web App
const firebaseConfig = {
  apiKey: "AIzaSyAhqDi94LqMQ_BY6mB8l9savM-UUf71Mk8",
  authDomain: "chat-app-2471a.firebaseapp.com",
  projectId: "chat-app-2471a",
  storageBucket: "chat-app-2471a.firebasestorage.app",
  messagingSenderId: "583736755420",
  appId: "1:583736755420:web:4c3212d6a00d56b8436019",
  measurementId: "G-X8N84YGZ30"
};
// Initialize Firebase
firebase.initializeApp(firebaseConfig);

// Initialize services
const db = firebase.firestore();
const storage = firebase.storage();

// Moderator password - In production, this should be hashed and stored securely
const MOD_PASSWORD = "admin123"; // Change this!