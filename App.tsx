import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import InitialTaskInput from './components/InitialTaskInput';
import ChatInterface from './components/ChatInterface';
import FocusShell from './components/FocusShell';
import { ChatMessage, SessionTask, AIProvider, ScheduledTask } from './types';
import { generateCheckinMessage, hasApiKey, ReminderConfig, TaskUpdate, streamReply, toChatHistory, SessionContext, ChatTurn } from './services/aiService';
import { useAuth } from './contexts/AuthContext';
import * as dbService from './services/dbService';
import { useDailySession, getTodayDateString } from './hooks/useDailySession';
import { ToastContainer, useToasts } from './components/Toasts';

const PROVIDERS: { id: AIProvider; name: string }[] = [
    { id: 'gemini', name: 'Gemini' },
    { id: 'openai', name: 'OpenAI' },
    { id: 'openrouter', name: 'OpenRouter' },
    { id: 'groq', name: 'Groq' },
];

interface SessionTaskState {
    tasks: SessionTask[];
    currentTaskId: string | null;
}

interface TaskUpdateResult {
    currentTitle: string;
    tasks: SessionTask[];
    shouldShowTaskList: boolean;
}

interface ActiveTimer {
    type: 'one-time' | 'recurring';
    task: string;
    durationMs: number;
    endAt: number;
}

interface PendingTimerRequest {
    reminder: ReminderConfig;
    fallbackTask: string;
    currentTimer: {
        type: ActiveTimer['type'];
        task: string;
        remainingSeconds: number;
    };
}

const normalizeTaskTitle = (title: string) => title.trim().toLowerCase().replace(/\s+/g, ' ');

const createSessionTaskId = () => {
    const randomPart = Math.random().toString(36).slice(2, 8);
    return `task-${Date.now()}-${randomPart}`;
};

const createChatMessageId = () => {
    const randomPart = Math.random().toString(36).slice(2, 8);
    return `msg-${Date.now()}-${randomPart}`;
};

const resolveCurrentTaskTitle = (taskUpdate: TaskUpdate | null, fallbackTask: string) => {
    const explicitCurrent = taskUpdate?.currentTaskTitle?.trim();
    if (explicitCurrent) return explicitCurrent;

    const flaggedCurrent = taskUpdate?.tasks.find(task => task.isCurrent)?.title.trim();
    if (flaggedCurrent) return flaggedCurrent;

    return fallbackTask.trim();
};

const App: React.FC = () => {
    const { user, loading: authLoading } = useAuth();
    const userRef = useRef(user);
    const { toasts, pushToast, dismissToast } = useToasts();

    // Daily session management — resets chat at midnight for signed-in users
    const handleSessionChange = useCallback((newSessionId: string) => {
        // Reset all chat state for the new day
        setTask(null);
        setMessages([]);
        setSessionTaskState({ tasks: [], currentTaskId: null });
        setStreamingText('');
        setStreamingComplete(false);
        setIsLoading(false);
        // Stop any active timers
        if (workerRef.current) {
            workerRef.current.postMessage({ action: 'stop' });
        }
        setActiveTimer(null);
        timerTypeRef.current = null;
        timerTaskRef.current = '';
        checkinsLeftRef.current = null;
        setPendingTimerRequest(null);
    }, []);
    const { sessionId, isNewSession, displayDate, sessionLoading } = useDailySession(user, handleSessionChange);
    const sessionIdRef = useRef(sessionId);
    useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);

    const [task, setTask] = useState<string | null>(null);
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [sessionTaskState, setSessionTaskState] = useState<SessionTaskState>({
        tasks: [],
        currentTaskId: null,
    });
    const [isInitializing, setIsInitializing] = useState<boolean>(true);
    const [isLoading, setIsLoading] = useState<boolean>(false);
    const [streamingText, setStreamingText] = useState<string>('');
    const [streamingComplete, setStreamingComplete] = useState<boolean>(false);
    const [notificationPermission, setNotificationPermission] = useState<NotificationPermission>('default');
    const [showApiKeyModal, setShowApiKeyModal] = useState<boolean>(false);
    const [selectedProvider, setSelectedProvider] = useState<AIProvider>('gemini');
    const [apiKeys, setApiKeys] = useState<Record<AIProvider, string>>({
        gemini: '',
        openai: '',
        openrouter: '',
        groq: ''
    });
    const [activeTimer, setActiveTimer] = useState<ActiveTimer | null>(null);
    const [pendingTimerRequest, setPendingTimerRequest] = useState<PendingTimerRequest | null>(null);
    const [currentTime, setCurrentTime] = useState<number>(() => Date.now());
    const workerRef = useRef<Worker | null>(null);
    const currentTaskRef = useRef<string>(''); // Store current task for worker callback
    const timerTaskRef = useRef<string>(''); // Keep active timer check-ins tied to their original task
    const checkinsLeftRef = useRef<number | null>(null); // Recurring check-ins left in the session; null = no end

    // Refresh the visible countdown once per second while a timer is running.
    useEffect(() => {
        if (!activeTimer) return;

        const updateCurrentTime = () => setCurrentTime(Date.now());
        updateCurrentTime();
        const intervalId = window.setInterval(updateCurrentTime, 1000);

        return () => window.clearInterval(intervalId);
    }, [activeTimer]);

    const timerRemainingSeconds = activeTimer
        ? Math.max(0, Math.ceil((activeTimer.endAt - currentTime) / 1000))
        : null;

    // Keep userRef updated to avoid stale closures in worker callbacks
    useEffect(() => {
        userRef.current = user;
    }, [user]);

    const currentSessionTask = useMemo(
        () => sessionTaskState.tasks.find(sessionTask => sessionTask.id === sessionTaskState.currentTaskId) ?? null,
        [sessionTaskState]
    );
    const currentTaskTitle = currentSessionTask?.title ?? task ?? '';

    const applyTaskUpdate = useCallback((taskUpdate: TaskUpdate | null, fallbackTask: string, shouldUseFallback: boolean): TaskUpdateResult => {
        const currentTitle = resolveCurrentTaskTitle(taskUpdate, shouldUseFallback ? fallbackTask : '');

        if (!taskUpdate && !currentTitle) {
            return {
                currentTitle: '',
                tasks: sessionTaskState.tasks,
                shouldShowTaskList: false,
            };
        }

        const detectedTasks = taskUpdate?.tasks ?? [];
        const todayDate = getTodayDateString();

        // Separate future-dated tasks from current-session tasks
        const futureTasks = detectedTasks.filter(t => t.scheduledDate && t.scheduledDate > todayDate);
        const todayTasks = detectedTasks.filter(t => !t.scheduledDate || t.scheduledDate <= todayDate);

        // Save future tasks to scheduledTasks collection
        if (futureTasks.length > 0 && user) {
            for (const ft of futureTasks) {
                const scheduledTask: ScheduledTask = {
                    id: createSessionTaskId(),
                    title: ft.title.trim(),
                    scheduledDate: ft.scheduledDate!,
                    createdAt: Date.now(),
                    consumed: false,
                };
                void dbService.saveScheduledTask(user.uid, scheduledTask);
            }
        }

        // Process today's tasks into the session
        const tasks = [...sessionTaskState.tasks];
        const tasksByTitle = new Map(tasks.map(sessionTask => [normalizeTaskTitle(sessionTask.title), sessionTask]));

        for (const detectedTask of todayTasks) {
            const title = detectedTask.title.trim();
            if (!title) continue;

            const normalizedTitle = normalizeTaskTitle(title);
            if (!tasksByTitle.has(normalizedTitle)) {
                const sessionTask: SessionTask = {
                    id: createSessionTaskId(),
                    title,
                    createdAt: Date.now(),
                };
                tasks.push(sessionTask);
                tasksByTitle.set(normalizedTitle, sessionTask);
            }
        }

        let currentTaskId = sessionTaskState.currentTaskId;
        if (currentTitle) {
            const normalizedCurrentTitle = normalizeTaskTitle(currentTitle);
            let currentTask = tasksByTitle.get(normalizedCurrentTitle);

            if (!currentTask) {
                currentTask = {
                    id: createSessionTaskId(),
                    title: currentTitle,
                    createdAt: Date.now(),
                };
                tasks.push(currentTask);
                tasksByTitle.set(normalizedCurrentTitle, currentTask);
            }

            currentTaskId = currentTask.id;
        }

        setSessionTaskState({ tasks, currentTaskId });

        currentTaskRef.current = currentTitle;

        // Sync to Firebase if user is logged in
        if (user) {
            tasks.forEach(t => void dbService.saveTask(user.uid, sessionId, t));
            void dbService.saveChatState(user.uid, sessionId, {
                task: currentTitle || fallbackTask || task,
                currentTaskId
            });
        }

        // shouldShowTaskList should reflect today tasks being added (not just future ones)
        const hasTodayTasksAdded = todayTasks.some(detectedTask => detectedTask.title.trim().length > 0);
        const hasFutureTasksAdded = futureTasks.length > 0;

        return {
            currentTitle,
            tasks,
            shouldShowTaskList: hasTodayTasksAdded || hasFutureTasksAdded,
        };
    }, [sessionTaskState, user, task, sessionId]);

    const getTaskListMessageMeta = (taskUpdateResult: TaskUpdateResult): Partial<ChatMessage> => {
        if (!taskUpdateResult.shouldShowTaskList || taskUpdateResult.tasks.length === 0) {
            return {};
        }

        return {
            showTaskList: true,
            taskListSnapshot: taskUpdateResult.tasks,
            currentTaskSnapshot: taskUpdateResult.currentTitle,
        };
    };

    const getTaskActionStatusText = (taskUpdateResult: TaskUpdateResult, timerStarted: boolean) => {
        const actions: string[] = [];

        if (taskUpdateResult.shouldShowTaskList) {
            actions.push(taskUpdateResult.tasks.length === 1 ? 'Added task to task list' : 'Added tasks to task list');
        }

        if (timerStarted) {
            actions.push('Set timer');
        }

        return actions.join(' and ');
    };

    useEffect(() => {
        // Load saved provider and keys
        const savedProvider = localStorage.getItem('ai_provider') as AIProvider;
        if (savedProvider) {
            setSelectedProvider(savedProvider);
        }

        setApiKeys({
            gemini: (localStorage.getItem('gemini_api_key') || '').trim(),
            openai: (localStorage.getItem('openai_api_key') || '').trim(),
            openrouter: (localStorage.getItem('openrouter_api_key') || '').trim(),
            groq: (localStorage.getItem('groq_api_key') || '').trim(),
        });

        if ('Notification' in window && Notification.permission !== 'denied') {
            Notification.requestPermission().then(setNotificationPermission);
        } else if ('Notification' in window) {
            setNotificationPermission(Notification.permission);
        }
    }, []);

    // Close the settings modal with Escape
    useEffect(() => {
        if (!showApiKeyModal) return;

        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setShowApiKeyModal(false);
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [showApiKeyModal]);

    // Sync remote data when user signs in/out
    useEffect(() => {
        if (authLoading || sessionLoading) return; // Wait for auth and session to resolve

        if (!user) {
            // User signed out: reset state to default
            setTask(null);
            setMessages([]);
            setSessionTaskState({
                tasks: [],
                currentTaskId: null,
            });
            setIsInitializing(false);
            return;
        }

        const handleAuthSync = async () => {
            try {
                // 1. Sync settings if remote settings exist, otherwise upload local ones
                const remoteSettings = await dbService.loadSettings(user.uid);
                if (remoteSettings) {
                    setSelectedProvider(remoteSettings.provider);
                    setApiKeys(remoteSettings.apiKeys);
                    localStorage.setItem('ai_provider', remoteSettings.provider);
                    Object.entries(remoteSettings.apiKeys).forEach(([prov, key]) => {
                        localStorage.setItem(`${prov}_api_key`, key);
                    });
                } else {
                    await dbService.saveSettings(user.uid, {
                        provider: selectedProvider,
                        apiKeys,
                    });
                }

                // 2. Load remote messages, tasks, and state for the current session
                const remoteMessages = await dbService.loadMessages(user.uid, sessionId);
                const remoteTasks = await dbService.loadTasks(user.uid, sessionId);
                const remoteState = await dbService.loadChatState(user.uid, sessionId);

                // Migration: If user had active anonymous messages and signs in mid-session,
                // save their current progress to Firestore.
                if (messages.length > 0 && remoteMessages.length === 0) {
                    const localChatState = { task, currentTaskId: sessionTaskState.currentTaskId };
                    await dbService.syncLocalDataToFirebase(user.uid, sessionId, messages, sessionTaskState.tasks, localChatState);
                } else {
                    // Otherwise restore user's remote thread
                    if (remoteMessages.length > 0) {
                        setMessages(remoteMessages);
                    }
                    if (remoteTasks.length > 0 || remoteState?.currentTaskId) {
                        setSessionTaskState({
                            tasks: remoteTasks,
                            currentTaskId: remoteState?.currentTaskId || null
                        });
                    }
                    if (remoteState?.task) {
                        setTask(remoteState.task);
                        currentTaskRef.current = remoteState.task;
                    }
                }

                // 3. Load any scheduled tasks for today and inject them into the session
                const todayDate = getTodayDateString();
                const scheduledForToday = await dbService.loadScheduledTasksForDate(user.uid, todayDate);
                if (scheduledForToday.length > 0) {
                    // Convert scheduled tasks to session tasks
                    const newSessionTasks: SessionTask[] = scheduledForToday.map(st => ({
                        id: createSessionTaskId(),
                        title: st.title,
                        createdAt: Date.now(),
                    }));

                    // Merge into session state (dedup by title)
                    setSessionTaskState(prev => {
                        const existing = new Map(prev.tasks.map(t => [normalizeTaskTitle(t.title), t]));
                        const merged = [...prev.tasks];
                        for (const nst of newSessionTasks) {
                            if (!existing.has(normalizeTaskTitle(nst.title))) {
                                merged.push(nst);
                                existing.set(normalizeTaskTitle(nst.title), nst);
                            }
                        }
                        const firstNewId = newSessionTasks[0]?.id;
                        return {
                            tasks: merged,
                            currentTaskId: prev.currentTaskId || firstNewId || null,
                        };
                    });

                    // Save the injected tasks to the session in Firestore
                    for (const nst of newSessionTasks) {
                        void dbService.saveTask(user.uid, sessionId, nst);
                    }

                    // Set the main task if not already set, so the chat view activates
                    if (!remoteState?.task) {
                        const firstTitle = newSessionTasks[0]?.title || '';
                        setTask(firstTitle);
                        currentTaskRef.current = firstTitle;
                        void dbService.saveChatState(user.uid, sessionId, {
                            task: firstTitle,
                            currentTaskId: newSessionTasks[0]?.id || null
                        });
                    }

                    // Create a welcome message with the task card
                    const welcomeMsgId = createChatMessageId();
                    const taskCount = newSessionTasks.length;
                    const welcomeMsg: ChatMessage = {
                        id: welcomeMsgId,
                        sender: 'ai',
                        text: taskCount === 1
                            ? `Good morning! \u2728 You have a task lined up for today: "${newSessionTasks[0].title}". Ready to get started?`
                            : `Good morning! \u2728 You have ${taskCount} tasks lined up for today. Let's make it a productive one!`,
                        showTaskList: true,
                        taskListSnapshot: newSessionTasks,
                        currentTaskSnapshot: newSessionTasks[0]?.title,
                    };
                    setMessages(prev => [...prev, welcomeMsg]);
                    void dbService.saveMessage(user.uid, sessionId, welcomeMsg);

                    // Mark scheduled tasks as consumed
                    await dbService.markScheduledTasksConsumed(
                        user.uid,
                        scheduledForToday.map(st => st.id)
                    );
                }
            } catch (error) {
                console.error('Error syncing auth state data:', error);
            } finally {
                setIsInitializing(false);
            }
        };

        void handleAuthSync();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [user, authLoading, sessionId, sessionLoading]);

    const handleSaveSettings = () => {
        localStorage.setItem('ai_provider', selectedProvider);
        localStorage.setItem('gemini_api_key', apiKeys.gemini.trim());
        localStorage.setItem('openai_api_key', apiKeys.openai.trim());
        localStorage.setItem('openrouter_api_key', apiKeys.openrouter.trim());
        localStorage.setItem('groq_api_key', apiKeys.groq.trim());
        setShowApiKeyModal(false);

        if (user) {
            void dbService.saveSettings(user.uid, {
                provider: selectedProvider,
                apiKeys
            });
        }
    };

    // Prevent concurrent API calls
    const isGeneratingRef = useRef<boolean>(false);
    const timerTypeRef = useRef<'one-time' | 'recurring' | null>(null);

    // Send a single check-in (used by both one-time and recurring)
    const sendCheckin = useCallback(async (fallbackTask: string) => {
        if (isGeneratingRef.current) {
            return;
        }

        isGeneratingRef.current = true;

        try {
            const taskForCheckin = fallbackTask || currentTaskRef.current;
            const checkinMessage = await generateCheckinMessage(taskForCheckin);

            // Show browser notification if permission granted
            if (Notification.permission === 'granted') {
                new Notification('Focus Fairy Check-in ✨', {
                    body: checkinMessage,
                    icon: '/fairy.svg'
                });
            }

            // Add message to chat
            const msgId = createChatMessageId();
            const msg: ChatMessage = { id: msgId, sender: 'ai', text: `🔔 ${checkinMessage}` };
            setMessages(prev => [...prev, msg]);
            const currentUser = userRef.current;
            if (currentUser) {
                void dbService.saveMessage(currentUser.uid, sessionIdRef.current, msg);
            }
        } catch {
            pushToast('Check-in failed. Please check your API key in Settings.', 'error');
        } finally {
            isGeneratingRef.current = false;
        }
    }, [pushToast]);

    // Start a one-time or recurring timer - using Web Worker for reliable background execution
    const startTimer = useCallback((reminder: ReminderConfig, fallbackTask: string) => {
        // Store task for callback
        currentTaskRef.current = fallbackTask;
        timerTaskRef.current = fallbackTask;
        timerTypeRef.current = reminder.type;
        // Epsilon keeps float division (e.g. 0.3 / 0.1) from dropping the last check-in.
        checkinsLeftRef.current = reminder.type === 'recurring' && reminder.sessionMinutes
            ? Math.floor(reminder.sessionMinutes / reminder.minutes + 1e-6)
            : null;

        const milliseconds = reminder.minutes * 60 * 1000;

        setActiveTimer({
            type: reminder.type,
            task: fallbackTask,
            durationMs: milliseconds,
            endAt: Date.now() + milliseconds,
        });

        // Start worker timer
        if (workerRef.current) {
            workerRef.current.postMessage({ action: 'start', milliseconds, type: reminder.type });
        }
    }, []);

    // Initialize Web Worker and handle messages
    useEffect(() => {
        // Create worker
        workerRef.current = new Worker('/timer-worker.js');

        // Handle timer ticks from worker
        workerRef.current.onmessage = async (e) => {
            if (e.data.type === 'tick') {
                const timerTask = timerTaskRef.current || currentTaskRef.current;
                if (checkinsLeftRef.current !== null) checkinsLeftRef.current -= 1;

                if (timerTypeRef.current === 'one-time' || checkinsLeftRef.current === 0) {
                    // Last check-in: one-time reminders fire once, sessions end when their time is up.
                    workerRef.current?.postMessage({ action: 'stop' });
                    setActiveTimer(null);
                    timerTypeRef.current = null;
                    timerTaskRef.current = '';
                    checkinsLeftRef.current = null;
                } else if (timerTypeRef.current === 'recurring') {
                    // The worker interval keeps running; move the UI deadline to
                    // the next interval as soon as a check-in is triggered.
                    setActiveTimer(previousTimer => previousTimer
                        ? { ...previousTimer, endAt: Date.now() + previousTimer.durationMs }
                        : previousTimer
                    );
                }

                await sendCheckin(timerTask);
            }
        };

        return () => {
            if (workerRef.current) {
                workerRef.current.postMessage({ action: 'stop' });
                workerRef.current.terminate();
            }
        };
    }, [sendCheckin]);

    // Handle reminder configuration from AI tool calls. Returns whether a timer started right away.
    const handleReminderConfig = useCallback((reminder: ReminderConfig | null, fallbackTask: string): boolean => {
        if (!reminder) {
            return false;
        }

        // Check browser API directly instead of React state (which can be stale)
        const currentPermission = Notification.permission;

        if (currentPermission !== 'granted') {
            pushToast('Enable notifications in your browser to get check-in reminders!', 'warning');
            return false;
        }

        if (activeTimer) {
            setPendingTimerRequest({
                reminder,
                fallbackTask,
                currentTimer: {
                    type: activeTimer.type,
                    task: activeTimer.task,
                    remainingSeconds: timerRemainingSeconds ?? 0,
                },
            });
            return false;
        }

        startTimer(reminder, fallbackTask);
        return true;
    }, [activeTimer, pushToast, startTimer, timerRemainingSeconds]);

    const confirmPendingTimerReplacement = useCallback(() => {
        if (!pendingTimerRequest) return;

        const { reminder, fallbackTask } = pendingTimerRequest;
        setPendingTimerRequest(null);
        startTimer(reminder, fallbackTask);
    }, [pendingTimerRequest, startTimer]);

    const keepCurrentTimer = useCallback(() => {
        setPendingTimerRequest(null);
    }, []);

    const sessionContext: SessionContext = {
        tasks: sessionTaskState.tasks.map(sessionTask => sessionTask.title),
        currentTask: currentTaskTitle || null,
        timerActive: Boolean(activeTimer),
    };

    // Every request fails without a key, so send the user to Settings before sending anything.
    const ensureApiKey = () => {
        if (hasApiKey()) return true;
        pushToast('Add an API key in Settings to get started. Free-tier keys work!', 'info');
        setShowApiKeyModal(true);
        return false;
    };

    // Stream the fairy's reply, then record tasks and start any timer it asked for.
    const sendToFairy = async (userText: string, history: ChatTurn[]) => {
        setIsLoading(true);
        setStreamingText('');
        setStreamingComplete(false);

        try {
            const { text, reminder, taskUpdate } = await streamReply(history, sessionContext, setStreamingText);

            // Mark streaming as complete (keeps showing last text until we add message)
            setStreamingComplete(true);

            const taskUpdateResult = applyTaskUpdate(taskUpdate, userText, Boolean(reminder));
            // Let AI decide the reminder configuration via tool calling
            const timerStarted = handleReminderConfig(reminder, taskUpdateResult.currentTitle || currentTaskTitle || userText);
            const actionStatusText = getTaskActionStatusText(taskUpdateResult, timerStarted);

            // The reply carries its status line and task list so they are saved together.
            const aiMessage: ChatMessage = {
                id: createChatMessageId(),
                sender: 'ai',
                text,
                ...(actionStatusText ? { showTaskActionStatus: true, taskActionStatusText: actionStatusText } : {}),
                ...getTaskListMessageMeta(taskUpdateResult),
            };
            setMessages(prev => [...prev, aiMessage]);
            if (user) {
                void dbService.saveMessage(user.uid, sessionId, aiMessage);
            }
            setStreamingText('');
            setStreamingComplete(false);
        } catch {
            pushToast("Couldn't reach your AI provider. Check your API key in Settings and try again.", 'error');
        } finally {
            setIsLoading(false);
        }
    };

    const handleTaskSubmit = async (newTask: string) => {
        if (!newTask.trim() || !ensureApiKey()) return;
        setTask(newTask);

        // Immediately show the user's message before waiting for AI response
        const userMessage: ChatMessage = { id: createChatMessageId(), sender: 'user', text: newTask };
        setMessages([userMessage]);
        if (user) {
            void dbService.saveMessage(user.uid, sessionId, userMessage);
            void dbService.saveChatState(user.uid, sessionId, { task: newTask, currentTaskId: null });
        }

        await sendToFairy(newTask, [{ role: 'user', content: newTask }]);
    };

    const handleSendMessage = async (userMessage: string) => {
        if (!userMessage.trim() || !task || !ensureApiKey()) return;

        const userMsg: ChatMessage = { id: createChatMessageId(), sender: 'user', text: userMessage };
        setMessages(prev => [...prev, userMsg]);
        if (user) {
            void dbService.saveMessage(user.uid, sessionId, userMsg);
        }

        await sendToFairy(userMessage, toChatHistory([...messages, userMsg]));
    };

    const currentProviderHasKey = apiKeys[selectedProvider]?.trim() !== '';
    const timerConfirmation = pendingTimerRequest
        ? {
            currentTask: activeTimer?.task || pendingTimerRequest.currentTimer.task,
            currentType: activeTimer?.type ?? pendingTimerRequest.currentTimer.type,
            currentRemainingSeconds: activeTimer
                ? timerRemainingSeconds ?? 0
                : pendingTimerRequest.currentTimer.remainingSeconds,
            nextTask: pendingTimerRequest.fallbackTask,
            nextType: pendingTimerRequest.reminder.type,
            nextDurationSeconds: Math.max(1, Math.round(pendingTimerRequest.reminder.minutes * 60)),
        }
        : null;

    return (
        <>
            <FocusShell
                onApiKeyClick={() => setShowApiKeyModal(true)}
                displayDate={displayDate}
                timerRemainingSeconds={timerRemainingSeconds}
                timerType={activeTimer?.type ?? null}
                timerConfirmation={timerConfirmation}
                onConfirmTimerReplacement={confirmPendingTimerReplacement}
                onKeepCurrentTimer={keepCurrentTimer}
            >
                {task ? (
                    <ChatInterface
                        task={task}
                        currentTask={currentTaskTitle}
                        messages={messages}
                        onSendMessage={handleSendMessage}
                        isLoading={isLoading}
                        streamingText={streamingText}
                        streamingComplete={streamingComplete}
                    />
                ) : (
                    <InitialTaskInput
                        onTaskSubmit={handleTaskSubmit}
                        isLoading={isLoading}
                        isInitializing={isInitializing}
                    />
                )}
            </FocusShell>

            {/* Toast Notifications */}
            <ToastContainer toasts={toasts} onDismiss={dismissToast} />

            {/* API Key Modal */}
            {showApiKeyModal && (
                <div
                    className="modal-overlay fixed inset-0 flex items-center justify-center z-50"
                    style={{
                        backgroundColor: 'rgba(0, 0, 0, 0.25)',
                        backdropFilter: 'blur(8px)',
                        WebkitBackdropFilter: 'blur(8px)'
                    }}
                    onClick={() => setShowApiKeyModal(false)}
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
                                        backgroundColor: selectedProvider === provider.id ? 'var(--accent-pink-light)' : 'white'
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
                                        {apiKeys[provider.id] && (
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
                                onClick={() => setShowApiKeyModal(false)}
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
            )}
        </>
    );
};

export default App;
