import React, { useEffect, useState } from 'react';
import { AIProvider } from '../types';
import { loadLocalSettings, saveLocalSettings } from '../services/aiService';
import { useAuth } from '../contexts/AuthContext';
import * as dbService from '../services/dbService';
import { getThemePreference, setThemePreference, type ThemePreference } from '../theme';

const PROVIDERS: { id: AIProvider; name: string }[] = [
    { id: 'gemini', name: 'Gemini' },
    { id: 'openai', name: 'OpenAI' },
    { id: 'openrouter', name: 'OpenRouter' },
    { id: 'groq', name: 'Groq' },
];

const THEMES: { id: ThemePreference; name: string }[] = [
    { id: 'light', name: 'Light' },
    { id: 'dark', name: 'Dark' },
    { id: 'system', name: 'System' },
];

interface SettingsModalProps {
    onClose: () => void;
}

// Provider and key edits are a draft until saved: closing any other way leaves them untouched.
// Appearance is the exception: it applies and persists on click, because Save needs an API key.
const SettingsModal: React.FC<SettingsModalProps> = ({ onClose }) => {
    const { user } = useAuth();
    const [saved] = useState(loadLocalSettings);
    const [selectedProvider, setSelectedProvider] = useState<AIProvider>(saved.provider);
    const [apiKeys, setApiKeys] = useState<Record<AIProvider, string>>(saved.apiKeys);
    const [theme, setTheme] = useState(getThemePreference);

    const chooseTheme = (next: ThemePreference) => {
        setTheme(next);
        setThemePreference(next);
    };

    // Close the settings modal with Escape
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [onClose]);

    const handleSaveSettings = () => {
        const settings = { provider: selectedProvider, apiKeys };
        saveLocalSettings(settings);
        if (user) {
            // Reload so Firestore gets the same trimmed keys as this browser.
            void dbService.saveSettings(user.uid, loadLocalSettings());
        }
        onClose();
    };

    const currentProviderHasKey = apiKeys[selectedProvider]?.trim() !== '';

    return (
        <div
            className="modal-overlay fixed inset-0 flex items-center justify-center z-50"
            style={{
                backgroundColor: 'rgba(0, 0, 0, 0.25)',
                backdropFilter: 'blur(8px)',
                WebkitBackdropFilter: 'blur(8px)'
            }}
            onClick={onClose}
        >
            <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="api-key-modal-title"
                className="modal-panel custom-scrollbar rounded-2xl p-4 sm:p-6 max-w-md w-full mx-4 shadow-xl max-h-[90vh] overflow-y-auto"
                style={{
                    backgroundColor: 'var(--bg-warm)',
                    border: '1px solid var(--border-light)'
                }}
                onClick={(e) => e.stopPropagation()}
            >
                <h2 id="api-key-modal-title" className="font-title text-2xl font-semibold mb-4" style={{ color: 'var(--text-dark)' }}>
                    AI Provider Settings
                </h2>

                <p id="appearance-label" className="text-sm mb-2" style={{ color: 'var(--text-muted)' }}>
                    Appearance
                </p>
                <div role="group" aria-labelledby="appearance-label" className="flex gap-2 mb-4">
                    {THEMES.map((option) => (
                        <button
                            key={option.id}
                            type="button"
                            onClick={() => chooseTheme(option.id)}
                            aria-pressed={theme === option.id}
                            className="flex-1 p-2 rounded-xl border text-sm font-medium transition-all"
                            style={{
                                color: 'var(--text-dark)',
                                borderColor: theme === option.id ? 'var(--accent-pink)' : 'var(--border-light)',
                                backgroundColor: theme === option.id ? 'var(--accent-pink-light)' : 'var(--bg-white)'
                            }}
                        >
                            {option.name}
                        </button>
                    ))}
                </div>

                {/* Provider Selection */}
                <p className="text-sm mb-2" style={{ color: 'var(--text-muted)' }}>
                    Select AI Provider
                </p>
                <div className="flex flex-col gap-2 mb-4">
                    {PROVIDERS.map((provider) => (
                        <button
                            key={provider.id}
                            onClick={() => setSelectedProvider(provider.id)}
                            className="flex items-center gap-3 p-3 rounded-xl transition-all text-left"
                            style={{
                                borderColor: selectedProvider === provider.id ? 'var(--accent-pink)' : 'var(--border-light)',
                                backgroundColor: selectedProvider === provider.id ? 'var(--accent-pink-light)' : 'var(--bg-white)'
                            }}
                        >
                            <div
                                className="w-4 h-4 rounded-full border-2 flex items-center justify-center"
                                style={{ borderColor: selectedProvider === provider.id ? 'var(--accent-pink)' : 'var(--border-light)' }}
                            >
                                {selectedProvider === provider.id && (
                                    <div
                                        className="w-2 h-2 rounded-full"
                                        style={{ backgroundColor: 'var(--accent-pink)' }}
                                    />
                                )}
                            </div>
                            <div className="font-medium text-sm" style={{ color: 'var(--text-dark)' }}>
                                {provider.name}
                                {saved.apiKeys[provider.id] && (
                                    <span className="ml-2 text-xs" style={{ color: 'var(--text-muted)' }}>✓ Key saved</span>
                                )}
                            </div>
                        </button>
                    ))}
                </div>

                {/* API Key Input */}
                <p className="text-sm mb-2" style={{ color: 'var(--text-muted)' }}>
                    {PROVIDERS.find(p => p.id === selectedProvider)?.name} API Key
                </p>
                <input
                    type="password"
                    value={apiKeys[selectedProvider]}
                    onChange={(e) => setApiKeys(prev => ({ ...prev, [selectedProvider]: e.target.value }))}
                    placeholder={`Enter your ${PROVIDERS.find(p => p.id === selectedProvider)?.name} API key...`}
                    className="input-field w-full mb-4"
                />

                <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>
                    {selectedProvider === 'gemini' && (
                        <>Get your key from <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer" className="underline">Google AI Studio</a></>
                    )}
                    {selectedProvider === 'openai' && (
                        <>Get your key from <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer" className="underline">OpenAI Platform</a></>
                    )}
                    {selectedProvider === 'openrouter' && (
                        <>Get your key from <a href="https://openrouter.ai/keys" target="_blank" rel="noopener noreferrer" className="underline">OpenRouter</a></>
                    )}
                    {selectedProvider === 'groq' && (
                        <>Get your key from <a href="https://console.groq.com/keys" target="_blank" rel="noopener noreferrer" className="underline">Groq Console</a></>
                    )}
                </p>

                <div className="flex gap-3 justify-end">
                    <button
                        onClick={onClose}
                        className="px-4 py-2 text-sm rounded-full"
                        style={{ color: 'var(--text-muted)' }}
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleSaveSettings}
                        className="btn-dark"
                        disabled={!currentProviderHasKey}
                        style={{ opacity: currentProviderHasKey ? 1 : 0.5 }}
                    >
                        Save Settings
                    </button>
                </div>
            </div>
        </div>
    );
};

export default SettingsModal;
