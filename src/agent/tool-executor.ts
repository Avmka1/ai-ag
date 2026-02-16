import type { Page, BrowserContext } from 'playwright';
import {
  extractPageState,
  formatPageState,
  getElementForRef,
  type ElementRef,
  type PageState,
} from './page-extractor.js';

export interface LogEntry {
  type: 'thought' | 'action' | 'observation' | 'error' | 'info' | 'ask_user' | 'result';
  content: string;
  timestamp: number;
}

export interface ToolResult {
  output: string;
  pageState?: PageState;
  screenshotBase64?: string;
  clickedElement?: ElementRef;
  isDone?: boolean;
  doneResult?: string;
  isAskUser?: boolean;
  askUserQuestion?: string;
}

export class ToolExecutor {
  private context: BrowserContext;
  private _page: Page;
  private logger: (log: LogEntry) => void;
  private lastExtractedUrl: string | null = null;

  constructor(context: BrowserContext, page: Page, logger: (log: LogEntry) => void) {
    this.context = context;
    this._page = page;
    this.logger = logger;

    // Auto-track new tabs/popups
    this.context.on('page', async (newPage) => {
      this.logger({
        type: 'info',
        content: `New tab opened: ${newPage.url()}`,
        timestamp: Date.now(),
      });
      // Wait for the new page to be ready before switching
      await newPage.waitForLoadState('domcontentloaded').catch(() => {});
      this._page = newPage;
      this.lastExtractedUrl = null; // force refresh after tab switch
    });
  }

  private remember(pageState: PageState): void {
    this.lastExtractedUrl = pageState.url;
  }

  private hasPageChangedSinceLastExtract(): boolean {
    if (!this.lastExtractedUrl) return false;
    try {
      return this._page.url() !== this.lastExtractedUrl;
    } catch {
      return true;
    }
  }

  private async stabilizePage(): Promise<void> {
    // Best-effort wait for navigations and reactive UI updates.
    await this._page.waitForLoadState('domcontentloaded').catch(() => {});
    await this._page.waitForLoadState('load').catch(() => {});
    await this._page.waitForTimeout(600);
  }

  get currentPage(): Page {
    return this._page;
  }

  async snapshotPageState(): Promise<PageState> {
    const pageState = await extractPageState(this._page);
    this.remember(pageState);
    return pageState;
  }

  async execute(toolName: string, args: Record<string, any>): Promise<ToolResult> {
    this.logger({
      type: 'action',
      content: `${toolName}(${JSON.stringify(args)})`,
      timestamp: Date.now(),
    });

    try {
      switch (toolName) {
        case 'navigate':
          return await this.navigate(args.url);
        case 'click':
          return await this.click(args.ref);
        case 'type_text':
          return await this.typeText(args.ref, args.text);
        case 'press_key':
          return await this.pressKey(args.key);
        case 'scroll':
          return await this.scroll(args.direction, args.amount || 500);
        case 'browser_back':
          return await this.browserBack();
        case 'get_page_content':
          return await this.getPageContent();
        case 'extract_items':
          return await this.extractItems(args.maxItems);
        case 'find_elements':
          return await this.findElements(args.query, args.maxResults);
        case 'screenshot':
          return await this.takeScreenshot();
        case 'wait':
          return await this.waitMs(Math.min(args.ms || 1000, 10000));
        case 'done':
          return { output: `Task completed: ${args.result}`, isDone: true, doneResult: args.result };
        case 'ask_user':
          return { output: `Asking user: ${args.question}`, isAskUser: true, askUserQuestion: args.question };
        default:
          return { output: `Unknown tool: ${toolName}` };
      }
    } catch (error: any) {
      const errMsg = `Error executing ${toolName}: ${error.message}`;
      this.logger({ type: 'error', content: errMsg, timestamp: Date.now() });
      return { output: errMsg };
    }
  }

  private async navigate(url: string): Promise<ToolResult> {
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }

    try {
      await this._page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (err: any) {
      // Some sites timeout on domcontentloaded but still load — continue
      if (!err.message.includes('timeout')) {
        throw err;
      }
      this.logger({ type: 'info', content: 'Navigation timed out, continuing...', timestamp: Date.now() });
    }

    // Wait for redirects and dynamic content to settle
    await this.stabilizePage();

    // Check for CAPTCHA
    const currentUrl = this._page.url();
    if (this.isCaptchaPage(currentUrl)) {
      this.logger({
        type: 'info',
        content: 'CAPTCHA detected! Asking user to solve it.',
        timestamp: Date.now(),
      });
      return {
        output: `Navigated to ${currentUrl} but a CAPTCHA/anti-bot page was detected. The user needs to solve it manually in the browser.`,
        isAskUser: true,
        askUserQuestion: 'A CAPTCHA was detected. Please solve it in the browser window, then type "done" here.',
      };
    }

    const pageState = await extractPageState(this._page);
    this.remember(pageState);
    const formatted = formatPageState(pageState);

    this.logger({
      type: 'observation',
      content: `Navigated to ${this._page.url()} — ${pageState.elementCount} interactive elements found`,
      timestamp: Date.now(),
    });

    return { output: `Navigated to ${this._page.url()}.\n${formatted}`, pageState };
  }

  private isCaptchaPage(url: string): boolean {
    const captchaIndicators = ['captcha', 'showcaptcha', 'challenge', 'recaptcha', 'hcaptcha'];
    const lowerUrl = url.toLowerCase();
    return captchaIndicators.some((indicator) => lowerUrl.includes(indicator));
  }

  private async click(ref: number): Promise<ToolResult> {
    if (this.hasPageChangedSinceLastExtract()) {
      const pageState = await extractPageState(this._page);
      this.remember(pageState);
      const formatted = formatPageState(pageState);
      return {
        output: `Page changed since last observation (URL mismatch). Re-extracted page content; refs are updated. Please choose an element again.\n${formatted}`,
        pageState,
      };
    }

    const el = getElementForRef(ref);
    if (!el) {
      const pageState = await extractPageState(this._page);
      this.remember(pageState);
      const formatted = formatPageState(pageState);
      return {
        output: `Error: No element with ref ${ref}. Call get_page_content() to refresh references.\n${formatted}`,
        pageState,
      };
    }

    const label = (el.text || el.ariaLabel || el.placeholder || '').replace(/\\s+/g, ' ').trim();
    const shortLabel = label.length > 100 ? label.slice(0, 97) + '...' : label;
    const elDescParts: string[] = [];
    elDescParts.push(`<${el.tag}${el.type ? ` type=\"${el.type}\"` : ''}>`);
    if (shortLabel) elDescParts.push(`\"${shortLabel}\"`);
    if (el.role) elDescParts.push(`role=\"${el.role}\"`);
    if (el.testId) elDescParts.push(`data-testid=\"${el.testId}\"`);
    const elDesc = elDescParts.join(' ');

    const primarySelector = el.selector;
    const fallbackSelector = el.fallbackSelector;

    // Remember page count before click to detect new tabs
    const pagesBefore = this.context.pages().length;
    const pageBefore = this._page;

    let clicked = false;
    let lastErr: any = null;

    try {
      const tryClick = async (selector: string, allowForce: boolean): Promise<boolean> => {
        const loc = this._page.locator(selector).first();
        const enabled = await loc.isEnabled().catch(() => true);
        if (!enabled) {
          lastErr = new Error('Element is disabled');
          return false;
        }
        try {
          await loc.click({ timeout: 2500 });
          return true;
        } catch (err: any) {
          lastErr = err;
          const msg = String(err?.message || err);
          const isTimeout = err?.name === 'TimeoutError' || msg.includes('Timeout');
          if (allowForce && isTimeout) {
            try {
              await loc.click({ timeout: 2000, force: true });
              return true;
            } catch (err2: any) {
              lastErr = err2;
              return false;
            }
          }
          return false;
        }
      };

      const primaryCount = await this._page.locator(primarySelector).count();
      if (primaryCount >= 1) {
        clicked = await tryClick(primarySelector, true);
      } else if (fallbackSelector) {
        const fbCount = await this._page.locator(fallbackSelector).count();
        // Only use fallback if it uniquely identifies one element; otherwise it's too risky/ambiguous.
        if (fbCount === 1) {
          clicked = await tryClick(fallbackSelector, true);
        } else {
          lastErr = new Error(fbCount === 0 ? 'Element not found' : 'Stale ref (fallback is ambiguous)');
        }
      } else {
        lastErr = new Error('Element not found');
      }
    } catch (err: any) {
      lastErr = err;
    }

    if (!clicked) {
      const pageState = await extractPageState(this._page);
      this.remember(pageState);
      const formatted = formatPageState(pageState);
      return {
        output: `Failed to click ref ${ref} (${elDesc}): ${lastErr?.message || 'unknown error'}. Try get_page_content() to refresh.\n${formatted}`,
        pageState,
      };
    }

    // Wait for potential navigation / DOM updates
    await this.stabilizePage();

    // Check if a new tab appeared
    const pagesAfter = this.context.pages();
    if (pagesAfter.length > pagesBefore) {
      // Switch to the newest tab
      const newPage = pagesAfter[pagesAfter.length - 1];
      await newPage.waitForLoadState('domcontentloaded').catch(() => {});
      await newPage.waitForTimeout(1000);
      this._page = newPage;
      this.logger({
        type: 'info',
        content: `Switched to new tab: ${newPage.url()}`,
        timestamp: Date.now(),
      });
      await this.stabilizePage();
    } else if (this._page !== pageBefore) {
      // Page changed via the context 'page' event handler
      await this._page.waitForLoadState('domcontentloaded').catch(() => {});
      await this._page.waitForTimeout(1000);
      await this.stabilizePage();
    }

    // Check for CAPTCHA after click/navigation
    const currentUrl = this._page.url();
    if (this.isCaptchaPage(currentUrl)) {
      this.logger({
        type: 'info',
        content: 'CAPTCHA detected! Asking user to solve it.',
        timestamp: Date.now(),
      });
      return {
        output: `A CAPTCHA/anti-bot page was detected after clicking. The user needs to solve it manually in the browser.`,
        isAskUser: true,
        askUserQuestion: 'A CAPTCHA was detected. Please solve it in the browser window, then type "done" here.',
      };
    }

    const pageState = await extractPageState(this._page);
    this.remember(pageState);
    const formatted = formatPageState(pageState);

    return { output: `Clicked element [ref:${ref}] (${elDesc}).\n${formatted}`, pageState, clickedElement: el };
  }

  private async typeText(ref: number, text: string): Promise<ToolResult> {
    if (this.hasPageChangedSinceLastExtract()) {
      const pageState = await extractPageState(this._page);
      this.remember(pageState);
      const formatted = formatPageState(pageState);
      return {
        output: `Page changed since last observation (URL mismatch). Re-extracted page content; refs are updated. Please choose an input again.\n${formatted}`,
        pageState,
      };
    }

    const el = getElementForRef(ref);
    if (!el) {
      const pageState = await extractPageState(this._page);
      this.remember(pageState);
      const formatted = formatPageState(pageState);
      return {
        output: `Error: No element with ref ${ref}. Call get_page_content() to refresh.\n${formatted}`,
        pageState,
      };
    }

    const currentUrl = (() => {
      try {
        return this._page.url();
      } catch {
        return '';
      }
    })();

    const label = `${el.ariaLabel || ''} ${el.placeholder || ''}`.toLowerCase();
    const isPasswordField =
      el.type === 'password' ||
      label.includes('password') ||
      label.includes('пароль') ||
      label.includes('passcode');
    const isAuthOrAccountPage =
      currentUrl.includes('accounts.google.com') ||
      currentUrl.includes('myaccount.google.com') ||
      currentUrl.includes('signin') ||
      currentUrl.includes('login');

    if (isPasswordField || isAuthOrAccountPage) {
      const pageState = await extractPageState(this._page);
      this.remember(pageState);
      const formatted = formatPageState(pageState);
      return {
        output: `Sensitive/auth input detected. Please type it manually in the browser window, then type "done" here.\n${formatted}`,
        isAskUser: true,
        askUserQuestion: 'This looks like a login/security field. Please type it manually in the browser window, then type "done" here.',
        pageState,
      };
    }

    const primarySelector = el.selector;
    const fallbackSelector = el.fallbackSelector;

    let typed = false;
    let lastErr: any = null;

    const tryFill = async (selector: string): Promise<boolean> => {
      const loc = this._page.locator(selector).first();
      const enabled = await loc.isEnabled().catch(() => true);
      if (!enabled) {
        lastErr = new Error('Input is disabled');
        return false;
      }
      try {
        await loc.fill(text, { timeout: 5000 });
        await this._page.waitForTimeout(250);
        return true;
      } catch (err: any) {
        lastErr = err;
        return false;
      }
    };

    const primaryCount = await this._page.locator(primarySelector).count();
    if (primaryCount >= 1) {
      typed = await tryFill(primarySelector);
    } else if (fallbackSelector) {
      const fbCount = await this._page.locator(fallbackSelector).count();
      if (fbCount === 1) {
        typed = await tryFill(fallbackSelector);
      } else {
        lastErr = new Error(fbCount === 0 ? 'Element not found' : 'Stale ref (fallback is ambiguous)');
      }
    } else {
      lastErr = new Error('Element not found');
    }

    if (!typed) {
      const pageState = await extractPageState(this._page);
      this.remember(pageState);
      const formatted = formatPageState(pageState);
      return {
        output: `Failed to type into ref ${ref}: ${lastErr?.message || 'unknown error'}.\n${formatted}`,
        pageState,
      };
    }

    const pageState = await extractPageState(this._page);
    this.remember(pageState);
    const formatted = formatPageState(pageState);

    return { output: `Typed "${text}" into [ref:${ref}].\n${formatted}`, pageState };
  }

  private async pressKey(key: string): Promise<ToolResult> {
    await this._page.keyboard.press(key);
    await this._page.waitForTimeout(1000);

    const pageState = await extractPageState(this._page);
    this.remember(pageState);
    const formatted = formatPageState(pageState);

    return { output: `Pressed key: ${key}.\n${formatted}`, pageState };
  }

  private async scroll(direction: string, amount: number): Promise<ToolResult> {
    const delta = direction === 'down' ? amount : -amount;
    await this._page.evaluate((d: number) => window.scrollBy(0, d), delta);
    await this._page.waitForTimeout(500);

    const pageState = await extractPageState(this._page);
    this.remember(pageState);
    const formatted = formatPageState(pageState);

    return { output: `Scrolled ${direction} by ${amount}px.\n${formatted}`, pageState };
  }

  private async getPageContent(): Promise<ToolResult> {
    const pageState = await extractPageState(this._page);
    this.remember(pageState);
    const formatted = formatPageState(pageState);
    return { output: formatted, pageState };
  }

  private async browserBack(): Promise<ToolResult> {
    const beforeUrl = (() => {
      try {
        return this._page.url();
      } catch {
        return '';
      }
    })();

    try {
      const res = await this._page.goBack({ waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => null);
      if (!res) {
        const pageState = await extractPageState(this._page);
        this.remember(pageState);
        const formatted = formatPageState(pageState);
        return {
          output: `No browser history entry to go back to (stayed on ${beforeUrl}).\n${formatted}`,
          pageState,
        };
      }
    } catch (err: any) {
      const pageState = await extractPageState(this._page);
      this.remember(pageState);
      const formatted = formatPageState(pageState);
      return {
        output: `Failed to go back: ${err?.message || String(err)}\n${formatted}`,
        pageState,
      };
    }

    await this.stabilizePage();
    const pageState = await extractPageState(this._page);
    this.remember(pageState);
    const formatted = formatPageState(pageState);
    return { output: `Went back in browser history.\n${formatted}`, pageState };
  }

  private async extractItems(maxItems?: number): Promise<ToolResult> {
    const capped = Math.max(1, Math.min(Number.isFinite(maxItems) ? Number(maxItems) : 10, 20));

    // IMPORTANT: Extract page state first so interactive elements have stable refs (data-ai-agent-ref).
    const pageState = await extractPageState(this._page);
    this.remember(pageState);

    const items: Array<{ idx: number; text: string; refs: number[] }> = await this._page.evaluate((limit: number) => {
      const REF_ATTR = 'data-ai-agent-ref';
      const candidates = Array.from(
        document.querySelectorAll('tr, li, [role="row"], [role="listitem"], article')
      ) as HTMLElement[];

      const isVisible = (el: HTMLElement): boolean => {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        return true;
      };

      const normText = (s: string): string => s.replace(/\\s+/g, ' ').trim();

      const results: Array<{ idx: number; text: string; refs: number[]; top: number }> = [];

      for (const el of candidates) {
        if (results.length >= limit * 3) break; // collect extra then sort+trim
        if (!isVisible(el)) continue;

        const rect = el.getBoundingClientRect();
        // Prefer items in/near the viewport to represent "latest" visible items in lists.
        if (rect.bottom < -40 || rect.top > window.innerHeight + 300) continue;

        const text = normText(el.innerText || el.textContent || '');
        if (text.length < 25) continue;
        if (text.length > 500) continue;

        const refNodes = el.querySelectorAll(`[${REF_ATTR}]`);
        const refs = Array.from(refNodes)
          .map((n) => Number((n as HTMLElement).getAttribute(REF_ATTR) || ''))
          .filter((n) => Number.isFinite(n) && n > 0);
        if (refs.length === 0) continue;

        // Reduce duplicates: avoid items that are fully contained by a previously accepted item.
        const isContained = results.some((r) => {
          const prevEl = candidates[r.idx - 1];
          return prevEl && prevEl !== el && prevEl.contains(el);
        });
        if (isContained) continue;

        results.push({ idx: results.length + 1, text: text.slice(0, 220), refs: Array.from(new Set(refs)).slice(0, 8), top: rect.top });
      }

      results.sort((a, b) => a.top - b.top);
      const trimmed = results.slice(0, limit).map((r, i) => ({ idx: i + 1, text: r.text, refs: r.refs }));
      return trimmed;
    }, capped);

    const refToDesc = (ref: number): string => {
      const el = getElementForRef(ref) as ElementRef | undefined;
      if (!el) return `[ref:${ref}]`;
      const parts: string[] = [];
      parts.push(`[ref:${ref}] <${el.tag}${el.type ? ` type=\"${el.type}\"` : ''}>`);
      const label = (el.text || el.ariaLabel || el.placeholder || '').trim();
      if (label) parts.push(`"${label.slice(0, 80)}"`);
      if (el.role) parts.push(`role=\"${el.role}\"`);
      if (el.disabled) parts.push('disabled=true');
      return parts.join(' ');
    };

    const lines: string[] = [];
    lines.push(`Extracted ${items.length} item(s) (maxItems=${capped}).`);
    for (const item of items) {
      lines.push(`- Item ${item.idx}: ${item.text}`);
      lines.push(`  Refs: ${item.refs.map(refToDesc).join(', ')}`);
    }

    const formatted = formatPageState(pageState);
    return { output: lines.join('\n') + '\n\n' + formatted, pageState };
  }

  private async takeScreenshot(): Promise<ToolResult> {
    const buffer = await this._page.screenshot({ type: 'png', fullPage: false });
    const base64 = buffer.toString('base64');

    const pageState = await extractPageState(this._page);
    this.remember(pageState);
    const formatted = formatPageState(pageState);

    this.logger({
      type: 'info',
      content: 'Screenshot captured for vision analysis',
      timestamp: Date.now(),
    });

    return { output: `Screenshot taken.\n${formatted}`, pageState, screenshotBase64: base64 };
  }

  private async waitMs(ms: number): Promise<ToolResult> {
    await this._page.waitForTimeout(ms);
    await this.stabilizePage();
    const pageState = await extractPageState(this._page);
    this.remember(pageState);
    const formatted = formatPageState(pageState);
    return { output: `Waited ${ms}ms.\n${formatted}`, pageState };
  }

  private async findElements(query: string, maxResults?: number): Promise<ToolResult> {
    const q = String(query || '').trim();
    const qLower = q.toLowerCase();
    const capped = Math.max(1, Math.min(Number.isFinite(maxResults) ? Number(maxResults) : 12, 30));

    let pageState = await extractPageState(this._page);
    this.remember(pageState);

    if (!q) {
      return {
        output: 'find_elements: empty query. Provide a non-empty query string.',
        pageState,
      };
    }

    const rawTerms = q
      .toLowerCase()
      .split(/\s+/)
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 6);

    // Basic stemming for Russian declensions (e.g. "корзина" -> "корзин") so queries match UI text like
    // "в корзину/к корзине/на корзину" without requiring exact word form.
    const hasCyrillic = (s: string): boolean => /[а-яё]/i.test(s);
    const stemCyrillic = (t: string): string => {
      let s = t;
      // Remove up to 2 common ending characters; keep a minimum length to reduce false positives.
      for (let i = 0; i < 2; i++) {
        if (s.length <= 4) break;
        const next = s.replace(/[аеёиоуыэюяьй]$/i, '');
        if (next === s) break;
        s = next;
      }
      return s;
    };
    const termVariants = (t: string): string[] => {
      const vars: string[] = [t];
      if (hasCyrillic(t)) {
        const stem = stemCyrillic(t);
        if (stem && stem !== t && stem.length >= 3) vars.push(stem);
      } else {
        // Tiny English plural normalization ("orders" -> "order").
        if (t.endsWith('s') && t.length > 3) vars.push(t.slice(0, -1));
      }
      return Array.from(new Set(vars));
    };
    const terms = rawTerms.map(termVariants);
    const isCartNavigationQuery =
      (qLower.includes('корзин') || qLower.includes('checkout') || qLower.includes('оформ')) &&
      !/^в\s+корзину$/i.test(qLower);

    const isLikelyAddToCartControl = (el: ElementRef): boolean => {
      const testIdLower = (el.testId || '').toLowerCase();
      const labelLower = (el.text || el.ariaLabel || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (testIdLower.includes('counter-increase') || testIdLower.includes('add-to-cart')) return true;
      if (/^в\s+корзину$/.test(labelLower)) return true;
      if (/^add to cart$/.test(labelLower)) return true;
      return false;
    };

    const hayFor = (el: ElementRef): string => {
      const parts = [
        el.text,
        el.ariaLabel,
        el.placeholder,
        el.testId,
        el.href,
        el.role,
        el.tag,
        el.type,
      ]
        .filter(Boolean)
        .join(' ');
      return parts.replace(/\s+/g, ' ').trim().toLowerCase();
    };

    type Match = { el: ElementRef; score: number };
    const scoreElements = (elements: ElementRef[]): Match[] => {
      const scored: Match[] = [];
      for (const el of elements) {
        if (isCartNavigationQuery && isLikelyAddToCartControl(el)) continue;
        const hay = hayFor(el);
        if (!hay) continue;
        let score = 0;
        for (const variants of terms) {
          if (variants.some((t) => hay.includes(t))) score++;
        }
        if (isCartNavigationQuery) {
          const labelLower = (el.text || el.ariaLabel || '').replace(/\s+/g, ' ').trim().toLowerCase();
          const testIdLower = (el.testId || '').toLowerCase();
          if (/на\s+корзин/.test(labelLower)) score += 5;
          if (/корзин/.test(labelLower)) score += 2;
          if (/оформ|checkout/.test(labelLower)) score += 3;
          if (/достав|мин/.test(labelLower) && /₽|руб/.test(labelLower)) score += 2;
          if (testIdLower.includes('cart') || testIdLower.includes('basket')) score += 3;
        }
        if (score > 0) scored.push({ el, score });
      }
      return scored;
    };

    const requireAllTerms = terms.length >= 2;
    const hasStrictNegation = rawTerms.some((t) => t === 'без' || t === 'none' || t === 'without' || t.startsWith('не'));

    let scored = scoreElements(pageState.elements);
    let strictMatches = requireAllTerms
      ? scored.filter((m) => m.score >= terms.length)
      : scored;

    // For multi-term product queries, try a short auto-scroll before relaxing to partial matches.
    // This helps avoid false positives like "Большой/Двойной" when user asked for "Средний".
    if (requireAllTerms && strictMatches.length === 0) {
      for (let i = 0; i < 2 && strictMatches.length === 0; i++) {
        await this._page.mouse.wheel(0, 650);
        await this._page.waitForTimeout(350);
        pageState = await extractPageState(this._page);
        this.remember(pageState);
        scored = scoreElements(pageState.elements);
        strictMatches = requireAllTerms
          ? scored.filter((m) => m.score >= terms.length)
          : scored;
      }
    }

    let matches = strictMatches;

    // Relax to partial matches only for short non-negation queries.
    // For 3+ terms keep strict mode, otherwise model gets noisy results and loops.
    if (requireAllTerms && matches.length === 0 && !hasStrictNegation && rawTerms.length <= 2) {
      matches = scored;
    }

    matches.sort((a, b) => b.score - a.score || a.el.ref - b.el.ref);

    const best = matches.slice(0, capped);

    const describe = (el: ElementRef): string => {
      const label = (el.text || el.ariaLabel || el.placeholder || '').replace(/\s+/g, ' ').trim();
      const shortLabel = label.length > 110 ? label.slice(0, 107) + '...' : label;
      const bits: string[] = [];
      bits.push(`[ref:${el.ref}] <${el.tag}${el.type ? ` type="${el.type}"` : ''}>`);
      if (shortLabel) bits.push(`"${shortLabel}"`);
      if (el.role) bits.push(`role="${el.role}"`);
      if (el.testId) bits.push(`data-testid="${el.testId}"`);
      if (el.href) {
        const shortHref = el.href.length > 70 ? el.href.slice(0, 67) + '...' : el.href;
        bits.push(`href="${shortHref}"`);
      }
      if (el.disabled) bits.push('disabled=true');
      return bits.join(' ');
    };

    const lines: string[] = [];
    lines.push(`find_elements("${q}") => ${matches.length} match(es), showing ${best.length}:`);
    for (const m of best) {
      lines.push(`- ${describe(m.el)}`);
    }
    if (best.length === 0) {
      lines.push('- (no matches)');
      if (requireAllTerms) {
        lines.push('- tip: no exact multi-term match. Try scroll() then find_elements() again, or use the restaurant search input.');
      }
    }

    return { output: lines.join('\n'), pageState };
  }
}
