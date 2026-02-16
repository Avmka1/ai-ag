import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import OpenAI from 'openai';

interface Step {
  url: string;
  action: string;
  result: string;
}

export class ContextManager {
  private steps: Step[] = [];
  private summary: string = '';
  private systemPrompt: string;
  private openai: OpenAI;
  private model: string;
  private readonly recentStepCount = 5;
  private readonly maxSteps = 50;
  private readonly summarizeThreshold = 8;
  private isSummarizing = false;
  private totalSteps = 0;

  constructor(systemPrompt: string, openai: OpenAI, model: string) {
    this.systemPrompt = systemPrompt;
    this.openai = openai;
    this.model = model;
  }

  addStep(observation: string, action: string, result: string): void {
    this.totalSteps++;
    const url = this.extractUrl(observation);
    this.steps.push({ url, action, result });

    // Trigger summarization if threshold reached
    if (this.steps.length > this.summarizeThreshold && !this.isSummarizing) {
      // Local summarization only (no extra API calls); keeps the agent more stable under flaky network.
      this.summarizeOldSteps();
    }
  }

  get stepCount(): number {
    return this.totalSteps;
  }

  get hasReachedLimit(): boolean {
    return this.totalSteps >= this.maxSteps;
  }

  buildMessages(currentPageState: string): ChatCompletionMessageParam[] {
    const messages: ChatCompletionMessageParam[] = [];

    // System prompt
    messages.push({
      role: 'system' as const,
      content: this.systemPrompt,
    });

    // Summary of older steps
    if (this.summary) {
      messages.push({
        role: 'system' as const,
        content: `Previous actions summary: ${this.summary}`,
      });
    }

    // Recent actions (compact). Avoid sending full page states for history to reduce token usage.
    const recentStart = Math.max(0, this.steps.length - this.recentStepCount);
    const recentSteps = this.steps.slice(recentStart);
    if (recentSteps.length) {
      const lines: string[] = [];
      lines.push('Recent actions:');
      for (const step of recentSteps) {
        const res = (step.result || '').replace(/\s+/g, ' ').trim();
        const shortRes = res.length > 220 ? res.slice(0, 217) + '...' : res;
        const url = step.url ? ` @ ${step.url}` : '';
        lines.push(`- ${step.action}${url} => ${shortRes}`);
      }
      messages.push({ role: 'system' as const, content: lines.join('\n') });
    }

    // Current page state
    messages.push({
      role: 'user' as const,
      content: `Current page state:\n${currentPageState}\n\nDecide what to do next. Explain your reasoning briefly, then call a tool.`,
    });

    return messages;
  }

  buildMessagesWithScreenshot(
    currentPageState: string,
    screenshotBase64: string
  ): ChatCompletionMessageParam[] {
    const messages = this.buildMessages(currentPageState);

    // Replace last user message with multimodal one
    messages[messages.length - 1] = {
      role: 'user' as const,
      content: [
        {
          type: 'text' as const,
          text: `Current page state:\n${currentPageState}\n\nI also took a screenshot. Analyze both to decide what to do next.`,
        },
        {
          type: 'image_url' as const,
          image_url: {
            url: `data:image/png;base64,${screenshotBase64}`,
            detail: 'low' as const,
          },
        },
      ],
    };

    return messages;
  }

  private summarizeOldSteps(): void {
    this.isSummarizing = true;

    const stepsToSummarize = this.steps.slice(
      0,
      Math.max(0, this.steps.length - this.recentStepCount)
    );

    if (stepsToSummarize.length === 0) {
      this.isSummarizing = false;
      return;
    }

    const newSummaryLines = stepsToSummarize.map((s) => {
      const res = (s.result || '').replace(/\s+/g, ' ').trim();
      const shortRes = res.length > 120 ? res.slice(0, 117) + '...' : res;
      const url = s.url ? ` @ ${s.url}` : '';
      return `- ${s.action}${url} => ${shortRes}`;
    });

    const combined = [this.summary.trim(), ...newSummaryLines].filter(Boolean).join('\n');
    // Keep summary bounded so it doesn't grow indefinitely.
    this.summary = combined.length > 1400 ? combined.slice(combined.length - 1400) : combined;

    // Drop summarized steps; keep only the recent window.
    this.steps = this.steps.slice(-this.recentStepCount);

    this.isSummarizing = false;
  }

  private extractUrl(observation: string): string {
    const match = observation.match(/^URL:\s*(.+)$/m);
    return match ? match[1]!.trim() : '';
  }
}
