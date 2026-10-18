import assert from 'node:assert/strict';
import test from 'node:test';
import { extractReminderFromStaticToolCalls, toChatHistory } from './aiService.ts';

test('caps the check-in gap at the session length', () => {
    const reminder = extractReminderFromStaticToolCalls([
        { toolName: 'setReminder', input: { type: 'recurring', minutes: 10, sessionMinutes: 5, reason: 'short session' } },
    ]);
    assert.deepEqual(reminder, { type: 'recurring', minutes: 5, sessionMinutes: 5, reason: 'short session' });
});

test('keeps the model interval when the user gave a session length', () => {
    const reminder = extractReminderFromStaticToolCalls([
        { toolName: 'setReminder', input: { type: 'recurring', minutes: 20, sessionMinutes: 60, reason: '1 hour' } },
    ]);
    assert.equal(reminder?.minutes, 20);
    assert.equal(reminder?.sessionMinutes, 60);
});

test('leaves check-ins open-ended without a session length', () => {
    const reminder = extractReminderFromStaticToolCalls([
        { toolName: 'setReminder', input: { type: 'recurring', minutes: 15, reason: 'every 15' } },
    ]);
    assert.equal(reminder?.minutes, 15);
    assert.equal(reminder?.sessionMinutes, undefined);
});

test('builds model history from the visible chat', () => {
    const history = toChatHistory([
        { sender: 'ai', text: 'Good morning!' },
        { sender: 'user', text: 'essay for an hour' },
        { sender: 'ai', text: "Let's go!" },
        { sender: 'ai', text: '🔔 How is the essay going?' },
        { sender: 'user', text: 'good' },
    ]);
    assert.deepEqual(history, [
        { role: 'user', content: 'essay for an hour' },
        { role: 'assistant', content: "Let's go!\n\n🔔 How is the essay going?" },
        { role: 'user', content: 'good' },
    ]);
});
