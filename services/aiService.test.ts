import assert from 'node:assert/strict';
import test from 'node:test';
import { applyStatedDurations, autoReminder, extractReminderFromStaticToolCalls, streamAssistantReplyToUI, toChatHistory, type ReminderConfig } from './aiService.ts';

const recurring = (minutes: number, sessionMinutes?: number): ReminderConfig =>
    ({ type: 'recurring', minutes, sessionMinutes, reason: '' });

test('uses the session length the user typed when the model leaves it out', () => {
    // The model's (or the auto-injected) 25-minute default must not outlast a 5-minute session.
    const reminder = applyStatedDurations(recurring(25), 'focus for 5 minutes');
    assert.equal(reminder?.sessionMinutes, 5);
    assert.equal(reminder?.minutes, 5);
});

test('reads session lengths only from session phrasings', () => {
    const session = (text: string) => applyStatedDurations(recurring(20), text)?.sessionMinutes;
    assert.equal(session('study for 1 hour'), 60);
    assert.equal(session('work on it for the next hour'), 60);
    assert.equal(session('essay for an hour'), 60);
    assert.equal(session('about 45 minutes'), 45);
    assert.equal(session('I have 3 hours of homework'), undefined);
    assert.equal(session("I've been at it for hours"), undefined);
    assert.equal(session('remind me in 2 hours'), undefined);
});

test('an interval the user typed wins and the model session length is kept', () => {
    const reminder = applyStatedDurations(recurring(30, 180), 'I have 3 hours of homework, check in every 15 minutes');
    assert.equal(reminder?.minutes, 15);
    assert.equal(reminder?.sessionMinutes, 180);
});

test('caps the check-in gap at the session length', () => {
    assert.equal(applyStatedDurations(recurring(10, 5), '')?.minutes, 5);
});

const oneTime = (minutes: number): ReminderConfig => ({ type: 'one-time', minutes, reason: '' });

test('uses the reminder time the user typed over the model pick', () => {
    assert.equal(applyStatedDurations(oneTime(5), 'remind me in 2 minutes')?.minutes, 2);
    assert.equal(applyStatedDurations(oneTime(30), 'remind me after an hour')?.minutes, 60);
    assert.equal(applyStatedDurations(oneTime(1), 'ping me in 30 seconds')?.minutes, 0.5);
    // "for N" is a session length, not the reminder time
    assert.equal(applyStatedDurations(oneTime(10), 'remind me in 10 minutes, stretching for 5 minutes')?.minutes, 10);
    assert.equal(applyStatedDurations(oneTime(15), 'remind me to stretch')?.minutes, 15);
});

test('a forgotten "remind me in N" becomes a one-time reminder, not 25-minute check-ins', () => {
    assert.deepEqual(
        applyStatedDurations(autoReminder('remind me in 2 minutes to stretch'), 'remind me in 2 minutes to stretch'),
        { type: 'one-time', minutes: 2, reason: 'Auto-set: AI recorded tasks but did not set a reminder' }
    );
    assert.equal(autoReminder('focus for 5 minutes').type, 'recurring');
    assert.equal(autoReminder('finish my essay in 2 hours').type, 'recurring');
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

test('shows streamed text before the model finishes', async () => {
    let finish!: () => void;
    const modelDone = new Promise<void>(resolve => { finish = resolve; });
    async function* textStream() {
        yield 'Hello ';
        await modelDone;
        yield 'there';
    }
    const shown: string[] = [];
    const reply = streamAssistantReplyToUI({
        textStream: textStream(),
        text: Promise.resolve('Hello there'),
        response: Promise.resolve({ messages: [] }),
        staticToolCalls: Promise.resolve([]),
    }, text => shown.push(text), 'hi');

    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(shown, ['Hello ']);

    finish();
    assert.equal((await reply).text, 'Hello there');
    assert.equal(shown.at(-1), 'Hello there');
});
