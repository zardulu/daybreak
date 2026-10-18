import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReminderConfig } from '../services/aiService';

type TimerType = ReminderConfig['type'];

export const SNOOZE_MINUTES = 5;

interface ActiveTimer {
    type: TimerType;
    task: string;
    durationMs: number;
    endAt: number;
    /** Time left when paused; the countdown holds while it is set. */
    pausedMs?: number;
}

interface PendingTimerRequest {
    reminder: ReminderConfig;
    fallbackTask: string;
    currentTimer: {
        type: TimerType;
        task: string;
        remainingSeconds: number;
    };
}

interface CheckinTimerCallbacks {
    /** A check-in is due for this task. sessionEnded: it's the last one of a timed session. */
    onCheckin: (task: string, sessionEnded: boolean) => void;
    /** A timer just started. */
    onStart: () => void;
}

/**
 * One-time and recurring check-in timers, run in a Web Worker so they keep time in background tabs.
 * A new reminder while one is running waits for the user to confirm the replacement.
 */
export const useCheckinTimer = ({ onCheckin, onStart }: CheckinTimerCallbacks) => {
    const [activeTimer, setActiveTimer] = useState<ActiveTimer | null>(null);
    const [pendingTimerRequest, setPendingTimerRequest] = useState<PendingTimerRequest | null>(null);
    const [currentTime, setCurrentTime] = useState<number>(() => Date.now());
    const workerRef = useRef<Worker | null>(null);
    const timerTypeRef = useRef<TimerType | null>(null);
    const timerTaskRef = useRef<string>(''); // Keep active timer check-ins tied to their original task
    const checkinsLeftRef = useRef<number | null>(null); // Recurring check-ins left in the session; null = no end
    // The worker outlives renders, so it reaches the latest callbacks through a ref.
    const callbacksRef = useRef({ onCheckin, onStart });
    useEffect(() => {
        callbacksRef.current = { onCheckin, onStart };
    });

    // Refresh the visible countdown once per second while a timer is running.
    useEffect(() => {
        if (!activeTimer) return;

        const updateCurrentTime = () => setCurrentTime(Date.now());
        updateCurrentTime();
        const intervalId = window.setInterval(updateCurrentTime, 1000);

        return () => window.clearInterval(intervalId);
    }, [activeTimer]);

    const timerRemainingSeconds = activeTimer
        ? Math.max(0, Math.ceil((activeTimer.pausedMs ?? activeTimer.endAt - currentTime) / 1000))
        : null;

    const clearTimer = useCallback(() => {
        workerRef.current?.postMessage({ action: 'stop' });
        setActiveTimer(null);
        timerTypeRef.current = null;
        timerTaskRef.current = '';
        checkinsLeftRef.current = null;
    }, []);

    /** Stop the timer and drop any replacement waiting for confirmation. */
    const stopTimer = useCallback(() => {
        clearTimer();
        setPendingTimerRequest(null);
    }, [clearTimer]);

    // Start a one-time or recurring timer - using Web Worker for reliable background execution
    const startTimer = useCallback((reminder: ReminderConfig, fallbackTask: string) => {
        timerTaskRef.current = fallbackTask;
        timerTypeRef.current = reminder.type;
        callbacksRef.current.onStart();
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

        workerRef.current?.postMessage({ action: 'start', milliseconds, type: reminder.type });
    }, []);

    // The next check-in comes after delayMs; recurring timers then go back to their usual gap.
    const restartTimer = useCallback((timer: ActiveTimer, delayMs: number) => {
        setActiveTimer({ ...timer, endAt: Date.now() + delayMs, pausedMs: undefined });
        workerRef.current?.postMessage({ action: 'start', milliseconds: timer.durationMs, delay: delayMs, type: timer.type });
    }, []);

    const pauseTimer = useCallback(() => {
        if (!activeTimer || activeTimer.pausedMs !== undefined) return;
        workerRef.current?.postMessage({ action: 'stop' });
        setActiveTimer({ ...activeTimer, pausedMs: Math.max(0, activeTimer.endAt - Date.now()) });
    }, [activeTimer]);

    const resumeTimer = useCallback(() => {
        if (activeTimer?.pausedMs !== undefined) restartTimer(activeTimer, activeTimer.pausedMs);
    }, [activeTimer, restartTimer]);

    /** Push the next check-in back. A timed session runs that much longer. */
    const snoozeTimer = useCallback(() => {
        if (!activeTimer) return;
        const remainingMs = activeTimer.pausedMs ?? Math.max(0, activeTimer.endAt - Date.now());
        restartTimer(activeTimer, remainingMs + SNOOZE_MINUTES * 60 * 1000);
    }, [activeTimer, restartTimer]);

    // Initialize Web Worker and handle messages
    useEffect(() => {
        const worker = new Worker('/timer-worker.js');
        workerRef.current = worker;

        // Handle timer ticks from worker
        worker.onmessage = (e) => {
            if (e.data.type !== 'tick') return;

            const timerTask = timerTaskRef.current;
            if (checkinsLeftRef.current !== null) checkinsLeftRef.current -= 1;
            const sessionEnded = checkinsLeftRef.current === 0;

            if (timerTypeRef.current === 'one-time' || sessionEnded) {
                // Last check-in: one-time reminders fire once, sessions end when their time is up.
                clearTimer();
            } else if (timerTypeRef.current === 'recurring') {
                // The worker interval keeps running; move the UI deadline to
                // the next interval as soon as a check-in is triggered.
                setActiveTimer(previousTimer => previousTimer
                    ? { ...previousTimer, endAt: Date.now() + previousTimer.durationMs }
                    : previousTimer
                );
            }

            callbacksRef.current.onCheckin(timerTask, sessionEnded);
        };

        return () => {
            worker.postMessage({ action: 'stop' });
            worker.terminate();
        };
    }, [clearTimer]);

    // Handle reminder configuration from AI tool calls. Returns whether a timer started right away.
    const handleReminderConfig = useCallback((reminder: ReminderConfig | null, fallbackTask: string): boolean => {
        if (!reminder) {
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
    }, [activeTimer, startTimer, timerRemainingSeconds]);

    const confirmPendingTimerReplacement = useCallback(() => {
        if (!pendingTimerRequest) return;

        const { reminder, fallbackTask } = pendingTimerRequest;
        setPendingTimerRequest(null);
        startTimer(reminder, fallbackTask);
    }, [pendingTimerRequest, startTimer]);

    const keepCurrentTimer = useCallback(() => {
        setPendingTimerRequest(null);
    }, []);

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

    return {
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
    };
};
