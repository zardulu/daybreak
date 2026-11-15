import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import InitialTaskInput from './components/InitialTaskInput';
import ChatInterface from './components/ChatInterface';
import FocusShell from './components/FocusShell';
import SettingsModal from './components/SettingsModal';
import { ChatMessage, SessionTask, ScheduledTask } from './types';
import { generateCheckinMessage, hasApiKey, loadLocalSettings, saveLocalSettings, TaskUpdate, streamReply, toChatHistory, SessionContext, ChatTurn } from './services/aiService';
import { useAuth } from './contexts/AuthContext';
import * as dbService from './services/dbService';
import { useDailySession, getTodayDateString } from './hooks/useDailySession';
import { useCheckinTimer } from './hooks/useCheckinTimer';
import { ToastContainer, useToasts } from './components/Toasts';

interface SessionTaskState {
    tasks: SessionTask[];
    currentTaskId: string | null;
}

interface TaskUpdateResult {
    currentTitle: string;
    tasks: SessionTask[];
    shouldShowTaskList: boolean;
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

// iOS Safari only has the Notification API in Home Screen apps, so check it exists first.
const canNotify = () => 'Notification' in window && Notification.permission === 'granted';

// Call from a submit handler: Safari ignores permission requests without a user gesture.
const requestNotificationPermission = () => {
    if ('Notification' in window && Notification.permission === 'default') {
        void Notification.requestPermission();
    }
};

// ponytail: check-ins only fire while the page runs. Phones suspend a backgrounded app, so its
// check-ins arrive when it reopens; reliable background alerts need Web Push sent from a server.
const showNotification = async (title: string, body: string) => {
    const options = { body, icon: '/icon-192.png' };
    const registration = await navigator.serviceWorker?.getRegistration();
    if (registration?.active) {
        await registration.showNotification(title, options);
    } else {
        new Notification(title, options);
    }
};

const CHECKIN_REPLIES = ['Going well', "I'm stuck", 'Done with this task'];
const WRAP_UP_REPLIES = ['It went great', 'Got distracted', 'Go another round'];

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
        stopTimer();
    }, []);
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
    const [showSettings, setShowSettings] = useState<boolean>(false);
    const closeSettings = useCallback(() => setShowSettings(false), []);

    // Prevent concurrent API calls
    const isGeneratingRef = useRef<boolean>(false);

    // Send a single check-in (used by both one-time and recurring), or the wrap-up when a timed session ends
    const sendCheckin = useCallback(async (timerTask: string, sessionEnded: boolean) => {
        if (isGeneratingRef.current) {
            return;
        }

        isGeneratingRef.current = true;

        try {
            const checkinMessage = await generateCheckinMessage(timerTask, sessionEnded);

            // Show browser notification if permission granted
            if (canNotify()) {
                showNotification(sessionEnded ? 'Focus session complete 🎉' : 'Daybreak check-in', checkinMessage)
                    .catch(() => { /* the check-in still lands in chat */ });
            }

            // Add message to chat
            const msgId = createChatMessageId();
            const msg: ChatMessage = {
                id: msgId,
                sender: 'ai',
                text: `${sessionEnded ? '🎉' : '🔔'} ${checkinMessage}`,
                quickReplies: sessionEnded ? WRAP_UP_REPLIES : CHECKIN_REPLIES,
            };
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

    const warnIfNotificationsOff = useCallback(() => {
        if ('Notification' in window && !canNotify()) {
            pushToast("Check-ins will show up here. Allow notifications to get them while you're in another tab.", 'info');
        }
    }, [pushToast]);

    const {
        activeTimer,
        timerRemainingSeconds,
        timerConfirmation,
        handleReminderConfig,
        confirmPendingTimerReplacement,
        keepCurrentTimer,
        stopTimer,
        pauseTimer,
        resumeTimer,
        snoozeTimer,
    } = useCheckinTimer({ onCheckin: sendCheckin, onStart: warnIfNotificationsOff });

    // Hold the midnight rollover while a timer is running so it can't wipe a live session
    const { sessionId, displayDate, sessionLoading } = useDailySession(user, handleSessionChange, activeTimer !== null);
    const sessionIdRef = useRef(sessionId);
    useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);

    // Keep userRef updated to avoid stale closures in worker callbacks
    useEffect(() => {
        userRef.current = user;
    }, [user]);

    // Finishing the current task hands focus to the next unfinished one.
    const currentSessionTask = useMemo(() => {
        const current = sessionTaskState.tasks.find(sessionTask => sessionTask.id === sessionTaskState.currentTaskId);
        return current?.done ? sessionTaskState.tasks.find(sessionTask => !sessionTask.done) ?? current : current ?? null;
    }, [sessionTaskState]);
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

    // Functional update, so it stacks on a task list applyTaskUpdate set in the same reply.
    const setTasksDone = (tasksToMark: SessionTask[], done: boolean) => {
        if (tasksToMark.length === 0) return;
        const ids = new Set(tasksToMark.map(sessionTask => sessionTask.id));
        setSessionTaskState(prev => ({
            ...prev,
            tasks: prev.tasks.map(sessionTask => ids.has(sessionTask.id) ? { ...sessionTask, done } : sessionTask),
        }));
        if (user) {
            tasksToMark.forEach(sessionTask => void dbService.saveTask(user.uid, sessionId, { ...sessionTask, done }));
        }
    };

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

    const getTaskActionStatusText = (taskUpdateResult: TaskUpdateResult, timerStarted: boolean, finishedCount: number, timerStopped: boolean) => {
        const actions: string[] = [];

        if (taskUpdateResult.shouldShowTaskList) {
            actions.push(taskUpdateResult.tasks.length === 1 ? 'Added task to task list' : 'Added tasks to task list');
        }

        if (finishedCount > 0) {
            actions.push(finishedCount === 1 ? 'Marked task done' : 'Marked tasks done');
        }

        if (timerStarted) {
            actions.push('Set timer');
        }

        if (timerStopped) {
            actions.push('Stopped check-ins');
        }

        return actions.join(' and ');
    };

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
                    saveLocalSettings(remoteSettings);
                } else {
                    await dbService.saveSettings(user.uid, loadLocalSettings());
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

    const sessionContext: SessionContext = {
        tasks: sessionTaskState.tasks.map(sessionTask => sessionTask.title),
        doneTasks: sessionTaskState.tasks.filter(sessionTask => sessionTask.done).map(sessionTask => sessionTask.title),
        currentTask: currentTaskTitle || null,
        timerActive: Boolean(activeTimer),
    };

    // Every request fails without a key, so send the user to Settings before sending anything.
    const ensureApiKey = () => {
        if (hasApiKey()) return true;
        pushToast('Add an API key in Settings to get started. Free-tier keys work!', 'info');
        setShowSettings(true);
        return false;
    };

    // Stream the assistant's reply, then record tasks and start any timer it asked for.
    const sendToAssistant = async (userText: string, history: ChatTurn[]) => {
        setIsLoading(true);
        setStreamingText('');
        setStreamingComplete(false);

        try {
            const { text, reminder, taskUpdate, completedTasks, stopReminder } = await streamReply(history, sessionContext, setStreamingText);

            // Mark streaming as complete (keeps showing last text until we add message)
            setStreamingComplete(true);

            // The user's words become the task only when there is none yet, so "check in every 10 min" isn't one.
            const taskUpdateResult = applyTaskUpdate(taskUpdate, userText, Boolean(reminder) && !currentSessionTask);
            const finishedTitles = new Set(completedTasks.map(normalizeTaskTitle));
            const finishedTasks = taskUpdateResult.tasks.filter(t => !t.done && finishedTitles.has(normalizeTaskTitle(t.title)));
            setTasksDone(finishedTasks, true);

            // A new reminder sent with the stop asks to replace the timer instead, like any timer change.
            const timerStopped = stopReminder && !reminder && activeTimer !== null;
            if (timerStopped) stopTimer();
            // Let AI decide the reminder configuration via tool calling
            const timerStarted = handleReminderConfig(reminder, taskUpdateResult.currentTitle || currentTaskTitle || userText);
            const actionStatusText = getTaskActionStatusText(taskUpdateResult, timerStarted, finishedTasks.length, timerStopped);

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
        requestNotificationPermission();
        setTask(newTask);

        // Immediately show the user's message before waiting for AI response
        const userMessage: ChatMessage = { id: createChatMessageId(), sender: 'user', text: newTask };
        setMessages([userMessage]);
        if (user) {
            void dbService.saveMessage(user.uid, sessionId, userMessage);
            void dbService.saveChatState(user.uid, sessionId, { task: newTask, currentTaskId: null });
        }

        await sendToAssistant(newTask, [{ role: 'user', content: newTask }]);
    };

    const handleSendMessage = async (userMessage: string) => {
        if (!userMessage.trim() || !task || !ensureApiKey()) return;
        requestNotificationPermission();

        const userMsg: ChatMessage = { id: createChatMessageId(), sender: 'user', text: userMessage };
        setMessages(prev => [...prev, userMsg]);
        if (user) {
            void dbService.saveMessage(user.uid, sessionId, userMsg);
        }

        await sendToAssistant(userMessage, toChatHistory([...messages, userMsg]));
    };

    return (
        <>
            <FocusShell
                onApiKeyClick={() => setShowSettings(true)}
                displayDate={displayDate}
                timerRemainingSeconds={timerRemainingSeconds}
                timerType={activeTimer?.type ?? null}
                timerPaused={activeTimer?.pausedMs !== undefined}
                onPauseTimer={pauseTimer}
                onResumeTimer={resumeTimer}
                onSnoozeTimer={snoozeTimer}
                onStopTimer={stopTimer}
                timerConfirmation={timerConfirmation}
                onConfirmTimerReplacement={confirmPendingTimerReplacement}
                onKeepCurrentTimer={keepCurrentTimer}
            >
                {task ? (
                    <ChatInterface
                        task={task}
                        currentTask={currentTaskTitle}
                        tasks={sessionTaskState.tasks}
                        onToggleTask={sessionTask => setTasksDone([sessionTask], !sessionTask.done)}
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

            {showSettings && <SettingsModal onClose={closeSettings} />}
        </>
    );
};

export default App;
