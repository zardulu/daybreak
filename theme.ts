export type ThemePreference = 'light' | 'dark' | 'system';

// Kept apart from AISettings, which Firestore overwrites on sign-in. The inline script in
// index.html reads the same key before first paint; keep the two in step.
const STORAGE_KEY = 'daybreak-theme';
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

const readPreference = (): ThemePreference => {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored === 'light' || stored === 'dark') return stored;
    } catch { /* storage blocked: follow the OS */ }
    return 'system';
};

let preference = readPreference();

const applyTheme = () => {
    const dark = preference === 'dark' || (preference === 'system' && darkQuery.matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
};

// Module scope rather than a hook, so OS changes apply while Settings is closed.
darkQuery.addEventListener('change', applyTheme);
applyTheme();

export const getThemePreference = () => preference;

export const setThemePreference = (next: ThemePreference) => {
    preference = next;
    try {
        localStorage.setItem(STORAGE_KEY, next);
    } catch { /* still applies for this tab */ }
    applyTheme();
};
