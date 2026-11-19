
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import Background from './components/Background';
import './firebase.config';
import './theme'; // applies the saved theme and follows OS changes
import { AuthProvider } from './contexts/AuthContext';

// Check-in notifications are shown through it (see public/sw.js).
navigator.serviceWorker?.register('/sw.js').catch(() => { /* notifications fall back to new Notification() */ });

const rootElement = document.getElementById('root');
if (!rootElement) {
    throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
    <React.StrictMode>
        <AuthProvider>
            <Background />
            <App />
        </AuthProvider>
    </React.StrictMode>
);
