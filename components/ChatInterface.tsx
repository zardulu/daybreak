import React, { useState, useEffect } from 'react';
import type { ChatMessage, SessionTask } from '../types';
import StreamingText from './StreamingText';

interface ChatInterfaceProps {
    task: string;
    currentTask: string;
    /** The live task list, shown with checkboxes on the latest turn. */
    tasks: SessionTask[];
    onToggleTask: (task: SessionTask) => void;
    messages: ChatMessage[];
    onSendMessage: (message: string) => void;
    isLoading: boolean;
    streamingText?: string;
    streamingComplete?: boolean;
}

const ChatInterface: React.FC<ChatInterfaceProps> = ({ task, currentTask, tasks, onToggleTask, messages, onSendMessage, isLoading, streamingText = '', streamingComplete = false }) => {
    const [inputMessage, setInputMessage] = useState('');
    const [viewOffset, setViewOffset] = useState(0); // 0 = latest, negative = older
    const [isTaskListOpen, setIsTaskListOpen] = useState(true);

    // Character limit for input
    const MAX_INPUT_CHARS = 280;

    // Group messages into turns: a user message plus the AI messages after it (reply, then check-ins).
    // AI messages before the first user message (e.g. the morning welcome) form their own turn.
    const turns: { user: ChatMessage | null; ai: ChatMessage[] }[] = [];
    for (const message of messages) {
        if (message.sender === 'user') {
            turns.push({ user: message, ai: [] });
        } else {
            if (turns.length === 0) turns.push({ user: null, ai: [] });
            turns[turns.length - 1].ai.push(message);
        }
    }
    const aiMessages = messages.filter(m => m.sender === 'ai');

    // Reset view to latest when new messages arrive
    useEffect(() => {
        setViewOffset(0);
    }, [messages.length]);

    const handleSendMessage = (e: React.FormEvent) => {
        e.preventDefault();
        if (inputMessage.trim() && !isLoading) {
            onSendMessage(inputMessage.trim());
            setInputMessage('');
        }
    };

    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const text = e.target.value;
        if (text.length <= MAX_INPUT_CHARS) {
            setInputMessage(text);
        }
    };

    const currentCharCount = inputMessage.length;

    // Navigate to earlier messages (scroll up = more negative offset)
    const scrollUp = () => {
        const maxOffset = -(turns.length - 1);
        setViewOffset(prev => Math.max(maxOffset, prev - 1));
    };

    // Navigate to later messages (scroll down = less negative offset)
    const scrollDown = () => {
        setViewOffset(prev => Math.min(0, prev + 1));
    };

    const canScrollUp = viewOffset > -(turns.length - 1);
    const canScrollDown = viewOffset < 0;

    const AISparkleIndicator = () => (
        <div className="sparkle-loading" aria-label="Focus Fairy is thinking" role="status">
            <span className="sparkle sparkle-large">✦</span>
            <span className="sparkle sparkle-small">✦</span>
            <span className="sparkle sparkle-medium">✦</span>
        </div>
    );

    // Calculate current turn index (0 = first turn, higher = later turns)
    // viewOffset 0 = latest turn, -1 = second to last, etc.
    const latestPairIndex = turns.length - 1;
    const currentPairIndex = Math.max(0, latestPairIndex + viewOffset);
    const currentTurn = turns[currentPairIndex];

    const hasUserMessages = turns.some(turn => turn.user);
    const userMessage = currentTurn?.user ?? null;

    // For AI messages: at the latest view (offset 0), always show the most recent AI message
    // This handles check-in messages that don't have a corresponding user message
    const isViewingLatest = viewOffset === 0;
    
    // Show typing indicator when waiting for AI response, but not when streaming
    const isStreaming = isLoading && streamingText.length > 0;
    const showStreamingText = isStreaming || streamingComplete;
    const showLiveAiText = isViewingLatest && showStreamingText;
    const waitingForLatestAiResponse = isLoading && isViewingLatest && !showLiveAiText;
    
    // Get AI message - but while waiting/streaming on latest view, hide the previous AI turn immediately.
    const aiMessage = showLiveAiText || waitingForLatestAiResponse
        ? null
        : isViewingLatest
            ? aiMessages[aiMessages.length - 1] || null
            : currentTurn?.ai[0] || null; // Older turns show the reply itself, not later check-ins

    const displayedAiText = showLiveAiText
        ? streamingText
        : aiMessage?.text || "Hi! I'm here to help you stay focused ✨ Tell me what you're working on, and I'll guide you through it step by step.";

    const showStreamParticles =
        isLoading && streamingText.length > 0 && !streamingComplete;
    const displayedCurrentTask = currentTask || task;
    // The latest turn shows the live list so tasks can be ticked off; older turns show the list as it was then.
    const taskListForMessage = isViewingLatest ? tasks : aiMessage?.taskListSnapshot || [];
    const currentTaskForMessage = isViewingLatest ? displayedCurrentTask : aiMessage?.currentTaskSnapshot || displayedCurrentTask;
    const showTaskListForMessage = isViewingLatest
        ? tasks.length > 0
        : Boolean(aiMessage?.showTaskList && taskListForMessage.length > 0);
    const doneCount = taskListForMessage.filter(sessionTask => sessionTask.done).length;
    // Answers to the newest message only, until the user replies.
    const quickReplies = isViewingLatest && !isLoading && aiMessage && aiMessage === messages[messages.length - 1]
        ? aiMessage.quickReplies ?? []
        : [];
    const showTaskActionStatus = Boolean(aiMessage?.showTaskActionStatus && !showLiveAiText);
    const taskActionStatusText = aiMessage?.taskActionStatusText || 'Updated';

    return (
        <div className="focus-stage chat-focus-stage w-full">
            <div className="chat-view-wrapper w-full mb-0">
                    <div className="chat-pair-container">
                        {/* User Message at Top - plain text, slides up */}
                        {userMessage ? (
                            <div className="user-message-row">
                                <p
                                    className="user-message-text animate-slideUp custom-scrollbar"
                                    key={`user-${currentPairIndex}`}
                                >
                                    {userMessage.text}
                                </p>
                            </div>
                        ) : null}

                        {/* AI Message at Bottom - with fairy and bubble */}
                        <div className="ai-message-row gap-0 sm:gap-0">
                            <div className={`fairy-container animate-float flex-shrink-0${isLoading ? ' fairy-thinking' : ''}`}>
                                <img src="/fairy.svg" alt="Focus Fairy" />
                            </div>
                            {waitingForLatestAiResponse ? (
                                <div className="sparkle-loading-wrapper animate-fadeIn flex-1 min-w-0">
                                    <AISparkleIndicator />
                                </div>
                            ) : (
                                <div className="speech-bubble-ai animate-fadeIn custom-scrollbar flex-1 min-w-0">
                                    <StreamingText
                                        text={displayedAiText}
                                        particlesActive={showStreamParticles && showLiveAiText}
                                        className="text-sm leading-relaxed"
                                        style={{ color: 'var(--text-dark)' }}
                                    />
                                </div>
                            )}
                        </div>

                        {quickReplies.length > 0 ? (
                            <div className="task-list-container quick-replies animate-fadeIn" role="group" aria-label="Quick replies">
                                {quickReplies.map(reply => (
                                    <button key={reply} type="button" className="quick-reply" onClick={() => onSendMessage(reply)}>
                                        {reply}
                                    </button>
                                ))}
                            </div>
                        ) : null}

                        {showTaskActionStatus ? (
                            <section
                                className="task-list-container w-full animate-fadeIn"
                                aria-label="Task and timer status"
                            >
                                <div className="task-action-status">
                                    <span className="task-action-status-check" aria-hidden="true">✓</span>
                                    <span>{taskActionStatusText}</span>
                                </div>
                            </section>
                        ) : null}

                        {showTaskListForMessage ? (
                            <section
                                className="task-list-container w-full animate-fadeIn"
                                aria-label="Current session tasks"
                            >
                                <div
                                    className="task-list-panel rounded-xl px-3 py-2 border"
                                    style={{
                                        borderColor: 'var(--accent-pink)',
                                        backgroundColor: 'var(--bg-warm)'
                                    }}
                                >
                                    <button
                                        type="button"
                                        className="w-full flex items-center justify-between gap-3 text-left"
                                        onClick={() => setIsTaskListOpen(prev => !prev)}
                                        aria-expanded={isTaskListOpen}
                                        aria-controls="session-task-list"
                                    >
                                        <span className="text-xs leading-snug" style={{ color: 'var(--text-muted)' }}>
                                            Current: <span className="font-medium" style={{ color: 'var(--text-dark)' }}>{currentTaskForMessage}</span>
                                        </span>
                                        <span className="text-xs flex-shrink-0 flex items-center gap-1" style={{ color: 'var(--text-muted)' }}>
                                            {doneCount > 0
                                                ? `${doneCount}/${taskListForMessage.length} done`
                                                : `${taskListForMessage.length} task${taskListForMessage.length === 1 ? '' : 's'}`}
                                            <svg
                                                className={`task-list-chevron${isTaskListOpen ? '' : ' task-list-chevron-closed'}`}
                                                width="10"
                                                height="7"
                                                viewBox="0 0 12 8"
                                                fill="none"
                                                xmlns="http://www.w3.org/2000/svg"
                                                aria-hidden="true"
                                            >
                                                <path d="M1 6L6 1L11 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                                            </svg>
                                        </span>
                                    </button>
                                    <div
                                        id="session-task-list"
                                        hidden={!isTaskListOpen}
                                    >
                                        <ul className="flex flex-col gap-1.5 mt-2 pt-2 border-t" style={{ borderColor: 'var(--accent-pink)' }}>
                                            {taskListForMessage.map(sessionTask => {
                                                const isCurrent = sessionTask.title === currentTaskForMessage && !sessionTask.done;

                                                return (
                                                    <li key={sessionTask.id} title={sessionTask.title}>
                                                        <label
                                                            className="text-xs leading-snug flex items-start gap-2"
                                                            style={{ color: isCurrent ? 'var(--text-dark)' : 'var(--text-muted)' }}
                                                        >
                                                            {isViewingLatest ? (
                                                                <input
                                                                    type="checkbox"
                                                                    className="task-checkbox"
                                                                    checked={Boolean(sessionTask.done)}
                                                                    onChange={() => onToggleTask(sessionTask)}
                                                                />
                                                            ) : (
                                                                <span aria-hidden="true" className="mt-0.5">
                                                                    {isCurrent ? '•' : '○'}
                                                                </span>
                                                            )}
                                                            <span className={sessionTask.done ? 'line-through' : isCurrent ? 'font-medium' : ''}>
                                                                {sessionTask.title}
                                                            </span>
                                                        </label>
                                                    </li>
                                                );
                                            })}
                                        </ul>
                                    </div>
                                </div>
                            </section>
                        ) : null}

                    </div>

                    {/* Navigation arrows - fixed position */}
                    {hasUserMessages ? (
                        <div className="nav-arrows">
                            <button
                                onClick={scrollUp}
                                className="nav-arrow"
                                aria-label="Show earlier messages"
                                disabled={!canScrollUp}
                                style={{ opacity: canScrollUp ? 1 : 0.3, cursor: canScrollUp ? 'pointer' : 'default' }}
                            >
                                <svg width="12" height="8" viewBox="0 0 12 8" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M1 6L6 1L11 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                                </svg>
                            </button>
                            <button
                                onClick={scrollDown}
                                className="nav-arrow"
                                aria-label="Show later messages"
                                disabled={!canScrollDown}
                                style={{ opacity: canScrollDown ? 1 : 0.3, cursor: canScrollDown ? 'pointer' : 'default' }}
                            >
                                <svg width="12" height="8" viewBox="0 0 12 8" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M1 2L6 7L11 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                                </svg>
                            </button>
                        </div>
                    ) : null}
                </div>

                <div className="w-full input-form-container">
                    <form
                        onSubmit={handleSendMessage}
                        className="flex items-center gap-2 sm:gap-3 w-full"
                    >
                        <input
                            type="text"
                            value={inputMessage}
                            onChange={handleInputChange}
                            placeholder="Reply to your fairy…"
                            className="input-field flex-1"
                            disabled={isLoading}
                        />
                        <button
                            type="submit"
                            className="btn-send"
                            disabled={isLoading || !inputMessage.trim()}
                        >
                            {isLoading ? (
                                <div
                                    className="w-4 h-4 border-2 border-t-transparent rounded-full animate-spin"
                                    style={{ borderColor: 'var(--text-dark)', borderTopColor: 'transparent' }}
                                />
                            ) : (
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M5 12H19M19 12L12 5M19 12L12 19" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                                </svg>
                            )}
                        </button>
                    </form>
                    <p
                        className={`char-counter text-xs mt-1 text-right${currentCharCount >= MAX_INPUT_CHARS * 0.9 ? ' char-counter-warn' : ''}`}
                        style={{ opacity: inputMessage ? 1 : 0 }}
                    >
                        {currentCharCount}/{MAX_INPUT_CHARS}
                    </p>
                </div>
        </div>
    );
};

export default ChatInterface;
