import React, { useEffect, useState } from 'react';
import type { ChatMessage, SessionTask } from '../types';
import { useAuth } from '../contexts/AuthContext';
import * as dbService from '../services/dbService';
import { formatSessionDate, getTodayDateString } from '../hooks/useDailySession';

interface HistoryModalProps {
    onClose: () => void;
}

interface PastDay {
    messages: ChatMessage[];
    tasks: SessionTask[];
}

const Note: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <p className="text-sm" style={{ color: 'var(--text-muted)' }}>{children}</p>
);

/** A read-only look back at earlier days' tasks and chats. */
const HistoryModal: React.FC<HistoryModalProps> = ({ onClose }) => {
    const { user } = useAuth();
    const [sessions, setSessions] = useState<dbService.SessionMeta[] | null>(null);
    const [selected, setSelected] = useState<dbService.SessionMeta | null>(null);
    const [day, setDay] = useState<PastDay | null>(null);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [onClose]);

    useEffect(() => {
        if (!user) return;
        const today = getTodayDateString();
        dbService.listSessions(user.uid)
            .then(all => setSessions(all.filter(session => session.date !== today)))
            .catch(error => {
                console.error('Error loading past days:', error);
                setSessions([]);
            });
    }, [user]);

    useEffect(() => {
        if (!user || !selected) return;
        let cancelled = false;
        setDay(null);
        Promise.all([dbService.loadMessages(user.uid, selected.sessionId), dbService.loadTasks(user.uid, selected.sessionId)])
            .then(([messages, tasks]) => { if (!cancelled) setDay({ messages, tasks }); })
            .catch(error => {
                console.error('Error loading day:', error);
                if (!cancelled) setDay({ messages: [], tasks: [] });
            });
        return () => { cancelled = true; };
    }, [user, selected]);

    let content: React.ReactNode;
    if (!selected) {
        content = sessions === null ? <Note>Loading…</Note>
            : sessions.length === 0 ? <Note>No past days yet. Each day shows up here once it's over.</Note>
            : (
                <ul className="flex flex-col gap-2">
                    {sessions.map(session => (
                        <li key={session.sessionId}>
                            <button
                                onClick={() => setSelected(session)}
                                className="w-full text-left p-3 rounded-xl transition-all"
                                style={{ backgroundColor: 'var(--bg-white)', border: '1px solid var(--border-light)' }}
                            >
                                <span className="block text-sm font-medium" style={{ color: 'var(--text-dark)' }}>
                                    {formatSessionDate(session.date)}
                                </span>
                                {session.task && (
                                    <span className="block text-xs truncate mt-0.5" style={{ color: 'var(--text-muted)' }}>
                                        {session.task}
                                    </span>
                                )}
                            </button>
                        </li>
                    ))}
                </ul>
            );
    } else if (!day) {
        content = <Note>Loading…</Note>;
    } else if (day.messages.length === 0 && day.tasks.length === 0) {
        content = <Note>Nothing was saved this day.</Note>;
    } else {
        content = (
            <>
                {day.tasks.length > 0 && (
                    <ul
                        className="flex flex-col gap-1.5 mb-4 p-3 rounded-xl border"
                        style={{ borderColor: 'var(--accent-pink)' }}
                        aria-label="Tasks"
                    >
                        {day.tasks.map(sessionTask => (
                            <li
                                key={sessionTask.id}
                                className="text-xs leading-snug flex items-start gap-2"
                                style={{ color: sessionTask.done ? 'var(--text-muted)' : 'var(--text-dark)' }}
                            >
                                <span aria-hidden="true">{sessionTask.done ? '✓' : '○'}</span>
                                <span className={sessionTask.done ? 'line-through' : ''}>{sessionTask.title}</span>
                                {sessionTask.done && <span className="sr-only">(done)</span>}
                            </li>
                        ))}
                    </ul>
                )}
                <ol className="flex flex-col gap-2" aria-label="Chat">
                    {day.messages.map((message, index) => (
                        <li
                            key={message.id ?? index}
                            className={`text-sm leading-relaxed px-3 py-2 rounded-xl ${message.sender === 'user' ? 'self-end' : 'self-start'}`}
                            style={{
                                maxWidth: '85%',
                                color: 'var(--text-dark)',
                                backgroundColor: message.sender === 'user' ? 'var(--accent-pink-light)' : 'var(--bg-white)',
                            }}
                        >
                            {message.text}
                        </li>
                    ))}
                </ol>
            </>
        );
    }

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
                aria-labelledby="history-modal-title"
                className="modal-panel custom-scrollbar rounded-2xl p-4 sm:p-6 max-w-md w-full mx-4 shadow-xl max-h-[90vh] overflow-y-auto"
                style={{
                    backgroundColor: 'var(--bg-warm)',
                    border: '1px solid var(--border-light)'
                }}
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center justify-between gap-3 mb-4">
                    <h2 id="history-modal-title" className="font-title text-2xl font-semibold" style={{ color: 'var(--text-dark)' }}>
                        {selected ? formatSessionDate(selected.date) : 'Past days'}
                    </h2>
                    <button
                        onClick={selected ? () => setSelected(null) : onClose}
                        className="px-3 py-1 text-sm rounded-full flex-shrink-0"
                        style={{ color: 'var(--text-muted)' }}
                    >
                        {selected ? '← All days' : 'Close'}
                    </button>
                </div>
                {content}
            </div>
        </div>
    );
};

export default HistoryModal;
