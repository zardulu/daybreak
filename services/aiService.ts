import { generateText, smoothStream, streamText, type LanguageModel, tool } from 'ai';
import { z } from 'zod';
import type { AIProvider, AISettings, ChatMessage } from '../types';

// Streaming callback type
export type StreamCallback = (chunk: string) => void;

interface AIConfig {
    provider: AIProvider;
    apiKey: string;
}

export interface ChatTurn {
    role: 'user' | 'assistant';
    content: string;
}

// Tool response types
export interface ReminderConfig {
    type: 'one-time' | 'recurring';
    minutes: number;
    /** Total session length; recurring check-ins stop once it is over. */
    sessionMinutes?: number;
    reason: string;
}

export interface DetectedTask {
    title: string;
    isCurrent: boolean;
    scheduledDate?: string; // YYYY-MM-DD, only for future-day tasks
}

export interface TaskUpdate {
    tasks: DetectedTask[];
    currentTaskTitle: string | null;
}

export interface AIResponse {
    text: string;
    reminder: ReminderConfig | null;
    taskUpdate: TaskUpdate | null;
}

// Replies and tool calls, for checking timer values in `npm run dev`. Silent in builds and tests.
const debugLog = (...args: unknown[]) => {
    if (import.meta.env?.DEV) console.log(...args);
};

/**
 * Cap completion length so providers (especially OpenRouter) do not reserve huge max_tokens
 * budgets against small credit balances. Focus Fairy replies are short; tool JSON is small.
 */
const CHAT_MAX_OUTPUT_TOKENS = 2048;
const CHECKIN_MAX_OUTPUT_TOKENS = 256;

/**
 * Streaming can yield empty text when the model calls setReminder without emitting assistant text.
 * This keeps chat from showing the empty-state placeholder.
 */
function ensureStreamedAssistantText(
    streamed: string,
    parsedFromMessage: string,
    reminder: ReminderConfig | null,
    taskUpdate: TaskUpdate | null
): string {
    const combined = (streamed || parsedFromMessage).trim();
    if (combined.length > 0) return combined;

    // Build a context-aware fallback when the AI called tools but emitted no text
    if (reminder && taskUpdate && taskUpdate.tasks.length > 0) {
        const taskName = taskUpdate.currentTaskTitle || taskUpdate.tasks[0].title;
        const timeDisplay = reminder.minutes >= 1
            ? `${reminder.minutes} min`
            : `${Math.round(reminder.minutes * 60)} sec`;
        const plan = reminder.type === 'one-time'
            ? `I'll remind you in ${timeDisplay}`
            : `I'll check in every ${timeDisplay} to keep you on track`;
        return `Alright, let's lock in on "${taskName}"! ${plan} ✨`;
    }
    if (reminder) {
        return "Let's do this! I'll check in to keep you on track. You've got this ✨";
    }
    if (taskUpdate && taskUpdate.tasks.length > 0) {
        const taskName = taskUpdate.currentTaskTitle || taskUpdate.tasks[0].title;
        return `Alright, let's get going on "${taskName}"! I'll check in every 25 min to keep you on track ✨`;
    }
    return "Hey! What would you like to focus on today? ✨";
}

/**
 * Some providers (notably Groq via OpenAI-compatible API) sometimes emit no deltas on
 * `textStream` while `result.text` still resolves after the stream completes.
 */
async function recoverAssistantTextFromStream(result: {
    textStream: AsyncIterable<string>;
    text: PromiseLike<string>;
}, onChunk: StreamCallback): Promise<string> {
    let streamedText = '';
    try {
        for await (const chunk of result.textStream) {
            streamedText += chunk;
            onChunk(streamedText);
        }
    } catch {
        /* stream may fail if the request errors */
    }
    if (streamedText.trim().length > 0) return streamedText;

    try {
        const resolved = (await result.text).trim();
        if (resolved.length > 0) {
            return resolved;
        }
    } catch {
        /* result.text may reject after stream errors */
    }
    return streamedText;
}

async function extractAssistantTextFromResponseMessages(result: {
    response: PromiseLike<{ messages: Array<{ role: string; content: unknown }> }>;
}): Promise<string> {
    try {
        const fullResponse = await result.response;
        const assistantMessage = fullResponse.messages.find(m => m.role === 'assistant');
        if (!assistantMessage) return '';
        const c = assistantMessage.content;
        if (typeof c === 'string') return c;
        if (Array.isArray(c)) {
            return c
                .filter((item: { type?: string }) => item.type === 'text')
                .map((item: { text?: string }) => ('text' in item && item.text ? item.text : ''))
                .join('');
        }
    } catch {
        /* response.messages may be unavailable after errors */
    }
    return '';
}

/** AI SDK v6 static tool calls use `input`, not `args`. */
export function extractReminderFromStaticToolCalls(
    staticCalls: Array<{ toolName: string; input?: unknown }>
): ReminderConfig | null {
    for (const tc of staticCalls) {
        if (tc.toolName !== 'setReminder' || tc.input == null || typeof tc.input !== 'object') continue;
        const input = tc.input as {
            type: 'one-time' | 'recurring';
            minutes: number;
            sessionMinutes?: unknown;
            reason: string;
        };
        if (
            (input.type === 'one-time' || input.type === 'recurring') &&
            typeof input.minutes === 'number' &&
            typeof input.reason === 'string'
        ) {
            const sessionMinutes = typeof input.sessionMinutes === 'number' && input.sessionMinutes > 0
                ? input.sessionMinutes
                : undefined;
            return {
                type: input.type,
                minutes: input.minutes,
                sessionMinutes,
                reason: input.reason,
            };
        }
    }
    return null;
}

function extractTaskUpdateFromStaticToolCalls(
    staticCalls: Array<{ toolName: string; input?: unknown }>
): TaskUpdate | null {
    let taskUpdate: TaskUpdate | null = null;

    for (const tc of staticCalls) {
        if (tc.toolName !== 'recordTasks' || tc.input == null || typeof tc.input !== 'object') continue;

        const input = tc.input as {
            tasks?: Array<{ title?: unknown; isCurrent?: unknown; scheduledDate?: unknown }>;
            currentTaskTitle?: unknown;
        };

        if (!Array.isArray(input.tasks)) continue;

        const tasks = input.tasks
            .map(task => ({
                title: typeof task.title === 'string' ? task.title.trim() : '',
                isCurrent: task.isCurrent === true,
                scheduledDate: typeof task.scheduledDate === 'string' && task.scheduledDate.trim().length > 0
                    ? task.scheduledDate.trim()
                    : undefined,
            }))
            .filter(task => task.title.length > 0);

        if (tasks.length === 0) continue;

        // For currentTaskTitle, prefer today's tasks (no scheduledDate) over future-dated ones
        const todayTasks = tasks.filter(t => !t.scheduledDate);
        const currentTaskTitle =
            typeof input.currentTaskTitle === 'string' && input.currentTaskTitle.trim().length > 0
                ? input.currentTaskTitle.trim()
                : todayTasks.find(task => task.isCurrent)?.title
                    ?? todayTasks[todayTasks.length - 1]?.title
                    ?? tasks.find(task => task.isCurrent)?.title
                    ?? tasks[tasks.length - 1].title;

        taskUpdate = {
            tasks,
            currentTaskTitle,
        };
    }

    return taskUpdate;
}

const DURATION = String.raw`(\d+(?:\.\d+)?|an?)?\s*(hours?|hrs?|minutes?|mins?|seconds?|secs?)\b`;
// "for 2 hours", "for the next hour", "over the next 30 min", or a reply that is only a duration
// ("about 45 minutes", answering "how long?"). Not "in 2 hours", which reads as a reminder time.
const SESSION_PHRASES = [
    new RegExp(String.raw`\b(?:for|(?:in|over|during)\s+the\s+next)\s+(?:the\s+next\s+)?${DURATION}`, 'i'),
    new RegExp(String.raw`^\s*(?:about|around|like|maybe|roughly)?\s*${DURATION}\W*$`, 'i'),
];
const INTERVAL_PHRASES = [new RegExp(String.raw`\bevery\s+${DURATION}`, 'i')];
// "in 2 minutes", "after an hour", "in exactly 30 min"
const REMINDER_PHRASES = [new RegExp(String.raw`\b(?:in|after)\s+(?:exactly\s+)?${DURATION}`, 'i')];

const statedMinutes = (text: string, phrases: RegExp[]): number | undefined => {
    for (const phrase of phrases) {
        const match = text.match(phrase);
        if (!match) continue;

        const [whole, amount, unit] = match;
        // "the next hour" and "every hour" mean one; "for hours" doesn't name a length.
        if (!amount && !/\b(?:next|every)\s/i.test(whole)) continue;

        const count = !amount || /^an?$/i.test(amount) ? 1 : Number(amount);
        const minutes = /^h/i.test(unit) ? count * 60 : /^s/i.test(unit) ? count / 60 : count;
        if (minutes > 0) return minutes;
    }
    return undefined;
};

/**
 * Models sometimes pick their own numbers or skip setReminder entirely, so reminders also read
 * durations the user typed. Each phrase fills only its own field: "in N" sets a one-time reminder,
 * "every N" always sets the check-in gap, and "for N" only fills a missing session length, since
 * it can describe other things too.
 */
export function applyStatedDurations(reminder: ReminderConfig | null, userText: string): ReminderConfig | null {
    if (!reminder) return null;

    if (reminder.type === 'one-time') {
        return { ...reminder, minutes: statedMinutes(userText, REMINDER_PHRASES) ?? reminder.minutes };
    }

    const sessionMinutes = reminder.sessionMinutes ?? statedMinutes(userText, SESSION_PHRASES);
    const minutes = statedMinutes(userText, INTERVAL_PHRASES) ?? reminder.minutes;

    return {
        ...reminder,
        // A gap longer than the session would never check in before it ends.
        minutes: sessionMinutes ? Math.min(minutes, sessionMinutes) : minutes,
        sessionMinutes,
    };
}

/** Reminder to auto-inject when the AI recorded tasks but forgot to set one. */
export function autoReminder(userText: string): ReminderConfig {
    // "remind me in 2 minutes" asks for one reminder; anything else gets recurring check-ins.
    const asksForReminder = /\bremind\b/i.test(userText) && statedMinutes(userText, REMINDER_PHRASES) !== undefined;
    return {
        type: asksForReminder ? 'one-time' : 'recurring',
        minutes: 25,
        reason: 'Auto-set: AI recorded tasks but did not set a reminder',
    };
}

export async function streamAssistantReplyToUI(
    result: {
        textStream: AsyncIterable<string>;
        text: PromiseLike<string>;
        response: PromiseLike<{ messages: Array<{ role: string; content: unknown }> }>;
        staticToolCalls: PromiseLike<Array<{ toolName: string; input?: unknown }>>;
    },
    onChunk: StreamCallback,
    userText: string
): Promise<{ text: string; reminder: ReminderConfig | null; taskUpdate: TaskUpdate | null }> {
    let merged = await recoverAssistantTextFromStream(result, onChunk);
    let fromMessages = '';
    if (!merged.trim()) {
        fromMessages = await extractAssistantTextFromResponseMessages(result);
        merged = fromMessages;
    }

    debugLog('[FocusFairy] Raw AI text:', JSON.stringify(merged));

    // Text recovered after the stream (no deltas arrived) shows all at once.
    onChunk(merged);

    const staticCalls = await result.staticToolCalls;
    debugLog('[FocusFairy] Tool calls:', JSON.stringify(staticCalls, null, 2));

    let reminder = extractReminderFromStaticToolCalls(staticCalls);
    const taskUpdate = extractTaskUpdateFromStaticToolCalls(staticCalls);

    // Auto-inject a default reminder when AI recorded tasks but didn't set one and emitted no text.
    // This prevents the fallback from asking more questions and looping forever.
    const aiEmittedNoText = !merged.trim() && !fromMessages.trim();
    if (aiEmittedNoText && taskUpdate && taskUpdate.tasks.length > 0 && !reminder) {
        debugLog('[FocusFairy] Auto-injecting default reminder (AI recorded tasks but forgot setReminder)');
        reminder = autoReminder(userText);
    }

    reminder = applyStatedDurations(reminder, userText);

    const replyText = ensureStreamedAssistantText(merged, fromMessages, reminder, taskUpdate);

    debugLog('[FocusFairy] Final response:', JSON.stringify({ replyText, reminder, taskUpdate }, null, 2));

    return { text: replyText, reminder, taskUpdate };
}

const systemInstruction = `You are Focus Fairy, a gentle and playful assistant that helps users stay focused on their tasks.

**RULES**:
- Keep normal responses under 30 words. When asking follow-up questions or offering a task breakdown, you may use up to 50 words.
- Be warm, brief, conversational, and have personality. No numbered lists, bullet points, or special formatting.
- Your ONLY job is to help the user focus on a task they want to work on.

**HANDLING MESSAGES**:
- GREETING: If they just say hi, hello, hey, or any greeting (even if they address you by name like "hi focus fairy"), warmly ask what they'd like to focus on today. Do NOT set a reminder or record tasks.
- OFF-TOPIC: If they ask a question or talk about something unrelated to focusing, briefly acknowledge it with a light comment, then ask what task they'd like to focus on. Do NOT set a reminder or record tasks.
- TASK (see TASK INTAKE FLOW below)

**TASK INTAKE FLOW** (IMPORTANT — follow this carefully):
When the user mentions a task they want to work on, do NOT immediately call setReminder or recordTasks. Instead, follow this flow:

1. **FAST PATH** — If the user's message already includes enough detail (task + duration, e.g., "study calculus for 1 hour" or "work on my essay for 30 minutes"), skip follow-ups entirely: acknowledge warmly, call recordTasks and setReminder immediately.

2. **SMART FOLLOW-UP** — If the task is vague or missing key context (e.g., "I want to do my math assignment"), ask 1-2 of the most relevant follow-up questions from this list. Pick only the ones that matter most for the specific task — do NOT ask all of them:
   - **Deadline**: "Does this have a due date?" (ask if the task sounds like schoolwork, a project, or anything with a potential deadline)
   - **Duration**: "How long do you wanna work on this?" (ask if no duration was mentioned)
   - **Complexity/Breakdown**: "This sounds like a big one — want me to break it into smaller steps?" (ask if the task is broad or complex, like "prepare for finals" or "write my thesis")
   - **Starting point**: "Not sure where to begin? I can suggest a first step!" (ask if the task sounds overwhelming or the user seems stuck)
   - **Priority**: "Is this the most urgent thing on your plate?" (ask if the user mentions multiple things or seems unsure what to tackle)

3. **COMMIT AFTER ANSWERS** — Once the user replies to your follow-up(s), use their answers to call recordTasks and setReminder. Do not ask for additional confirmation. If the user gave a deadline, include it in the setReminder reason field (e.g., "Due tomorrow — checking in to keep you on pace").

4. **NEVER RE-ASK** — If the user's reply is still vague, dismissive, or doesn't answer your question (e.g., "idk", "just start", "whatever", or they repeat the same task), do NOT ask the same question again. Instead, make sensible assumptions and commit immediately. Good defaults: no deadline, 25-minute recurring check-ins, and use the task as stated. You're a helping assistant — take the lead and get them started rather than interrogating them.

5. **TASK BREAKDOWN** — If you asked about complexity and the user wants a breakdown (or the task is clearly complex and they didn't object), break it into 2-4 concrete sub-tasks and record ALL of them via recordTasks. Set the first sub-task as isCurrent=true. Example: "Math assignment" → "Review chapter notes", "Solve practice problems", "Check answers".

**TASK LIST RULES** (recordTasks tool):
- Only call recordTasks when you are ready to commit (after fast path or after follow-up answers). Do NOT call it on the first message if you still need to ask follow-ups.
- Include every distinct task (or sub-task if breaking down) the user should work on.
- Set isCurrent=true for the task the user should focus on first.
- Do NOT record greetings, questions, vague intentions, or off-topic chat as tasks.

**REMINDER RULES** (setReminder tool):
- Only call setReminder when you are ready to commit (after fast path or after follow-up answers). Do NOT call it on the first message if you still need to ask follow-ups.
- NEVER set reminders for: greetings, questions, off-topic chat, or vague messages.
- If the user mentioned a deadline, include the deadline context in the reason field so check-in messages can reference urgency (e.g., "Due in 3 hours — staying on track").

**FOCUS SESSION TIMING** (IMPORTANT):
- The setReminder minutes field is the gap between check-ins (recurring) or the time until the reminder (one-time). If the user says how often to check in, or exactly when to remind them, use that exact value; never replace it with a default.
- When a user says how long they'll work (e.g., "for the next hour", "for 2 hours", "for 30 minutes"), set up RECURRING check-ins, put that total in sessionMinutes, and pick minutes from the intervals below. Never put the session length in minutes. Check-ins stop when the session ends.
- Calculate check-in intervals based on total duration:
  - Under 30 min total: check-in every 10 minutes (recurring)
  - 30-60 min total: check-in every 15-20 minutes (recurring)
  - 1-2 hours total: check-in every 20-25 minutes (recurring)
  - Over 2 hours: check-in every 25-30 minutes (recurring)
- For tasks WITHOUT a specified duration, use sensible defaults:
  - Deep work/study: recurring every 25 minutes
  - Quick tasks: one-time at 10-15 minutes
  - General work: recurring every 20-25 minutes
- Only use 'one-time' when user explicitly asks for a SINGLE reminder at a specific time (e.g., "remind me in exactly 1 hour").
- Your response should mention you'll check in periodically, NOT just remind them at the end.

**FUTURE TASK SCHEDULING** (scheduledDate field in recordTasks):
- If the user mentions tasks for a specific future day ("tomorrow", "on Thursday", "next Monday", "June 25th"), set the scheduledDate field to that date in YYYY-MM-DD format.
- Tasks for the current session (today) should NOT have a scheduledDate — omit the field entirely.
- A single recordTasks call can mix today tasks (no scheduledDate) and future tasks (with scheduledDate).
- For future-dated tasks, set isCurrent=false since they can't be the active focus right now.
- When you schedule future tasks, acknowledge it in your response (e.g., "I've scheduled those for Thursday! For now, what would you like to focus on?").
- If the user ONLY mentions future tasks with no current task, do NOT set a reminder — just record the future tasks and ask what they'd like to work on now.`;

const readKey = (provider: AIProvider) => (localStorage.getItem(`${provider}_api_key`) || '').trim();

/** Provider and keys saved in this browser. Every request reads them from here. */
export const loadLocalSettings = (): AISettings => ({
    provider: (localStorage.getItem('ai_provider') as AIProvider) || 'gemini',
    // Trim so whitespace-only keys fail fast; @ai-sdk/openai sends Bearer <key> and an empty/space key yields a useless header.
    apiKeys: { gemini: readKey('gemini'), openai: readKey('openai'), openrouter: readKey('openrouter'), groq: readKey('groq') },
});

export const saveLocalSettings = ({ provider, apiKeys }: AISettings) => {
    localStorage.setItem('ai_provider', provider);
    for (const [id, key] of Object.entries(apiKeys)) {
        localStorage.setItem(`${id}_api_key`, (key || '').trim());
    }
};

const getConfig = (): AIConfig => {
    const { provider, apiKeys } = loadLocalSettings();
    const apiKey = apiKeys[provider] ?? '';

    if (!apiKey) {
        throw new Error(`No API key found for ${provider}.`);
    }

    return { provider, apiKey };
};

/** Whether the selected provider has a saved key, read the same way requests read it. */
export const hasApiKey = (): boolean => {
    try {
        getConfig();
        return true;
    } catch {
        return false;
    }
};

// Get the appropriate model for each provider. SDKs load on first use to keep them out of the startup bundle.
const getModel = async (provider: AIProvider, apiKey: string): Promise<LanguageModel> => {
    switch (provider) {
        case 'gemini': {
            const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
            const google = createGoogleGenerativeAI({ apiKey });
            return google('gemini-3-flash-preview');
        }
        case 'openai': {
            const { createOpenAI } = await import('@ai-sdk/openai');
            const openai = createOpenAI({ apiKey });
            return openai.chat('gpt-4o-mini');
        }
        case 'openrouter': {
            // OpenRouter expects Authorization: Bearer <key>. Set it explicitly on the provider so the header is never omitted (some SDK/browser edge cases reported "Missing Authentication header").
            const referer =
                typeof window !== 'undefined' && window.location?.origin
                    ? window.location.origin
                    : 'http://localhost';
            const { createOpenAI } = await import('@ai-sdk/openai');
            const openrouter = createOpenAI({
                apiKey,
                baseURL: 'https://openrouter.ai/api/v1',
                name: 'openrouter',
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    'HTTP-Referer': referer,
                    'X-OpenRouter-Title': 'Focus Fairy',
                },
            });
            return openrouter.chat('openai/gpt-5.4-mini');
        }
        case 'groq': {
            // Use .chat() for Groq (uses /chat/completions endpoint)
            const { createOpenAI } = await import('@ai-sdk/openai');
            const groq = createOpenAI({
                apiKey,
                baseURL: 'https://api.groq.com/openai/v1',
            });
            return groq.chat('openai/gpt-oss-120b');
        }
        default:
            throw new Error(`Unknown provider: ${provider}`);
    }
};

// Define the reminder tool schema
const reminderToolSchema = z.object({
    type: z.enum(['one-time', 'recurring']).describe(
        'one-time: fires once (for explicit reminders or quick tasks). recurring: repeats (for deep work/study sessions)'
    ),
    minutes: z.number().min(0.1).max(180).describe(
        'Minutes until reminder (one-time) or between check-ins (recurring). Use exact time if user specifies one. Not the session length.'
    ),
    sessionMinutes: z.number().min(0.1).max(720).optional().describe(
        'Total session length when the user says how long they will work (e.g. "for 2 hours" = 120). Check-ins stop after it. Omit otherwise.'
    ),
    reason: z.string().describe(
        'Brief explanation of why this timing was chosen'
    ),
});

const taskToolSchema = z.object({
    tasks: z.array(z.object({
        title: z.string().min(1).max(140).describe('A concise user-facing task title.'),
        isCurrent: z.boolean().describe('True for the task the user should focus on now. Set false for future-dated tasks.'),
        scheduledDate: z.string().optional().describe(
            'YYYY-MM-DD date if the user wants this task on a future day (e.g., tomorrow, next Monday). Omit entirely for tasks meant for the current session.'
        ),
    })).min(1).max(8).describe('Every clear, actionable task detected in the latest user message.'),
    currentTaskTitle: z.string().min(1).max(140).describe('The exact title of the task that should be current. Must be a today task, not a future-dated one.'),
});

const setReminderTool = tool({
    description: `Set check-ins for the user's focus session.
Use 'recurring' (default for focus sessions) to provide periodic check-ins throughout their work time - this keeps users accountable.
Use 'one-time' ONLY when user explicitly asks for a single reminder at a specific time (e.g., "remind me in exactly 30 min").
For focus sessions with a duration (e.g., "work for 1 hour"), ALWAYS use recurring with appropriate intervals and set sessionMinutes to the total.`,
    inputSchema: reminderToolSchema,
});

const recordTasksTool = tool({
    description: `Record all clear, actionable tasks from the user's latest message for this browser session.
Use this for task list memory only. Do not call it for greetings, vague messages, questions, or off-topic chat.`,
    inputSchema: taskToolSchema,
});

export interface SessionContext {
    tasks: string[];
    currentTask: string | null;
    timerActive: boolean;
}

/** Build the full system prompt, injecting session context if tasks are already recorded. */
function buildSystemPrompt({ tasks, currentTask, timerActive }: SessionContext): string {
    // The model has no clock; without this it guesses scheduledDate from its training data.
    const now = new Date();
    const prompt = `${systemInstruction}

Today is ${now.toDateString()} (${now.toLocaleDateString('en-CA')}). Use this to work out scheduledDate.`;

    if (tasks.length === 0) {
        return prompt;
    }

    const taskList = tasks.map(t => `"${t}"`).join(', ');
    const timerNote = timerActive
        ? 'A check-in timer is already running.'
        : 'No timer is set yet.';

    return `${prompt}

**ACTIVE SESSION CONTEXT** (auto-injected — do NOT repeat this to the user):
- Tasks already recorded: ${taskList}. Current focus: "${currentTask || tasks[0]}".
- ${timerNote}
- Do NOT call recordTasks again for these existing tasks. Only call recordTasks if the user mentions a COMPLETELY NEW task.
- Do NOT call setReminder again unless the user explicitly asks to change the timer.
- You MUST respond with visible text. Do NOT respond with only a tool call and no text.
- If the user asks for help, give them encouragement or a concrete starting tip for their current task.
- If the user says they don't want to do it, gently acknowledge and ask if they want to switch tasks or take a break.`;
}

/**
 * Turn the visible chat into model history. Back-to-back messages from one side are merged
 * (check-ins follow replies) and history starts at the first user message.
 */
export const toChatHistory = (messages: Pick<ChatMessage, 'sender' | 'text'>[]): ChatTurn[] => {
    const turns: ChatTurn[] = [];
    for (const message of messages) {
        const role = message.sender === 'user' ? 'user' : 'assistant';
        if (turns.length === 0 && role === 'assistant') continue;

        const last = turns[turns.length - 1];
        if (last?.role === role) {
            last.content += `\n\n${message.text}`;
        } else {
            turns.push({ role, content: message.text });
        }
    }
    return turns;
};

/** Stream a reply to the full chat history. The caller owns the history, so it survives reloads. */
export const streamReply = async (
    history: ChatTurn[],
    context: SessionContext,
    onChunk: StreamCallback
): Promise<AIResponse> => {
    const { provider, apiKey } = getConfig();

    const result = streamText({
        model: await getModel(provider, apiKey),
        maxOutputTokens: CHAT_MAX_OUTPUT_TOKENS,
        system: buildSystemPrompt(context),
        messages: history,
        // Providers send text in uneven bursts; this releases it word by word.
        experimental_transform: smoothStream(),
        tools: {
            setReminder: setReminderTool,
            recordTasks: recordTasksTool,
        },
    });

    return streamAssistantReplyToUI(result, onChunk, history[history.length - 1]?.content ?? '');
};

export const generateCheckinMessage = async (task: string): Promise<string> => {
    // If no real task is set, use a generic check-in
    if (!task) {
        return "Hey! Just checking in. How's your focus going? ✨";
    }

    const prompt = `Generate a short, friendly check-in notification (under 15 words) for someone working on: "${task}". Don't use special formatting.`;

    try {
        const { provider, apiKey } = getConfig();
        const model = await getModel(provider, apiKey);

        const result = await generateText({
            model,
            maxOutputTokens: CHECKIN_MAX_OUTPUT_TOKENS,
            messages: [{ role: 'user', content: prompt }],
        });

        return result.text || "Just checking in! How's your progress? ✨";
    } catch (error) {
        if (error instanceof Error && error.message.includes('No API key')) {
            throw error;
        }
        return `How's your progress going? Keep it up! ✨`;
    }
};
