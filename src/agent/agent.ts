import OpenAI from 'openai';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { AGENT_TOOLS, buildSystemPrompt } from './tools.js';
import { ToolExecutor, type LogEntry, type ToolResult } from './tool-executor.js';
import { ContextManager } from './context-manager.js';
import { formatPageState, getElementForRef, type ElementRef, type PageState } from './page-extractor.js';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

export class AgentController {
  private openai: OpenAI;
  private model: string;
  private task: string;
  private logger: (log: LogEntry) => void;
  private userDataDir?: string;
  private _isRunning = false;
  private abortRequested = false;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private toolExecutor: ToolExecutor | null = null;
  private userAnswerResolve: ((answer: string) => void) | null = null;

  constructor(
    apiKey: string,
    model: string,
    task: string,
    logger: (log: LogEntry) => void,
    opts?: { userDataDir?: string }
  ) {
    // Disable SDK-level retries so we can control retry+timeout behavior explicitly.
    this.openai = new OpenAI({ apiKey, maxRetries: 0 });
    this.model = model;
    this.task = task;
    this.logger = logger;
    this.userDataDir = opts?.userDataDir;
  }

  get isRunning(): boolean {
    return this._isRunning;
  }

  async run(): Promise<string> {
    this._isRunning = true;
    this.abortRequested = false;

    this.log('info', `Agent started. Task: "${this.task}"`);
    this.log('info', `Model: ${this.model}`);

    try {
      this.log('info', 'Launching browser...');
      const launchArgs = [
        '--disable-blink-features=AutomationControlled',
        '--window-size=1280,900',
      ];

      const contextOptions = {
        viewport: { width: 1280, height: 900 },
        locale: 'ru-RU',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      } as const;

      if (this.userDataDir) {
        this.context = await chromium.launchPersistentContext(this.userDataDir, {
          headless: false,
          args: launchArgs,
          ignoreDefaultArgs: ['--enable-automation'],
          ...contextOptions,
        });
        this.browser = this.context.browser();
      } else {
        this.browser = await chromium.launch({
          headless: false,
          args: launchArgs,
          ignoreDefaultArgs: ['--enable-automation'],
        });
        this.context = await this.browser.newContext(contextOptions);
      }

      const page = this.context.pages()[0] || await this.context.newPage();

      // ToolExecutor manages page tracking (including new tabs) internally
      this.toolExecutor = new ToolExecutor(this.context, page, this.logger);

      const systemPrompt = buildSystemPrompt(this.task);
      const contextManager = new ContextManager(systemPrompt, this.openai, this.model);

      await page.goto('about:blank');
      let currentPageState = formatPageState(await this.toolExecutor.snapshotPageState());
      let lastScreenshot: string | undefined;

      type ActionRecord = { name: string; argsJson: string; url: string };
      const actionHistory: ActionRecord[] = [];
      const maxActionHistory = 12;
      const approvedSecurityActions = new Set<string>();
      const blockedActionKeys = new Map<string, number>();
      const diagActionLastAt = new Map<string, number>();
      const diagCooldownMs = 15_000;
      const blockTtlMs = 20_000;
      const toActionKey = (rec: ActionRecord): string => `${rec.url}|${rec.name}|${rec.argsJson}`;
      const rememberBlocked = (recs: ActionRecord[]): void => {
        const now = Date.now();
        for (const r of recs) {
          blockedActionKeys.set(toActionKey(r), now + blockTtlMs);
        }
        // Cleanup old keys opportunistically.
        for (const [k, until] of blockedActionKeys.entries()) {
          if (until <= now) blockedActionKeys.delete(k);
        }
      };

      const getSecurityGateForClick = (el: ElementRef | undefined): { kind: string; label: string } | null => {
        const label = (el?.text || el?.ariaLabel || '').trim();
        if (!label) return null;
        const lower = label.toLowerCase();

        // High-risk actions that should always be confirmed.
        const payWords = ['оплат', 'к оплате', 'pay', 'place order', 'confirm', 'подтверд'];
        const deleteWords = ['удал', 'delete', 'remove', 'spam', 'спам', 'empty', 'очист'];
        const sendWords = ['send', 'отправ'];

        const matches = (words: string[]) => words.some((w) => lower.includes(w));

        if (matches(payWords)) return { kind: 'payment/order', label };
        if (matches(deleteWords)) return { kind: 'delete/spam', label };
        if (matches(sendWords)) return { kind: 'send/submit', label };
        return null;
      };

      type LoopHint = { message: string; block: ActionRecord[] };

      const getLoopHint = (): LoopHint | null => {
        if (actionHistory.length < 3) return null;

        // Pattern loop (A-B-A-B) on the same URL.
        if (actionHistory.length >= 4) {
          const d = actionHistory[actionHistory.length - 1]!;
          const c = actionHistory[actionHistory.length - 2]!;
          const b = actionHistory[actionHistory.length - 3]!;
          const a = actionHistory[actionHistory.length - 4]!;
          const sameUrl = a.url === b.url && a.url === c.url && a.url === d.url;
          const abab =
            sameUrl &&
            a.name === c.name &&
            a.argsJson === c.argsJson &&
            b.name === d.name &&
            b.argsJson === d.argsJson &&
            !(a.name === b.name && a.argsJson === b.argsJson);
          if (abab) {
            return {
              message: `LOOP DETECTED: You are alternating between two actions with no progress: ${a.name}(${a.argsJson}) <-> ${b.name}(${b.argsJson}) on ${a.url}. Do NOT repeat the same pattern again. Reassess with get_page_content() or screenshot(), or try a different approach (scroll, press_key Escape/Back, browser_back, click a different relevant element).`,
              block: [a, b],
            };
          }
        }

        // Repeated identical action 3 times on the same URL.
        const a = actionHistory[actionHistory.length - 1]!;
        const b = actionHistory[actionHistory.length - 2]!;
        const c = actionHistory[actionHistory.length - 3]!;
        const same =
          a.name === b.name &&
          a.name === c.name &&
          a.argsJson === b.argsJson &&
          a.argsJson === c.argsJson &&
          a.url === b.url &&
          a.url === c.url;
        if (!same) return null;
        return {
          message: `LOOP DETECTED: You repeated the same action 3 times: ${a.name}(${a.argsJson}) on ${a.url} with no progress. Do NOT repeat the same action again. Instead, reassess with get_page_content() or screenshot(), or try a different approach (scroll, press_key Escape/Back, browser_back, click a different relevant element).`,
          block: [a],
        };
      };

      const taskLower = this.task.toLowerCase();
      // Gmail-specific safety guardrails. Keep this scoped to Gmail so we don't break other mail providers (e.g. Yandex Mail).
      const isGmailTask = /(gmail|mail\.google\.com)/.test(taskLower);
      const allowedHostsForGmailTask = new Set<string>(['mail.google.com', 'accounts.google.com']);
      const isYandexLoginUrl = (urlStr: string): boolean => {
        const lower = urlStr.toLowerCase();
        const isYandex = lower.includes('yandex.');
        return (
          lower.includes('passport.yandex.ru') ||
          lower.includes('oauth.yandex.ru') ||
          lower.includes('id.yandex.ru') ||
          lower.includes('login.yandex') ||
          // common Yandex auth/SSO routes
          (isYandex && lower.includes('/auth/')) ||
          (lower.includes('retpath=') && lower.includes('passport.yandex'))
        );
      };
      const safeHost = (urlStr: string): string | null => {
        try {
          return new URL(urlStr).host;
        } catch {
          return null;
        }
      };
      const isGoogleLoginUrl = (urlStr: string): boolean => {
        const lower = urlStr.toLowerCase();
        if (!lower.includes('accounts.google.com')) return false;
        return (
          lower.includes('/signin') ||
          lower.includes('servicelogin') ||
          lower.includes('/v3/signin') ||
          lower.includes('identifier') ||
          lower.includes('password')
        );
      };

      const wantsMultipleUnits =
        /\b([2-9]|10)\b/.test(taskLower) ||
        /\b(два|две|три|четыре|пять|шесть|семь|восемь|девять|десять|пару|несколько)\b/.test(taskLower);
      const stopBeforePaymentRequested =
        /(останов|перед оплат|не оплач|без оплаты)/.test(taskLower) ||
        /(stop before payment|before payment|do not pay|don't pay)/.test(taskLower);
      const noSauceRequested =
        /(без\s*соус|no\s*sauce|without\s*sauce)/.test(taskLower) ||
        taskLower.includes('не добавляй соус') ||
        taskLower.includes('без соусов');
      const noExtrasRequested =
        noSauceRequested ||
        /(не добавляй|без)\s*(соус|соусы|доп|допы|добавки|add-?ons?)/.test(taskLower);
      const targetFriesMediumRequested =
        /(картоф.*фри|french\s*fries|fries)/.test(taskLower) && /(средн|medium)/.test(taskLower);
      const addressChangeRequested =
        /(смен|измени|выбер|укажи).{0,24}(адрес|город|достав)/.test(taskLower) ||
        /(address|city).{0,24}(change|choose|select|set)/.test(taskLower);

      const recentSideEffectClicks = new Map<string, number>();
      const sideEffectClickedOnce = new Set<string>();
      // Prevent accidental double-clicks on "add to cart" controls without deadlocking the agent.
      // Keep TTL short so legitimate retries still work.
      const sideEffectTtlMs = 3_500;
      const targetSelectionTtlMs = 60_000;
      const targetAddEvidenceTtlMs = 20 * 60_000;
      let lastTargetItemSelectionAt = 0;
      let lastRestaurantUrl: string | null = null;
      let awaitingPaymentClickResult = false;
      let yandexCartPreparedForRun = false;
      let lastSelectedProductLabel = '';
      let targetFriesAddEvidenceCount = 0;
      let lastTargetFriesAddEvidenceAt = 0;
      let targetFriesRecoveryAttempts = 0;
      const targetFriesRecoveryLimit = 1;
      let invalidCartRecoveryAttempts = 0;
      const invalidCartRecoveryLimit = 3;
      let lastPotatoCategoryClickAt = 0;
      let potatoCategoryClickStreak = 0;
      const normalizeLabel = (el: ElementRef | undefined): string =>
        ((el?.text || el?.ariaLabel || el?.placeholder || '') as string).replace(/\s+/g, ' ').trim().toLowerCase();
      const isYandexEdaUrl = (urlStr: string): boolean => /https?:\/\/eda\.yandex\./i.test(urlStr || '');
      const isInvalidYandexCartUrl = (urlStr: string): boolean => {
        const lower = (urlStr || '').toLowerCase();
        if (!isYandexEdaUrl(lower)) return false;
        return lower.includes('redirectfrom=invalid_cart') || /[?&]invalid_cart(?:[=&]|$)/.test(lower);
      };
      const hasFreshTargetFriesEvidence = (): boolean =>
        targetFriesAddEvidenceCount > 0 && Date.now() - lastTargetFriesAddEvidenceAt < targetAddEvidenceTtlMs;
      const markTargetFriesAddEvidence = (source: string): void => {
        if (!targetFriesMediumRequested) return;
        targetFriesAddEvidenceCount += 1;
        lastTargetFriesAddEvidenceAt = Date.now();
        if (targetFriesAddEvidenceCount === 1) {
          this.log('info', `Detected target fries add evidence (${source}).`);
        }
      };
      const hasTargetFriesMediumInState = (state: PageState): boolean => {
        if (!targetFriesMediumRequested) return true;
        const byVisibleText = /(картоф.{0,25}фри|french\s*fries|fries).{0,20}(средн|medium)/i.test(state.visibleText || '');
        if (byVisibleText) return true;

        return state.elements.some((el) => {
          if (el.tag === 'input' || el.tag === 'textarea') return false;
          const label = normalizeLabel(el);
          if (!label) return false;
          if (label.includes('искать') || label.includes('search')) return false;
          return /(картоф.*фри|french\s*fries|fries)/.test(label) && /(средн|medium)/.test(label);
        });
      };
      const hasNonEmptyCartSignals = (state: PageState): boolean => {
        const visible = (state.visibleText || '').toLowerCase();
        if (!visible && state.elements.length === 0) return false;
        if (/(корзина\s+пуста|empty\s*cart|нет\s+товар)/.test(visible)) return false;

        const hasClearCartButton = state.elements.some((el) => {
          const label = normalizeLabel(el);
          return /очистить\s+корзину|clear\s+cart/.test(label);
        });
        const hasQtyAdjustControls = state.elements.some((el) => {
          const label = normalizeLabel(el);
          const testIdLower = (el.testId || '').toLowerCase();
          if (testIdLower.includes('amount-select-decrement') || testIdLower.includes('amount-select-increment')) {
            return true;
          }
          return /уменьшить\s*кол-во|увеличить\s*кол-во|decrease.*(qty|quantity)|increase.*(qty|quantity)/.test(label);
        });
        const hasLineItemLikePrice =
          /(картоф|фри|бургер|наггет|салат|комбо|бокс|ролл|стартер|fries|burger|nugget|salad|combo|box|starter)/.test(visible) &&
          /(\d[\d\s]*)\s*₽/.test(visible);
        const hasItemCount =
          /\b([1-9]\d*)\s*товар/.test(visible) ||
          /\b([1-9]\d*)\s*item/.test(visible) ||
          /\bтоваров:\s*([1-9]\d*)/.test(visible);

        return hasClearCartButton || hasQtyAdjustControls || hasItemCount || hasLineItemLikePrice;
      };
      const hasAnyFriesMention = (state: PageState): boolean => {
        const visible = (state.visibleText || '').toLowerCase();
        if (/(картоф.{0,20}фри|french\s*fries|fries)/.test(visible)) return true;
        return state.elements.some((el) => {
          if (el.tag === 'input' || el.tag === 'textarea') return false;
          const label = normalizeLabel(el);
          if (!label) return false;
          if (label.includes('искать') || label.includes('search')) return false;
          return /(картоф.*фри|french\s*fries|fries)/.test(label);
        });
      };
      const hasLikelyTargetFriesInOrder = (state: PageState): boolean => {
        if (!targetFriesMediumRequested) return true;
        if (hasTargetFriesMediumInState(state)) return true;

        const evidenceFresh =
          targetFriesAddEvidenceCount > 0 && Date.now() - lastTargetFriesAddEvidenceAt < targetAddEvidenceTtlMs;
        const stateUrl = state.url || '';
        if (
          evidenceFresh &&
          isYandexEdaUrl(stateUrl) &&
          /\/checkout\b/i.test(stateUrl) &&
          !isInvalidYandexCartUrl(stateUrl)
        ) {
          return true;
        }

        if (!hasNonEmptyCartSignals(state)) return false;
        if (evidenceFresh) return true;

        return hasAnyFriesMention(state);
      };
      const isNoSauceOption = (labelLower: string): boolean => {
        return (
          /без\s*соус/.test(labelLower) ||
          /no\s*sauce/.test(labelLower) ||
          /without\s*sauce/.test(labelLower) ||
          /не\s*нужен/.test(labelLower) ||
          /none/.test(labelLower)
        );
      };
      const isSauceLike = (labelLower: string): boolean => {
        if (!labelLower) return false;
        // Broad but safe: avoid sauce/add-on selections unless explicitly requested.
        const sauceHints = [
          'соус',
          'sauce',
          'кетч',
          'ketchup',
          'майон',
          'mayo',
          'барбекю',
          'bbq',
          'сырн',
          'cheese',
          'чесноч',
          'garlic',
          'горч',
          'mustard',
          'сладк',
          'кисл',
          'sweet',
          'sour',
        ];
        return sauceHints.some((h) => labelLower.includes(h));
      };

      const isAddToCartControl = (el: ElementRef | undefined): boolean => {
        if (!el) return false;
        const testIdLower = (el.testId || '').toLowerCase();
        if (testIdLower.includes('add-to-cart')) return true;
        if (testIdLower.includes('counter-increase')) return true;

        const labelLower = normalizeLabel(el);
        // Do NOT treat "В корзину" as add-to-cart: on many UIs it's a "go to cart" CTA.
        // Prefer stable identifiers (data-testid) for add-to-cart buttons.
        if (labelLower === 'добавить' || labelLower === 'add' || labelLower === 'add to cart') return true;
        return false;
      };

      const computeSideEffectKey = (el: ElementRef | undefined, currentUrl: string): string | null => {
        if (!el) return null;
        if (!isAddToCartControl(el)) return null;
        const testIdLower = (el.testId || '').toLowerCase();
        const labelLower = normalizeLabel(el);
        const sel = el.fallbackSelector || el.selector;
        const stableId = (testIdLower || labelLower || `${el.tag}`).slice(0, 80);
        return `${currentUrl}|add_to_cart|${stableId}|${sel}`;
      };

      const isGoToCartControl = (el: ElementRef | undefined): boolean => {
        if (!el) return false;
        if (isAddToCartControl(el)) return false;

        const labelLower = normalizeLabel(el);
        const testIdLower = (el.testId || '').toLowerCase();
        const looksLikeStickyOrderBar =
          /(достав|delivery)/.test(labelLower) &&
          /мин/.test(labelLower) &&
          (/₽/.test(labelLower) || /\bруб/.test(labelLower)) &&
          !/(картоф|фри|бургер|наггет|салат|соус|бокс|комбо|starter|salad|sauce)/.test(labelLower);
        const hasCartWord =
          /корзин/.test(labelLower) ||
          /\bcart\b/.test(labelLower) ||
          /\bbasket\b/.test(labelLower) ||
          testIdLower.includes('cart') ||
          testIdLower.includes('basket');
        if (!hasCartWord && !looksLikeStickyOrderBar) return false;

        // Exclude product "add to cart" labels if they leak through generic matching.
        if (/^в\s+корзину$/.test(labelLower)) return false;
        if (labelLower === 'в корзину') return false;
        if (testIdLower.includes('counter-increase')) return false;
        if (testIdLower.includes('add-to-cart')) return false;

        return true;
      };
      const isMinOrderCartBar = (el: ElementRef | undefined): boolean => {
        if (!el) return false;
        const labelLower = normalizeLabel(el);
        if (!labelLower) return false;
        return /на\s+корзин\w*\s+от\s*\d/.test(labelLower) && /(достав|delivery)/.test(labelLower) && /мин/.test(labelLower);
      };
      const isPotatoCategorySection = (el: ElementRef | undefined): boolean => {
        const labelLower = normalizeLabel(el);
        return /картофель,\s*стартеры\s*и\s*салаты/.test(labelLower);
      };

      const pickCartTarget = (elements: ElementRef[]): ElementRef | null => {
        const candidates = elements.filter((el) => isGoToCartControl(el) && !el.disabled);
        if (candidates.length === 0) return null;

        const score = (el: ElementRef): number => {
          const labelLower = normalizeLabel(el);
          const testIdLower = (el.testId || '').toLowerCase();
          let s = 0;
          if (/на\s+корзин/.test(labelLower)) s += 5;
          if (/корзин/.test(labelLower)) s += 3;
          if (/оформ|checkout/.test(labelLower)) s += 2;
          if (/₽|руб|достав|мин/.test(labelLower)) s += 2;
          if (el.tag === 'button') s += 1;
          if ((el.role || '').toLowerCase() === 'button') s += 1;
          if (testIdLower.includes('cart')) s += 2;
          return s;
        };

        candidates.sort((a, b) => score(b) - score(a) || a.ref - b.ref);
        return candidates[0] || null;
      };

      const looksLikeAddressHeader = (el: ElementRef | undefined): boolean => {
        if (!el) return false;
        if (isAddToCartControl(el) || isGoToCartControl(el)) return false;
        const label = normalizeLabel(el);
        if (!label) return false;
        // Street-like address chips in Yandex UIs often look like "проспект ..., дом ..., подъезд ...".
        const hasStreetWord =
          /(просп|пр-т|ул\.?|улиц|шосс|бульвар|пер\.?|наб\.?|переул|подъезд|дом|кв\.?|корп|литер)/.test(label);
        const hasDigits = /\d/.test(label);
        return hasStreetWord && hasDigits;
      };

      const isTargetFriesMediumElement = (el: ElementRef | undefined): boolean => {
        if (!el) return false;
        if (el.tag === 'input' || el.tag === 'textarea') return false;
        const role = (el.role || '').toLowerCase();
        if (role === 'combobox' || role === 'textbox' || role === 'searchbox') return false;
        const label = normalizeLabel(el);
        if (!label) return false;
        const hasFries = /(картоф.*фри|french\s*fries|fries)/.test(label);
        const hasMedium = /(средн|medium)/.test(label);
        return hasFries && hasMedium;
      };

      const isFriesButNotMedium = (el: ElementRef | undefined): boolean => {
        if (!el) return false;
        if (el.tag === 'input' || el.tag === 'textarea') return false;
        const role = (el.role || '').toLowerCase();
        if (role === 'combobox' || role === 'textbox' || role === 'searchbox') return false;
        const label = normalizeLabel(el);
        if (!label) return false;
        const hasFries = /(картоф.*фри|french\s*fries|fries)/.test(label);
        if (!hasFries) return false;
        const hasMedium = /(средн|medium)/.test(label);
        if (hasMedium) return false;
        const hasOtherSize = /(двойн|больш|large|double|мал|small)/.test(label);
        return hasOtherSize;
      };
      const isLikelyProductSelectionControl = (el: ElementRef | undefined): boolean => {
        if (!el) return false;
        if (el.tag === 'input' || el.tag === 'textarea') return false;
        if (isAddToCartControl(el) || isGoToCartControl(el)) return false;
        const label = normalizeLabel(el);
        if (!label || label.length < 4) return false;
        const role = (el.role || '').toLowerCase();
        if (!(el.tag === 'button' || el.tag === 'a' || role === 'button' || role === 'tab' || role === 'menuitem')) {
          return false;
        }
        return /(картоф|фри|бургер|наггет|салат|стартер|крылыш|ролл|комбо|бокс|fries|burger|nugget|salad|combo|box|starter)/.test(label);
      };

      const pickTargetFriesMedium = (elements: ElementRef[]): ElementRef | null => {
        const candidates = elements.filter((el) => {
          if (!isTargetFriesMediumElement(el)) return false;
          if (isAddToCartControl(el)) return false;
          if (el.disabled) return false;
          const role = (el.role || '').toLowerCase();
          return el.tag === 'button' || el.tag === 'a' || role === 'button' || role === 'tab' || role === 'menuitem';
        });
        if (candidates.length === 0) return null;
        candidates.sort((a, b) => a.ref - b.ref);
        return candidates[0] || null;
      };

      const tryFindTargetFriesMedium = async (): Promise<ElementRef | null> => {
        const exec = this.toolExecutor;
        if (!exec) return null;

        const pickRestaurantSearchInput = (elements: ElementRef[]): ElementRef | null => {
          const candidates = elements.filter((el) => {
            if (el.disabled) return false;
            if (el.tag !== 'input' && el.tag !== 'textarea') return false;
            const label = normalizeLabel(el);
            if (!label) return false;
            return (
              label.includes('искать') ||
              label.includes('поиск') ||
              label.includes('search') ||
              label.includes('в ресторане')
            );
          });
          return candidates[0] || null;
        };

        const initial = await exec.execute('get_page_content', {});
        let pageState = initial.pageState || (await exec.snapshotPageState());
        let target = pickTargetFriesMedium(pageState.elements);
        if (target) return target;

        // If not visible yet, scroll a bit and retry.
        await exec.execute('scroll', { direction: 'down', amount: 700 });
        const afterScroll = await exec.execute('get_page_content', {});
        pageState = afterScroll.pageState || (await exec.snapshotPageState());
        target = pickTargetFriesMedium(pageState.elements);
        if (target) return target;

        // If still not found, search within restaurant and try again.
        const searchInput = pickRestaurantSearchInput(pageState.elements);
        if (searchInput) {
          await exec.execute('type_text', { ref: searchInput.ref, text: 'Картофель Фри Средний' });
          await exec.execute('wait', { ms: 800 });
          const afterSearch = await exec.execute('get_page_content', {});
          pageState = afterSearch.pageState || (await exec.snapshotPageState());
          target = pickTargetFriesMedium(pageState.elements);
          if (target) return target;
        }

        // Final nudge: small additional scroll and one last check.
        await exec.execute('scroll', { direction: 'down', amount: 450 });
        const afterSecondScroll = await exec.execute('get_page_content', {});
        pageState = afterSecondScroll.pageState || (await exec.snapshotPageState());
        target = pickTargetFriesMedium(pageState.elements);
        if (target) return target;

        return null;
      };

      const tryAutoOpenCart = async (reason: string, urlFallback: string): Promise<boolean> => {
        const exec = this.toolExecutor;
        if (!exec) return false;

        const getCurrentUrl = (): string => {
          try {
            return exec.currentPage.url();
          } catch {
            return urlFallback;
          }
        };

        const parseRefsFromOutput = (text: string): number[] => {
          const refs = new Set<number>();
          const re = /\[ref:(\d+)\]/g;
          let m: RegExpExecArray | null = null;
          while ((m = re.exec(text))) {
            const ref = Number(m[1]);
            if (Number.isFinite(ref)) refs.add(ref);
          }
          return Array.from(refs);
        };

        const isProceedToCheckoutControl = (el: ElementRef | undefined): boolean => {
          if (!el || el.disabled) return false;
          if (isAddToCartControl(el) || isGoToCartControl(el)) return false;
          const label = normalizeLabel(el);
          const testIdLower = (el.testId || '').toLowerCase();
          if (!label && !testIdLower) return false;
          if (/^оплатить\b|^pay\b/.test(label)) return false;
          if (label === 'заказать' || label === 'сходить') return false;
          if (testIdLower.includes('checkout') || testIdLower.includes('place-order') || testIdLower.includes('order-submit')) {
            return true;
          }
          return /оформить\s*заказ|к\s*оформлению|перейти\s*к\s*оформлению|к\s*оплате|checkout|to checkout|продолжить|continue|далее|next/.test(
            label
          );
        };

        const pickProceedToCheckoutTarget = (elements: ElementRef[]): ElementRef | null => {
          const candidates = elements.filter((el) => isProceedToCheckoutControl(el));
          if (candidates.length === 0) return null;
          const score = (el: ElementRef): number => {
            const label = normalizeLabel(el);
            const testIdLower = (el.testId || '').toLowerCase();
            let s = 0;
            if (/к\s*оплате|to checkout|checkout/.test(label)) s += 6;
            if (/оформить\s*заказ|к\s*оформлению/.test(label)) s += 5;
            if (/продолжить|continue|далее|next/.test(label)) s += 2;
            if ((el.role || '').toLowerCase() === 'button' || el.tag === 'button') s += 1;
            if (testIdLower.includes('checkout') || testIdLower.includes('order-submit')) s += 4;
            return s;
          };
          candidates.sort((a, b) => score(b) - score(a) || a.ref - b.ref);
          return candidates[0] || null;
        };

        const tryDirectCheckoutFallback = async (fallbackReason: string): Promise<boolean> => {
          const currentUrl = getCurrentUrl();
          if (!isYandexEdaUrl(currentUrl)) return false;
          const stateBefore = await exec.snapshotPageState();
          currentPageState = formatPageState(stateBefore);
          if (!hasNonEmptyCartSignals(stateBefore) && !hasFreshTargetFriesEvidence()) {
            this.log('info', `${fallbackReason} Checkout fallback skipped: cart signals are not confirmed yet.`);
            return false;
          }
          const checkoutUrl = 'https://eda.yandex.ru/checkout';
          const note = `${fallbackReason} Fallback navigate to checkout: ${checkoutUrl}`;
          this.log('info', note);
          await exec.currentPage.goto(checkoutUrl, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
          await exec.currentPage.waitForTimeout(1200).catch(() => {});
          const checkoutState = await exec.snapshotPageState();
          currentPageState = formatPageState(checkoutState);
          contextManager.addStep(currentPageState, `[AUTO] navigate("${checkoutUrl}")`, note);
          actionHistory.push({
            name: 'navigate',
            argsJson: JSON.stringify({ url: checkoutUrl }),
            url: checkoutState.url || checkoutUrl,
          });
          if (actionHistory.length > maxActionHistory) actionHistory.shift();

          const landedUrl = checkoutState.url || checkoutUrl;
          if (isInvalidYandexCartUrl(landedUrl)) {
            this.log('info', `Checkout fallback landed on invalid cart redirect: ${landedUrl}`);
            return false;
          }
          return /\/checkout\b/i.test(landedUrl);
        };

        const tryProceedToCheckout = async (proceedReason: string): Promise<boolean> => {
          let state = await exec.snapshotPageState();
          currentPageState = formatPageState(state);

          const urlNow = state.url || getCurrentUrl();
          if (isInvalidYandexCartUrl(urlNow)) return false;
          if (isYandexEdaUrl(urlNow) && /\/checkout\b/i.test(urlNow)) return true;

          let target = pickProceedToCheckoutTarget(state.elements);
          if (!target) {
            const queries = ['оформить заказ', 'к оформлению', 'к оплате', 'checkout', 'продолжить', 'continue', 'далее', 'next'];
            for (const query of queries) {
              const found = await exec.execute('find_elements', { query, maxResults: 10 });
              state = found.pageState || (await exec.snapshotPageState());
              currentPageState = formatPageState(state);
              target = pickProceedToCheckoutTarget(state.elements);
              if (!target) {
                const refs = parseRefsFromOutput(found.output);
                for (const ref of refs) {
                  const el = getElementForRef(ref);
                  if (el && isProceedToCheckoutControl(el)) {
                    target = el;
                    break;
                  }
                }
              }
              if (target) break;
            }
          }
          if (!target) return false;

          const note = `${proceedReason} Proceeding to checkout via [ref:${target.ref}] "${(target.text || target.ariaLabel || '').trim()}".`;
          this.log('info', note);
          const clickRes = await exec.execute('click', { ref: target.ref });
          const clickObs = clickRes.output.substring(0, 300);
          this.log('observation', clickObs + (clickRes.output.length > 300 ? '...' : ''));
          state = clickRes.pageState || (await exec.snapshotPageState());
          currentPageState = formatPageState(state);
          contextManager.addStep(currentPageState, `[AUTO] click({"ref":${target.ref}})`, note);
          actionHistory.push({
            name: 'click',
            argsJson: JSON.stringify({ ref: target.ref }),
            url: state.url || getCurrentUrl(),
          });
          if (actionHistory.length > maxActionHistory) actionHistory.shift();
          if (clickRes.screenshotBase64) lastScreenshot = clickRes.screenshotBase64;

          const afterUrl = state.url || getCurrentUrl();
          if (isInvalidYandexCartUrl(afterUrl)) return false;
          if (isYandexEdaUrl(afterUrl) && /\/checkout\b/i.test(afterUrl)) return true;

          await exec.execute('wait', { ms: 900 });
          state = await exec.snapshotPageState();
          currentPageState = formatPageState(state);
          const waitedUrl = state.url || getCurrentUrl();
          if (isInvalidYandexCartUrl(waitedUrl)) return false;
          return isYandexEdaUrl(waitedUrl) && /\/checkout\b/i.test(waitedUrl);
        };

        let state = await exec.snapshotPageState();
        currentPageState = formatPageState(state);
        const initialUrl = state.url || getCurrentUrl();
        if (isInvalidYandexCartUrl(initialUrl)) {
          this.log('info', `Blocked cart auto-open due to invalid cart redirect URL: ${initialUrl}`);
          return false;
        }
        if (isYandexEdaUrl(initialUrl) && /\/checkout\b/i.test(initialUrl)) {
          return true;
        }

        const refreshed = await exec.execute('get_page_content', {});
        state = refreshed.pageState || (await exec.snapshotPageState());
        currentPageState = formatPageState(state);
        let cartTarget = pickCartTarget(state.elements);

        // If modal/overlay hides the cart CTA, try closing overlays first.
        if (!cartTarget) {
          await exec.execute('press_key', { key: 'Escape' });
          const afterEsc = await exec.execute('get_page_content', {});
          state = afterEsc.pageState || (await exec.snapshotPageState());
          currentPageState = formatPageState(state);
          cartTarget = pickCartTarget(state.elements);
        }

        if (!cartTarget) {
          const cartQueries = ['на корзину', 'корзина', 'корзин', 'оформить заказ', 'checkout'];
          for (const q of cartQueries) {
            const found = await exec.execute('find_elements', { query: q, maxResults: 10 });
            state = found.pageState || (await exec.snapshotPageState());
            currentPageState = formatPageState(state);

            cartTarget = pickCartTarget(state.elements);
            if (!cartTarget) {
              const refs = parseRefsFromOutput(found.output);
              for (const ref of refs) {
                const el = getElementForRef(ref);
                if (!el || el.disabled || isAddToCartControl(el)) continue;
                const label = normalizeLabel(el);
                if (/корзин|checkout|оформ/.test(label)) {
                  cartTarget = el;
                  break;
                }
              }
            }
            if (cartTarget) break;
          }
        }

        if (!cartTarget) {
          for (let i = 0; i < 2 && !cartTarget; i++) {
            await exec.execute('wait', { ms: 900 });
            const retry = await exec.execute('get_page_content', {});
            state = retry.pageState || (await exec.snapshotPageState());
            currentPageState = formatPageState(state);
            cartTarget = pickCartTarget(state.elements);
          }
        }

        if (!cartTarget) {
          const proceeded = await tryProceedToCheckout(`${reason} Cart CTA not found.`);
          if (proceeded) return true;
          return await tryDirectCheckoutFallback(`${reason} Cart CTA not found.`);
        }
        if (isMinOrderCartBar(cartTarget)) {
          const note = `${reason} Cart control "${(cartTarget.text || cartTarget.ariaLabel || '').trim()}" looks like a minimum-order bar; trying checkout actions without clicking it.`;
          this.log('info', note);
          const proceeded = await tryProceedToCheckout(note);
          if (proceeded) return true;
          return await tryDirectCheckoutFallback(`${note} Proceed CTA not found.`);
        }

        const autoNote = `${reason} Auto-opening cart via [ref:${cartTarget.ref}] "${(cartTarget.text || cartTarget.ariaLabel || '').trim()}".`;
        this.log('info', autoNote);
        const autoClick = await exec.execute('click', { ref: cartTarget.ref });
        const autoObs = autoClick.output.substring(0, 300);
        this.log('observation', autoObs + (autoClick.output.length > 300 ? '...' : ''));
        currentPageState = autoClick.pageState
          ? formatPageState(autoClick.pageState)
          : formatPageState(await exec.snapshotPageState());
        contextManager.addStep(currentPageState, `[AUTO] click({"ref":${cartTarget.ref}})`, autoNote);
        actionHistory.push({
          name: 'click',
          argsJson: JSON.stringify({ ref: cartTarget.ref }),
          url: autoClick.pageState?.url || urlFallback || getCurrentUrl(),
        });
        if (actionHistory.length > maxActionHistory) actionHistory.shift();
        if (autoClick.screenshotBase64) lastScreenshot = autoClick.screenshotBase64;

        const afterClickUrl = getCurrentUrl();
        if (isInvalidYandexCartUrl(afterClickUrl)) {
          this.log('info', `Cart click led to invalid cart redirect: ${afterClickUrl}`);
          return false;
        }
        if (isYandexEdaUrl(afterClickUrl) && /\/checkout\b/i.test(afterClickUrl)) {
          return true;
        }

        const proceeded = await tryProceedToCheckout(`${reason} Cart CTA clicked.`);
        if (proceeded) return true;

        return await tryDirectCheckoutFallback(`${reason} Cart CTA clicked but checkout CTA was not found.`);
      };
      const tryPrepareFreshYandexCart = async (): Promise<void> => {
        const exec = this.toolExecutor;
        if (!exec || !targetFriesMediumRequested || yandexCartPreparedForRun) return;
        const currentUrl = (() => {
          try {
            return exec.currentPage.url();
          } catch {
            return '';
          }
        })();
        if (!/https?:\/\/eda\.yandex\./i.test(currentUrl)) return;
        if (/showcaptcha/i.test(currentUrl) || isYandexLoginUrl(currentUrl)) return;

        const checkoutUrl = 'https://eda.yandex.ru/checkout';
        const nav = await exec.execute('navigate', { url: checkoutUrl });
        let state = nav.pageState || (await exec.snapshotPageState());
        currentPageState = formatPageState(state);

        const pickClearCart = (): ElementRef | null => {
          const clearBtn = state.elements.find((el) => !el.disabled && /очистить\s+корзину|clear\s+cart/.test(normalizeLabel(el)));
          return clearBtn || null;
        };
        let clearBtn = pickClearCart();
        if (clearBtn) {
          const note = 'Pre-run cleanup: clearing Yandex Eda cart for deterministic target-item verification.';
          this.log('info', note);
          const clickClear = await exec.execute('click', { ref: clearBtn.ref });
          state = clickClear.pageState || (await exec.snapshotPageState());
          currentPageState = formatPageState(state);
          await exec.execute('wait', { ms: 700 });
          state = await exec.snapshotPageState();
          currentPageState = formatPageState(state);

          // Confirm cleanup if confirmation modal is shown.
          const confirm = state.elements.find((el) => {
            if (el.disabled) return false;
            const label = normalizeLabel(el);
            if (!label) return false;
            if (/отмена|cancel/.test(label)) return false;
            return /очистить|удалить|подтверд|yes|да/.test(label);
          });
          if (confirm) {
            const clickConfirm = await exec.execute('click', { ref: confirm.ref });
            state = clickConfirm.pageState || (await exec.snapshotPageState());
            currentPageState = formatPageState(state);
            await exec.execute('wait', { ms: 700 });
            state = await exec.snapshotPageState();
            currentPageState = formatPageState(state);
          }
        }

        // Reset target evidence to avoid contamination from previous cart content.
        targetFriesAddEvidenceCount = 0;
        lastTargetFriesAddEvidenceAt = 0;
        lastTargetItemSelectionAt = 0;
        lastSelectedProductLabel = '';
        targetFriesRecoveryAttempts = 0;

        const feedUrl = 'https://eda.yandex.ru/spb?shippingType=delivery';
        const backToFeed = await exec.execute('navigate', { url: feedUrl });
        currentPageState = backToFeed.pageState
          ? formatPageState(backToFeed.pageState)
          : formatPageState(await exec.snapshotPageState());
        yandexCartPreparedForRun = true;
      };

      const pickAddToCartCandidate = (elements: ElementRef[]): ElementRef | null => {
        const score = (el: ElementRef): number => {
          const label = normalizeLabel(el);
          const testId = (el.testId || '').toLowerCase();
          let s = 0;
          if (testId.includes('amount-select-increment')) s += 6;
          if (testId.includes('counter-increase')) s += 5;
          if (testId.includes('add-to-cart')) s += 4;
          if (label === 'добавить' || label === 'add') s += 3;
          if (/^в\s+корзину$/.test(label)) s += 2;
          if (el.tag === 'button') s += 1;
          return s;
        };

        const cands = elements.filter((el) => {
          if (el.disabled) return false;
          const label = normalizeLabel(el);
          const testId = (el.testId || '').toLowerCase();
          if (testId.includes('amount-select-increment')) return true;
          if (testId.includes('counter-increase') || testId.includes('add-to-cart')) return true;
          if (label === 'добавить' || label === 'add' || /^в\s+корзину$/.test(label)) return true;
          return false;
        });
        if (!cands.length) return null;
        cands.sort((a, b) => score(b) - score(a) || a.ref - b.ref);
        return cands[0] || null;
      };

      const tryForceAddTargetFriesAndCheckout = async (): Promise<boolean> => {
        const exec = this.toolExecutor;
        if (!exec || !targetFriesMediumRequested || !lastRestaurantUrl) return false;

        let searchUrl = lastRestaurantUrl;
        try {
          const u = new URL(lastRestaurantUrl);
          u.searchParams.set('search', 'Картофель Фри Средний');
          searchUrl = u.toString();
        } catch {
          // keep original url
        }

        const preNote = `Target item missing in checkout. Re-adding via targeted search: ${searchUrl}`;
        this.log('info', preNote);
        const nav = await exec.execute('navigate', { url: searchUrl });
        currentPageState = nav.pageState
          ? formatPageState(nav.pageState)
          : formatPageState(await exec.snapshotPageState());
        contextManager.addStep(currentPageState, `[AUTO] navigate("${searchUrl}")`, preNote);
        actionHistory.push({ name: 'navigate', argsJson: JSON.stringify({ url: searchUrl }), url: searchUrl });
        if (actionHistory.length > maxActionHistory) actionHistory.shift();

        await exec.execute('wait', { ms: 1200 });

        let state = await exec.snapshotPageState();
        currentPageState = formatPageState(state);
        let target = pickTargetFriesMedium(state.elements);
        let targetSelectionSucceeded = false;
        if (!target) {
          target = await tryFindTargetFriesMedium();
          state = await exec.snapshotPageState();
          currentPageState = formatPageState(state);
        }
        if (target) {
          const clickRes = await exec.execute('click', { ref: target.ref });
          const clickObs = clickRes.output.substring(0, 300);
          this.log('observation', clickObs + (clickRes.output.length > 300 ? '...' : ''));
          state = clickRes.pageState || (await exec.snapshotPageState());
          currentPageState = formatPageState(state);
          if (clickRes.output.startsWith('Clicked element [ref:')) {
            lastTargetItemSelectionAt = Date.now();
            lastSelectedProductLabel = normalizeLabel(target);
            targetSelectionSucceeded = true;
          }
        }

        let addEl = pickAddToCartCandidate(state.elements);
        if (!addEl) {
          const foundAdd = await exec.execute('find_elements', { query: 'добавить', maxResults: 8 });
          state = foundAdd.pageState || (await exec.snapshotPageState());
          currentPageState = formatPageState(state);
          addEl = pickAddToCartCandidate(state.elements);
        }
        if (!addEl) {
          const foundCartBtn = await exec.execute('find_elements', { query: 'в корзину', maxResults: 8 });
          state = foundCartBtn.pageState || (await exec.snapshotPageState());
          currentPageState = formatPageState(state);
          addEl = pickAddToCartCandidate(state.elements);
        }
        if (!addEl) return false;

        const addRes = await exec.execute('click', { ref: addEl.ref });
        const addObs = addRes.output.substring(0, 300);
        this.log('observation', addObs + (addRes.output.length > 300 ? '...' : ''));
        state = addRes.pageState || (await exec.snapshotPageState());
        currentPageState = formatPageState(state);
        if (addRes.output.startsWith('Clicked element [ref:') && targetSelectionSucceeded) {
          markTargetFriesAddEvidence('forced_recovery_add');
        }

        await exec.execute('press_key', { key: 'Escape' });
        await exec.execute('wait', { ms: 600 });

        const openedCheckout = await tryAutoOpenCart('Detected forced target-fries add click.', state.url || searchUrl);
        if (!openedCheckout) return false;

        state = await exec.snapshotPageState();
        currentPageState = formatPageState(state);
        return hasLikelyTargetFriesInOrder(state);
      };

      // === ReAct Loop ===
      for (let step = 0; step < 50; step++) {
        if (this.abortRequested) {
          this.log('info', 'Agent stopped by user.');
          return 'Agent stopped by user.';
        }

        this.log('info', `--- Step ${step + 1}/50 ---`);

        const loopHint = getLoopHint();
        if (loopHint) {
          // Generic self-healing: if we're stuck repeating the same action, refresh the page state
          // without spending another model call.
          this.log('info', loopHint.message);
          rememberBlocked(loopHint.block);
          const urlNow = (() => {
            try {
              return this.toolExecutor.currentPage.url();
            } catch {
              return '';
            }
          })();

          // Yandex-food specific self-heal: if we loop on finding medium fries, locate and click it directly.
          if (
            targetFriesMediumRequested &&
            loopHint.block.some((r) => {
              if (r.name !== 'find_elements') return false;
              const argsLower = r.argsJson.toLowerCase();
              return /(картоф|french|fries)/.test(argsLower);
            })
          ) {
            const targetEl = await tryFindTargetFriesMedium();
            if (targetEl) {
              const autoNote =
                `Detected loop on medium-fries search. Auto-selecting target item [ref:${targetEl.ref}] ` +
                `"${(targetEl.text || targetEl.ariaLabel || '').trim()}".`;
              this.log('info', autoNote);
              const autoClick = await this.toolExecutor.execute('click', { ref: targetEl.ref });
              const autoObs = autoClick.output.substring(0, 300);
              this.log('observation', autoObs + (autoClick.output.length > 300 ? '...' : ''));
              currentPageState = autoClick.pageState
                ? formatPageState(autoClick.pageState)
                : formatPageState(await this.toolExecutor.snapshotPageState());
              contextManager.addStep(currentPageState, `[AUTO] click({"ref":${targetEl.ref}})`, autoNote);
              actionHistory.push({
                name: 'click',
                argsJson: JSON.stringify({ ref: targetEl.ref }),
                url: autoClick.pageState?.url || urlNow || this.toolExecutor.currentPage.url(),
              });
              if (actionHistory.length > maxActionHistory) actionHistory.shift();
              if (autoClick.output.startsWith('Clicked element [ref:')) {
                lastTargetItemSelectionAt = Date.now();
                lastSelectedProductLabel = normalizeLabel(targetEl);
              }
              if (autoClick.screenshotBase64) lastScreenshot = autoClick.screenshotBase64;
              continue;
            }
          }

          // If we are looping on cart button clicks in Yandex Eda restaurant page,
          // force a structured cart->checkout attempt (instead of blind /checkout navigation).
          const cartClickInYandexRestaurant = loopHint.block.some((r) => {
            if (r.name !== 'click') return false;
            if (!/https?:\/\/eda\.yandex\.[^/]+\/r\//i.test(r.url)) return false;
            try {
              const args = JSON.parse(r.argsJson || '{}');
              const ref = Number(args?.ref);
              if (!Number.isFinite(ref)) return false;
              const el = getElementForRef(ref);
              return isGoToCartControl(el);
            } catch {
              return false;
            }
          });
          if (cartClickInYandexRestaurant) {
            const note = 'Detected loop on cart-button clicks. Trying cart->checkout progression with cart validation.';
            this.log('info', note);
            const opened = await tryAutoOpenCart(note, urlNow);
            if (opened) continue;
          }

          // If we're stuck inside a Gmail thread view, browser_back() is usually the safest way
          // to return to the inbox list without hardcoding site UI selectors.
          const shouldBackOutOfGmailThread =
            isGmailTask &&
            urlNow.includes('mail.google.com') &&
            urlNow.includes('#inbox/') &&
            !urlNow.endsWith('#inbox/');

          const recoveryTool = shouldBackOutOfGmailThread ? 'browser_back' : 'get_page_content';
          const recovery = await this.toolExecutor.execute(recoveryTool, {});
          const obsPreview = recovery.output.substring(0, 300);
          this.log('observation', obsPreview + (recovery.output.length > 300 ? '...' : ''));
          if (recovery.pageState) {
            currentPageState = formatPageState(recovery.pageState);
          } else {
            currentPageState = formatPageState(await this.toolExecutor.snapshotPageState());
          }
          contextManager.addStep(
            currentPageState,
            `[AUTO] ${recoveryTool}()`,
            loopHint.message
          );
          actionHistory.push({ name: recoveryTool, argsJson: '{}', url: this.toolExecutor.currentPage.url() });
          if (actionHistory.length > maxActionHistory) actionHistory.shift();
          continue;
        }

        // Task guardrails (cheap pre-checks to avoid wasting model steps).
        // For Gmail tasks: never try to type credentials, and avoid leaving the mail.google.com domain.
        const urlAtStepStart = (() => {
          try {
            return this.toolExecutor.currentPage.url();
          } catch {
            return '';
          }
        })();
        if (urlAtStepStart && /https?:\/\/eda\.yandex\.[^/]+\/r\//i.test(urlAtStepStart)) {
          lastRestaurantUrl = urlAtStepStart;
        }
        if (targetFriesMediumRequested && isInvalidYandexCartUrl(urlAtStepStart)) {
          if (invalidCartRecoveryAttempts >= invalidCartRecoveryLimit) {
            const failNote =
              'Не удалось перейти к оформлению: Яндекс Еда возвращает redirectFrom=invalid_cart даже после повторных попыток.';
            this.log('error', failNote);
            return failNote;
          }

          invalidCartRecoveryAttempts += 1;
          const note =
            `Detected Yandex invalid_cart redirect (${invalidCartRecoveryAttempts}/${invalidCartRecoveryLimit}). ` +
            'Returning to restaurant and retrying add-to-cart flow.';
          this.log('info', note);

          recentSideEffectClicks.clear();
          sideEffectClickedOnce.clear();
          lastTargetItemSelectionAt = 0;
          lastSelectedProductLabel = '';
          targetFriesAddEvidenceCount = 0;
          lastTargetFriesAddEvidenceAt = 0;

          const recoverUrl = lastRestaurantUrl || 'https://eda.yandex.ru/spb?shippingType=delivery';
          const nav = await this.toolExecutor.execute('navigate', { url: recoverUrl });
          const navObs = nav.output.substring(0, 300);
          this.log('observation', navObs + (nav.output.length > 300 ? '...' : ''));
          currentPageState = nav.pageState
            ? formatPageState(nav.pageState)
            : formatPageState(await this.toolExecutor.snapshotPageState());
          contextManager.addStep(currentPageState, `[AUTO] navigate("${recoverUrl}")`, note);
          actionHistory.push({ name: 'navigate', argsJson: JSON.stringify({ url: recoverUrl }), url: recoverUrl });
          if (actionHistory.length > maxActionHistory) actionHistory.shift();
          continue;
        }

        // Generic auth guard: for login/SSO pages, require manual login.
        if (urlAtStepStart && isYandexLoginUrl(urlAtStepStart)) {
          const question =
            'Login page detected. Please complete login manually in the browser window (do NOT paste credentials here), then type "done" here.';
          this.log('ask_user', question);
          const answerRaw = (await this.waitForUserAnswer()).trim();
          if (answerRaw === '[CANCELLED]') {
            this.log('info', 'Agent stopped by user.');
            return 'Agent stopped by user.';
          }
          this.log('info', `User answered: ${answerRaw}`);
          currentPageState = formatPageState(await this.toolExecutor.snapshotPageState());
          contextManager.addStep(currentPageState, 'login_wait()', `User completed manual login step: ${answerRaw}`);
          actionHistory.push({ name: 'ask_user', argsJson: JSON.stringify({ question }), url: urlAtStepStart });
          if (actionHistory.length > maxActionHistory) actionHistory.shift();
          continue;
        }

        if (isGmailTask) {
          const urlNow = (() => {
            try {
              return this.toolExecutor.currentPage.url();
            } catch {
              return '';
            }
          })();

          if (urlNow && isGoogleLoginUrl(urlNow)) {
            const question =
              'Gmail requires manual sign-in. Please log in (and complete 2FA if needed) in the browser window, then type "done" here.';
            this.log('ask_user', question);
            const answer = (await this.waitForUserAnswer()).trim();
            if (answer === '[CANCELLED]') {
              this.log('info', 'Agent stopped by user.');
              return 'Agent stopped by user.';
            }
            this.log('info', `User answered: ${answer}`);
            currentPageState = formatPageState(await this.toolExecutor.snapshotPageState());
            contextManager.addStep(currentPageState, 'login_wait()', `User sign-in step: ${answer}`);
            actionHistory.push({ name: 'ask_user', argsJson: JSON.stringify({ question }), url: urlNow });
            if (actionHistory.length > maxActionHistory) actionHistory.shift();
            continue;
          }

          const hostNow = safeHost(urlNow);
          if (hostNow && !allowedHostsForGmailTask.has(hostNow)) {
            const note = `Out of scope for email task: currently on ${hostNow}. Returning to Gmail.`;
            this.log('info', note);
            const navRes = await this.toolExecutor.execute('navigate', { url: 'https://mail.google.com' });
            const navObs = navRes.output.substring(0, 300);
            this.log('observation', navObs + (navRes.output.length > 300 ? '...' : ''));

            if (navRes.isAskUser) {
              this.log('ask_user', navRes.askUserQuestion || 'Need input');
              const userAnswer = await this.waitForUserAnswer();
              if (userAnswer.trim() === '[CANCELLED]') {
                this.log('info', 'Agent stopped by user.');
                return 'Agent stopped by user.';
              }
              this.log('info', `User answered: ${userAnswer}`);
              const refreshed = await this.toolExecutor.execute('get_page_content', {});
              currentPageState = refreshed.pageState
                ? formatPageState(refreshed.pageState)
                : formatPageState(await this.toolExecutor.snapshotPageState());
              contextManager.addStep(
                currentPageState,
                `[AUTO] navigate("https://mail.google.com")`,
                `${note}\nUser solved CAPTCHA/manual step: ${userAnswer}`
              );
              actionHistory.push({ name: 'navigate', argsJson: JSON.stringify({ url: 'https://mail.google.com' }), url: this.toolExecutor.currentPage.url() });
              if (actionHistory.length > maxActionHistory) actionHistory.shift();
              continue;
            }

            currentPageState = navRes.pageState
              ? formatPageState(navRes.pageState)
              : formatPageState(await this.toolExecutor.snapshotPageState());
            contextManager.addStep(currentPageState, `[AUTO] navigate("https://mail.google.com")`, note);
            actionHistory.push({ name: 'navigate', argsJson: JSON.stringify({ url: 'https://mail.google.com' }), url: this.toolExecutor.currentPage.url() });
            if (actionHistory.length > maxActionHistory) actionHistory.shift();
            continue;
          }
        }

        if (!yandexCartPreparedForRun && targetFriesMediumRequested) {
          await tryPrepareFreshYandexCart();
          if (yandexCartPreparedForRun) {
            const afterPrep = await this.toolExecutor.execute('get_page_content', {});
            currentPageState = afterPrep.pageState
              ? formatPageState(afterPrep.pageState)
              : formatPageState(await this.toolExecutor.snapshotPageState());
            contextManager.addStep(
              currentPageState,
              '[AUTO] yandex_cart_cleanup()',
              'Prepared a clean Yandex Eda cart before selecting target fries.'
            );
            actionHistory.push({ name: 'yandex_cart_cleanup', argsJson: '{}', url: this.toolExecutor.currentPage.url() });
            if (actionHistory.length > maxActionHistory) actionHistory.shift();
            continue;
          }
        }

        // Build messages
        let messages: ChatCompletionMessageParam[];
        if (lastScreenshot) {
          messages = contextManager.buildMessagesWithScreenshot(currentPageState, lastScreenshot);
          lastScreenshot = undefined;
        } else {
          messages = contextManager.buildMessages(currentPageState);
        }

        // Call OpenAI
        this.log('thought', 'Thinking...');

        let response;
        const modelLower = this.model.toLowerCase();
        const baseTimeoutMs = modelLower.includes('turbo') ? 90_000 : 60_000;
        const maxAttempts = 3;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          try {
            response = await this.openai.chat.completions.create(
              {
                model: this.model,
                messages,
                tools: AGENT_TOOLS,
                tool_choice: 'required',
                max_tokens: 512,
                temperature: 0.1,
              },
              { timeout: baseTimeoutMs, maxRetries: 0 }
            );
            break;
          } catch (err: any) {
            const status = err?.status;
            const name = err?.name || 'APIError';
            const msg = err?.message || String(err);

            // Non-retriable auth/config errors.
            if (status === 401 || status === 403) {
              this.log('error', `${name}: ${msg}`);
              return 'Agent failed: API key is invalid or has insufficient permissions.';
            }

            const isLast = attempt === maxAttempts;
            this.log('error', `API error (attempt ${attempt}/${maxAttempts}): ${name}: ${msg}`);
            if (isLast) {
              return `Agent failed: OpenAI API request failed (${name}): ${msg}`;
            }

            // Backoff for transient errors.
            const backoffMs = status === 429 ? 8_000 : 1_000 * attempt * attempt;
            await this.sleep(backoffMs);
          }
        }

        if (!response) {
          this.log('error', 'No response from model (after retries).');
          return 'Agent failed: no response from model.';
        }

        const choice = response.choices[0];
        if (!choice) {
          this.log('error', 'No response from model.');
          return 'Agent failed: no response from model.';
        }

        const message = choice.message;

        if (message.content) {
          this.log('thought', message.content);
        }

        // No tool calls — model returned text without calling any tool
        if (!message.tool_calls || message.tool_calls.length === 0) {
          // Check if model thinks it's done (finish_reason='stop')
          if (choice.finish_reason === 'stop') {
            const content = message.content || '';
            // Only accept as real completion if:
            // 1. At least 8 meaningful steps have been taken
            // 2. The text doesn't look like a plan/reasoning
            if (step >= 8 && !this.isDonePremature(content)) {
              this.log('result', content || 'Agent finished.');
              return content || 'Agent completed.';
            }
            // Otherwise: model stopped prematurely — force it to continue
            this.log('info', `Model stopped without calling a tool (step ${step + 1}). Forcing continuation...`);
          }
          // Re-extract page and continue the loop
          currentPageState = formatPageState(await this.toolExecutor.snapshotPageState());
          // Inject a nudge into context so the model knows to keep going
          contextManager.addStep(
            currentPageState,
            '[NO ACTION — model did not call a tool]',
            'The task is NOT complete yet. You MUST call a tool to take the next action. Do NOT stop without using done() tool explicitly.'
          );
          continue;
        }

        // Execute at most ONE tool call per step.
        const toolCall = message.tool_calls[0];
        if (message.tool_calls.length > 1) {
          this.log(
            'info',
            `Model returned ${message.tool_calls.length} tool calls; executing only the first (${toolCall.function.name}).`
          );
        }

        const fnName = toolCall.function.name;
        let fnArgs: Record<string, any>;
        try {
          fnArgs = JSON.parse(toolCall.function.arguments);
        } catch {
          fnArgs = {};
        }

        const urlNowForAction = (() => {
          try {
            return this.toolExecutor.currentPage.url();
          } catch {
            return '';
          }
        })();

        // Hard block for detected click-loops: if the model insists on repeating the exact same click on the same URL,
        // override it with a safe diagnostic action so it can reassess.
        if (fnName === 'click' && urlNowForAction) {
          const actionRec: ActionRecord = { name: fnName, argsJson: JSON.stringify(fnArgs), url: urlNowForAction };
          const actionKey = toActionKey(actionRec);
          const blockedUntil = blockedActionKeys.get(actionKey);
          if (blockedUntil && Date.now() < blockedUntil) {
            const now = Date.now();
            const lastDiagAt = diagActionLastAt.get(actionKey) || 0;

            // Avoid screenshot spam if the model keeps insisting on the same blocked click.
            // First time: take a screenshot for visual context. Next times within cooldown: just refresh page state.
            const useScreenshot = now - lastDiagAt > diagCooldownMs;
            diagActionLastAt.set(actionKey, now);

            const note = useScreenshot
              ? `Blocked repeated action due to loop: ${fnName}(${actionRec.argsJson}) on ${urlNowForAction}. Taking screenshot to reassess.`
              : `Blocked repeated action due to loop: ${fnName}(${actionRec.argsJson}) on ${urlNowForAction}. Refreshing page content to reassess (screenshot throttled).`;
            this.log('info', note);

            const diag = await this.toolExecutor.execute(useScreenshot ? 'screenshot' : 'get_page_content', {});
            const obsPreview = diag.output.substring(0, 300);
            this.log('observation', obsPreview + (diag.output.length > 300 ? '...' : ''));
            if (diag.pageState) currentPageState = formatPageState(diag.pageState);
            contextManager.addStep(
              currentPageState,
              `[AUTO] ${useScreenshot ? 'screenshot' : 'get_page_content'}()`,
              note
            );
            actionHistory.push({
              name: useScreenshot ? 'screenshot' : 'get_page_content',
              argsJson: '{}',
              url: diag.pageState?.url || urlNowForAction,
            });
            if (actionHistory.length > maxActionHistory) actionHistory.shift();
            if (useScreenshot && diag.screenshotBase64) lastScreenshot = diag.screenshotBase64;
            continue;
          }
        }

        // Security gate for destructive actions (payment, deletion, sending) + external navigation for email tasks.
        if (fnName === 'click' && typeof fnArgs.ref === 'number') {
          const el = getElementForRef(fnArgs.ref);
          const labelLower = normalizeLabel(el);
          const urlNow = urlNowForAction;

          if (targetFriesMediumRequested && isPotatoCategorySection(el)) {
            const now = Date.now();
            if (now - lastPotatoCategoryClickAt < 6_000) {
              potatoCategoryClickStreak += 1;
            } else {
              potatoCategoryClickStreak = 1;
            }
            lastPotatoCategoryClickAt = now;

            if (potatoCategoryClickStreak >= 2) {
              const note = 'Blocked repeated click on "Картофель, стартеры и салаты". Looking for "Картофель Фри Средний" directly.';
              this.log('info', note);
              const targetEl = await tryFindTargetFriesMedium();
              if (targetEl) {
                const autoNote = `${note} Auto-selecting target item [ref:${targetEl.ref}] "${(targetEl.text || targetEl.ariaLabel || '').trim()}".`;
                this.log('info', autoNote);
                const autoClick = await this.toolExecutor.execute('click', { ref: targetEl.ref });
                const autoObs = autoClick.output.substring(0, 300);
                this.log('observation', autoObs + (autoClick.output.length > 300 ? '...' : ''));
                currentPageState = autoClick.pageState
                  ? formatPageState(autoClick.pageState)
                  : formatPageState(await this.toolExecutor.snapshotPageState());
                contextManager.addStep(currentPageState, `[AUTO] click({"ref":${targetEl.ref}})`, autoNote);
                actionHistory.push({
                  name: 'click',
                  argsJson: JSON.stringify({ ref: targetEl.ref }),
                  url: autoClick.pageState?.url || this.toolExecutor.currentPage.url(),
                });
                if (actionHistory.length > maxActionHistory) actionHistory.shift();
                if (autoClick.output.startsWith('Clicked element [ref:')) {
                  lastTargetItemSelectionAt = Date.now();
                  lastSelectedProductLabel = normalizeLabel(targetEl);
                }
                if (autoClick.screenshotBase64) lastScreenshot = autoClick.screenshotBase64;
                continue;
              }
            }
          } else {
            potatoCategoryClickStreak = 0;
          }

          if (!addressChangeRequested && looksLikeAddressHeader(el)) {
            const note =
              `Blocked click "${(el?.text || el?.ariaLabel || '').trim()}" because it looks like an address header and the task does not require changing address.`;
            this.log('info', note);
            const openedCart = await tryAutoOpenCart(note, urlNow);
            if (openedCart) continue;
            currentPageState = formatPageState(await this.toolExecutor.snapshotPageState());
            contextManager.addStep(currentPageState, `click(${JSON.stringify(fnArgs)}) [BLOCKED_ADDRESS]`, note);
            actionHistory.push({ name: 'click_blocked_address', argsJson: JSON.stringify(fnArgs), url: urlNow });
            if (actionHistory.length > maxActionHistory) actionHistory.shift();
            continue;
          }

          if (isGoToCartControl(el) && /https?:\/\/eda\.yandex\.[^/]+\/r\//i.test(urlNow)) {
            if (targetFriesMediumRequested && !hasFreshTargetFriesEvidence()) {
              const note = `Blocked premature cart click "${(el?.text || el?.ariaLabel || '').trim()}": target fries add is not confirmed yet.`;
              this.log('info', note);
              currentPageState = formatPageState(await this.toolExecutor.snapshotPageState());
              contextManager.addStep(currentPageState, `click(${JSON.stringify(fnArgs)}) [BLOCKED_PREMATURE_CART]`, note);
              actionHistory.push({ name: 'click_blocked_premature_cart', argsJson: JSON.stringify(fnArgs), url: urlNow });
              if (actionHistory.length > maxActionHistory) actionHistory.shift();
              continue;
            }
            const note =
              `Intercepted cart control "${(el?.text || el?.ariaLabel || '').trim()}". Trying cart->checkout progression instead of direct /checkout.`;
            this.log('info', note);
            const opened = await tryAutoOpenCart(note, urlNow);
            if (opened) continue;
          }

          if (targetFriesMediumRequested && isFriesButNotMedium(el)) {
            const note =
              `Blocked click "${(el?.text || el?.ariaLabel || '').trim()}" because task requires medium fries only.`;
            this.log('info', note);
            const targetEl = await tryFindTargetFriesMedium();
            if (targetEl) {
              const autoNote = `${note} Auto-selecting target item [ref:${targetEl.ref}] "${(targetEl.text || targetEl.ariaLabel || '').trim()}".`;
              this.log('info', autoNote);
              const autoClick = await this.toolExecutor.execute('click', { ref: targetEl.ref });
              const autoObs = autoClick.output.substring(0, 300);
              this.log('observation', autoObs + (autoClick.output.length > 300 ? '...' : ''));
              currentPageState = autoClick.pageState
                ? formatPageState(autoClick.pageState)
                : formatPageState(await this.toolExecutor.snapshotPageState());
              contextManager.addStep(currentPageState, `[AUTO] click({"ref":${targetEl.ref}})`, autoNote);
              actionHistory.push({
                name: 'click',
                argsJson: JSON.stringify({ ref: targetEl.ref }),
                url: autoClick.pageState?.url || this.toolExecutor.currentPage.url(),
              });
              if (actionHistory.length > maxActionHistory) actionHistory.shift();
              if (autoClick.output.startsWith('Clicked element [ref:')) {
                lastTargetItemSelectionAt = Date.now();
                lastSelectedProductLabel = normalizeLabel(targetEl);
              }
              if (autoClick.screenshotBase64) lastScreenshot = autoClick.screenshotBase64;
              continue;
            }
            currentPageState = formatPageState(await this.toolExecutor.snapshotPageState());
            contextManager.addStep(currentPageState, `click(${JSON.stringify(fnArgs)}) [BLOCKED_NON_TARGET_SIZE]`, note);
            actionHistory.push({ name: 'click_blocked_non_target_size', argsJson: JSON.stringify(fnArgs), url: urlNow });
            if (actionHistory.length > maxActionHistory) actionHistory.shift();
            continue;
          }

          // Constraint guard: if the user requested "no sauce/no extras", block selecting sauce/add-ons.
          if (noExtrasRequested && isSauceLike(labelLower) && !isNoSauceOption(labelLower)) {
            const isAdd = isAddToCartControl(el);

            // If it's an add-to-cart control, allow it: enforce "no sauce" by not selecting sauce options.
            // Some UIs include sauce names inside the accessible label for the add button/card, so blocking here
            // would deadlock the flow.
            if (!isAdd) {
              const note = `Blocked click "${(el?.text || el?.ariaLabel || '').trim()}" because the task requires NO sauces/add-ons. Find a "без соуса/не нужен/none" option (use find_elements("без соуса")) or proceed without selecting extras.`;
              this.log('info', note);
              currentPageState = formatPageState(await this.toolExecutor.snapshotPageState());
              contextManager.addStep(currentPageState, `click(${JSON.stringify(fnArgs)}) [BLOCKED_EXTRAS]`, note);
              actionHistory.push({ name: 'click_blocked_extras', argsJson: JSON.stringify(fnArgs), url: urlNow });
              if (actionHistory.length > maxActionHistory) actionHistory.shift();
              continue;
            }
          }

          // For "Картофель Фри Средний" tasks, prevent blind clicks on generic "В корзину":
          // the model must first focus/select the target medium fries item.
          if (targetFriesMediumRequested && isAddToCartControl(el)) {
            const recentlySelectedTarget = Date.now() - lastTargetItemSelectionAt < targetSelectionTtlMs;
            if (!recentlySelectedTarget) {
              const note =
                'Blocked generic add-to-cart click: select "Картофель Фри Средний" first, then add it once.';
              this.log('info', note);
              const refreshed = await this.toolExecutor.execute('get_page_content', {});
              currentPageState = refreshed.pageState
                ? formatPageState(refreshed.pageState)
                : formatPageState(await this.toolExecutor.snapshotPageState());
              let targetEl = refreshed.pageState ? pickTargetFriesMedium(refreshed.pageState.elements) : null;
              if (!targetEl) {
                targetEl = await tryFindTargetFriesMedium();
              }
              if (targetEl) {
                const autoNote = `${note} Auto-selecting target item [ref:${targetEl.ref}] "${(targetEl.text || targetEl.ariaLabel || '').trim()}".`;
                this.log('info', autoNote);
                const autoClick = await this.toolExecutor.execute('click', { ref: targetEl.ref });
                const autoObs = autoClick.output.substring(0, 300);
                this.log('observation', autoObs + (autoClick.output.length > 300 ? '...' : ''));
                currentPageState = autoClick.pageState
                  ? formatPageState(autoClick.pageState)
                  : formatPageState(await this.toolExecutor.snapshotPageState());
                contextManager.addStep(currentPageState, `[AUTO] click({"ref":${targetEl.ref}})`, autoNote);
                actionHistory.push({
                  name: 'click',
                  argsJson: JSON.stringify({ ref: targetEl.ref }),
                  url: autoClick.pageState?.url || this.toolExecutor.currentPage.url(),
                });
                if (actionHistory.length > maxActionHistory) actionHistory.shift();
                if (autoClick.output.startsWith('Clicked element [ref:')) {
                  lastTargetItemSelectionAt = Date.now();
                  lastSelectedProductLabel = normalizeLabel(targetEl);
                }
                if (autoClick.screenshotBase64) lastScreenshot = autoClick.screenshotBase64;
                continue;
              }
              contextManager.addStep(currentPageState, `click(${JSON.stringify(fnArgs)}) [BLOCKED_NEEDS_TARGET_SELECTION]`, note);
              actionHistory.push({ name: 'click_blocked_needs_target_selection', argsJson: JSON.stringify(fnArgs), url: urlNow });
              if (actionHistory.length > maxActionHistory) actionHistory.shift();
              continue;
            }
          }

          // Safety: prevent accidental duplicate "add to cart" clicks (often increases quantity).
          const sideEffectKey = computeSideEffectKey(el, urlNow);
          if (sideEffectKey && !wantsMultipleUnits) {
            if (sideEffectClickedOnce.has(sideEffectKey)) {
              const note =
                `Blocked repeated add-to-cart click for "${(el?.text || el?.ariaLabel || '').trim()}": ` +
                'this control was already used once. Proceed to cart/checkout instead of increasing quantity.';
              this.log('info', note);
              const openedCart = await tryAutoOpenCart(note, urlNow);
              if (openedCart) continue;

              currentPageState = formatPageState(await this.toolExecutor.snapshotPageState());

              contextManager.addStep(currentPageState, `click(${JSON.stringify(fnArgs)}) [BLOCKED_DUPLICATE_ONCE]`, note);
              actionHistory.push({ name: 'click_blocked_duplicate_once', argsJson: JSON.stringify(fnArgs), url: urlNow });
              if (actionHistory.length > maxActionHistory) actionHistory.shift();
              continue;
            }
            const lastAt = recentSideEffectClicks.get(sideEffectKey);
            if (lastAt && Date.now() - lastAt < sideEffectTtlMs) {
              const note = `Prevented duplicate add-to-cart click for "${(el?.text || el?.ariaLabel || '').trim()}". Verify the cart before clicking again.`;
              this.log('info', note);
              const refreshed = await this.toolExecutor.execute('get_page_content', {});
              currentPageState = refreshed.pageState
                ? formatPageState(refreshed.pageState)
                : formatPageState(await this.toolExecutor.snapshotPageState());
              contextManager.addStep(currentPageState, `click(${JSON.stringify(fnArgs)}) [BLOCKED_DUPLICATE]`, note);
              actionHistory.push({ name: 'click_blocked_duplicate', argsJson: JSON.stringify(fnArgs), url: urlNow });
              if (actionHistory.length > maxActionHistory) actionHistory.shift();
              continue;
            }
          }

          // Guard: on email tasks, don't follow external links out of Gmail unless user explicitly approves.
          if (isGmailTask && el?.tag === 'a' && el.href) {
            const hrefHost = safeHost(el.href);
            if (hrefHost && !allowedHostsForGmailTask.has(hrefHost)) {
              const question = `Security check: this link may navigate outside Gmail (${hrefHost}). Type "yes" (or "да") to allow, anything else to cancel.`;
              this.log('ask_user', question);
              const answer = (await this.waitForUserAnswer()).trim().toLowerCase();
              if (answer === '[cancelled]') {
                this.log('info', 'Agent stopped by user.');
                return 'Agent stopped by user.';
              }
              this.log('info', `User answered: ${answer}`);
              const allowed = answer === 'yes' || answer === 'да';
              contextManager.addStep(
                currentPageState,
                `security_confirm("external_navigation")`,
                allowed ? `User approved external navigation to ${hrefHost}` : `User cancelled external navigation to ${hrefHost}`
              );
              if (!allowed) {
                currentPageState = formatPageState(await this.toolExecutor.snapshotPageState());
                continue;
              }
            }
          }

          const gate = getSecurityGateForClick(el);
          if (gate) {
            const approveKey = `${gate.kind}|${gate.label}|${this.toolExecutor.currentPage.url()}`;
            let skipDefaultGatePrompt = false;

            if (gate.kind === 'payment/order' && stopBeforePaymentRequested) {
              const verifyState = await this.toolExecutor.snapshotPageState();
              currentPageState = formatPageState(verifyState);
              let hasTargetInOrder = hasTargetFriesMediumInState(verifyState);
              let hasLikelyTargetInOrder = hasLikelyTargetFriesInOrder(verifyState);

              if (!hasTargetInOrder && targetFriesMediumRequested) {
                const foundTarget = await this.toolExecutor.execute('find_elements', {
                  query: 'Картофель Фри Средний',
                  maxResults: 8,
                });
                const foundState = foundTarget.pageState || (await this.toolExecutor.snapshotPageState());
                currentPageState = formatPageState(foundState);
                hasTargetInOrder = hasTargetFriesMediumInState(foundState);
                hasLikelyTargetInOrder = hasLikelyTargetFriesInOrder(foundState);
              }

              if (targetFriesMediumRequested && !hasTargetInOrder) {
                if (hasLikelyTargetInOrder) {
                  const note =
                    'Target item text is not explicitly visible in checkout, but cart signals and add evidence were detected. Proceeding to final confirmation.';
                  this.log('info', note);
                  contextManager.addStep(currentPageState, `payment_verify()[LIKELY_TARGET_PRESENT]`, note);
                } else if (targetFriesRecoveryAttempts < targetFriesRecoveryLimit) {
                  targetFriesRecoveryAttempts += 1;
                  const note =
                    'Blocked payment: target item "Картофель Фри Средний" was not detected in cart/checkout. Re-adding it before final confirmation.';
                  this.log('info', note);
                  contextManager.addStep(currentPageState, `payment_verify()[BLOCKED_MISSING_TARGET_ITEM]`, note);
                  actionHistory.push({ name: 'payment_verify_blocked_missing_target', argsJson: '{}', url: urlNow });
                  if (actionHistory.length > maxActionHistory) actionHistory.shift();

                  const recovered = await tryForceAddTargetFriesAndCheckout();
                  if (recovered) {
                    const okNote = 'Target fries item was re-added and checkout reopened. Continuing to final confirmation step.';
                    this.log('info', okNote);
                    contextManager.addStep(currentPageState, `recovery_add_target_item()`, okNote);
                  } else {
                    const failNote =
                      'Failed to auto re-add target fries item. Recovery limit reached, proceeding to final confirmation without further loops.';
                    this.log('info', failNote);
                    contextManager.addStep(currentPageState, `recovery_add_target_item()[FAILED]`, failNote);
                  }
                  continue;
                } else {
                  const note =
                    'Could not verify that "Картофель Фри Средний" is present in checkout after recovery. Stopping before payment to avoid confirming an incorrect order.';
                  this.log('error', note);
                  contextManager.addStep(currentPageState, `payment_verify()[RECOVERY_LIMIT_REACHED]`, note);
                  return 'Не удалось подтвердить, что "Картофель Фри Средний" добавлен в корзину. Остановлено до оплаты.';
                }
              }

              const question =
                'Reached the final step before payment. Разрешить оплату сейчас? Type "yes" (or "да") to pay, anything else to stop before payment.';
              this.log('ask_user', question);
              const answer = (await this.waitForUserAnswer()).trim().toLowerCase();
              if (answer === '[cancelled]') {
                this.log('info', 'Agent stopped by user.');
                return 'Agent stopped by user.';
              }
              this.log('info', `User answered: ${answer}`);

              const allowed = answer === 'yes' || answer === 'да';
              contextManager.addStep(
                currentPageState,
                `payment_confirm_before_stop()`,
                allowed
                  ? `User approved payment click: "${gate.label}"`
                  : `User chose to stop before payment on "${gate.label}"`
              );

              if (!allowed) {
                this.log('result', 'Остановился на последнем шаге перед оплатой по подтверждению пользователя.');
                return 'Остановился на последнем шаге перед оплатой по подтверждению пользователя.';
              }

              approvedSecurityActions.add(approveKey);
              awaitingPaymentClickResult = true;
              skipDefaultGatePrompt = true;
            }

            if (!skipDefaultGatePrompt && !approvedSecurityActions.has(approveKey)) {
              const question = `Security check: agent is about to click "${gate.label}" (${gate.kind}). Type "yes" (or "да") to allow, anything else to cancel.`;
              this.log('ask_user', question);
              const answer = (await this.waitForUserAnswer()).trim().toLowerCase();
              if (answer === '[cancelled]') {
                this.log('info', 'Agent stopped by user.');
                return 'Agent stopped by user.';
              }
              this.log('info', `User answered: ${answer}`);

              const allowed = answer === 'yes' || answer === 'да';
              contextManager.addStep(
                currentPageState,
                `security_confirm("${gate.kind}")`,
                allowed ? `User approved click: "${gate.label}"` : `User cancelled click: "${gate.label}"`
              );

              if (!allowed) {
                currentPageState = formatPageState(await this.toolExecutor.snapshotPageState());
                continue;
              }

              approvedSecurityActions.add(approveKey);
              if (gate.kind === 'payment/order') {
                awaitingPaymentClickResult = true;
              }
            }
          }
        }

        const result: ToolResult = await this.toolExecutor.execute(fnName, fnArgs);

        // Log observation (truncated)
        const obsPreview = result.output.substring(0, 300);
        this.log('observation', obsPreview + (result.output.length > 300 ? '...' : ''));

        if (fnName === 'click' && awaitingPaymentClickResult) {
          awaitingPaymentClickResult = false;
          const verifyState = result.pageState || (await this.toolExecutor.snapshotPageState());
          currentPageState = formatPageState(verifyState);
          const targetPresent = hasTargetFriesMediumInState(verifyState) || hasLikelyTargetFriesInOrder(verifyState);

          if (result.output.startsWith('Clicked element [ref:')) {
            const doneMessage = 'Оплата подтверждена пользователем: кнопка оплаты нажата.';
            this.log('result', doneMessage);
            return doneMessage;
          }

          if (/Failed to click/i.test(result.output) && /disabled/i.test(result.output)) {
            const message = targetPresent
              ? 'Кнопка оплаты недоступна (disabled). Заказ оставлен на шаге перед оплатой.'
              : 'Кнопка оплаты недоступна, и не удалось подтвердить наличие "Картофель Фри Средний" в корзине. Остановлено.';
            this.log(targetPresent ? 'result' : 'error', message);
            return message;
          }

          const failMessage = targetPresent
            ? 'Не удалось выполнить клик по оплате. Заказ оставлен на шаге перед оплатой.'
            : 'Не удалось выполнить клик по оплате и подтвердить наличие целевого товара в корзине.';
          this.log(targetPresent ? 'result' : 'error', failMessage);
          return failMessage;
        }

        if (result.isDone) {
          const doneText = result.doneResult || '';
          // Reject done() if: too few steps OR text looks like planning
          if (step < 8 || this.isDonePremature(doneText)) {
            const reason = step < 8
              ? `Too early (step ${step + 1}/50, minimum 8 required)`
              : 'Result text looks like a plan, not a completion';
            this.log('info', `done() REJECTED: ${reason}. Continuing...`);
            currentPageState = formatPageState(await this.toolExecutor.snapshotPageState());
            contextManager.addStep(
              currentPageState,
              `done() [REJECTED]`,
              `done() was rejected: ${reason}. The task is NOT complete. Keep working — call a tool to take the next action.`
            );
            continue;
          }
          this.log('result', doneText || 'Task completed.');
          return doneText || 'Task completed.';
        }

        if (result.isAskUser) {
          this.log('ask_user', result.askUserQuestion || 'Need input');
          const userAnswer = await this.waitForUserAnswer();
          if (userAnswer.trim() === '[CANCELLED]') {
            this.log('info', 'Agent stopped by user.');
            return 'Agent stopped by user.';
          }
          this.log('info', `User answered: ${userAnswer}`);

          const refreshed = await this.toolExecutor.execute('get_page_content', {});
          currentPageState = refreshed.pageState
            ? formatPageState(refreshed.pageState)
            : formatPageState(await this.toolExecutor.snapshotPageState());

          contextManager.addStep(
            currentPageState,
            `${fnName}(${JSON.stringify(fnArgs)}) + user_input`,
            `${result.output}\nUser answered: ${userAnswer}`
          );

          const urlAfter = refreshed.pageState?.url || this.toolExecutor.currentPage.url();
          actionHistory.push({ name: fnName, argsJson: JSON.stringify(fnArgs), url: urlAfter });
          if (actionHistory.length > maxActionHistory) actionHistory.shift();

          continue;
        }

        const urlAfter = result.pageState?.url || this.toolExecutor.currentPage.url();
        actionHistory.push({ name: fnName, argsJson: JSON.stringify(fnArgs), url: urlAfter });
        if (actionHistory.length > maxActionHistory) actionHistory.shift();

        // Mark side-effect clicks as "done recently" so we can prevent accidental duplicates.
        if (fnName === 'click' && typeof fnArgs.ref === 'number') {
          const el = result.clickedElement || getElementForRef(fnArgs.ref);
          const clickSucceeded = result.output.startsWith('Clicked element [ref:');
          if (clickSucceeded) {
            const now = Date.now();
            let addConfirmed = false;
            const addControlClicked = isAddToCartControl(el);
            if (isLikelyProductSelectionControl(el)) {
              lastSelectedProductLabel = normalizeLabel(el);
            }
            if (targetFriesMediumRequested && isTargetFriesMediumElement(el)) {
              lastTargetItemSelectionAt = now;
            }
            if (addControlClicked) {
              const stateAfterClick = result.pageState || (await this.toolExecutor.snapshotPageState());
              addConfirmed = hasNonEmptyCartSignals(stateAfterClick);
              if (!addConfirmed) {
                await this.toolExecutor.execute('wait', { ms: 700 });
                const verify = await this.toolExecutor.execute('get_page_content', {});
                const verifyState = verify.pageState || (await this.toolExecutor.snapshotPageState());
                currentPageState = formatPageState(verifyState);
                addConfirmed = hasNonEmptyCartSignals(verifyState);
              }
            }
            const key = computeSideEffectKey(el, urlAfter);
            if (key) {
              const selectedRecently = now - lastTargetItemSelectionAt < targetSelectionTtlMs;
              const selectedTargetRecently =
                selectedRecently &&
                /(картоф.*фри|french\s*fries|fries)/.test(lastSelectedProductLabel) &&
                /(средн|medium)/.test(lastSelectedProductLabel) &&
                !/(двойн|double|больш|large|мал|small)/.test(lastSelectedProductLabel);
              if (selectedTargetRecently && addConfirmed) {
                markTargetFriesAddEvidence('target_selected_then_add');
              }

              if (addConfirmed) {
                recentSideEffectClicks.set(key, now);
              }
              if (!wantsMultipleUnits && addConfirmed) {
                // First successful add-to-cart should block further quantity increases by default.
                sideEffectClickedOnce.add(key);
              }
              // Cleanup old keys opportunistically.
              for (const [k, t] of recentSideEffectClicks.entries()) {
                if (now - t > sideEffectTtlMs) recentSideEffectClicks.delete(k);
              }
            }

            // Immediately move to cart after add-to-cart to avoid model loops on product cards.
            if (addControlClicked && !wantsMultipleUnits) {
              if (!addConfirmed) {
                const note =
                  'Add-to-cart click did not produce confirmed cart signals yet. Staying on restaurant page for a clean retry.';
                this.log('info', note);
                contextManager.addStep(currentPageState, '[AUTO] add_to_cart_verify()[UNCONFIRMED]', note);
                continue;
              }
              const openedCart = await tryAutoOpenCart('Detected add-to-cart click.', urlAfter);
              if (openedCart) {
                continue;
              }
            }
          }
        }

        if (result.screenshotBase64) {
          lastScreenshot = result.screenshotBase64;
        }

        if (result.pageState) {
          currentPageState = formatPageState(result.pageState);
        }

        contextManager.addStep(
          currentPageState,
          `${fnName}(${JSON.stringify(fnArgs)})`,
          result.output.substring(0, 500)
        );

        if (contextManager.hasReachedLimit) {
          this.log('error', 'Maximum steps (50) reached.');
          return 'Agent stopped: maximum steps reached.';
        }
      }

      return 'Agent completed maximum iterations.';
    } catch (err: any) {
      this.log('error', `Unexpected error: ${err.message}`);
      return `Agent failed: ${err.message}`;
    } finally {
      await this.cleanup();
      this._isRunning = false;
    }
  }

  async stop(): Promise<void> {
    this.abortRequested = true;
    if (this.userAnswerResolve) {
      this.userAnswerResolve('[CANCELLED]');
      this.userAnswerResolve = null;
    }
    // IMPORTANT: don't call cleanup() here while run() is still executing.
    // Otherwise, run() may continue briefly and crash when accessing toolExecutor/currentPage.
    // run() always calls cleanup() in its finally{} block.
    if (!this._isRunning) {
      await this.cleanup();
    }
  }

  provideUserAnswer(answer: string): void {
    if (this.userAnswerResolve) {
      this.userAnswerResolve(answer);
      this.userAnswerResolve = null;
    }
  }

  private waitForUserAnswer(): Promise<string> {
    return new Promise<string>((resolve) => {
      this.userAnswerResolve = resolve;
    });
  }

  private log(type: LogEntry['type'], content: string): void {
    this.logger({ type, content, timestamp: Date.now() });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Detect if the agent called done() prematurely.
   * If the "result" text contains action plans or reasoning language,
   * it means the model confused its thinking with task completion.
   */
  private isDonePremature(text: string): boolean {
    const lower = text.toLowerCase();
    const planIndicators = [
      'i will', 'i need to', 'action:', 'click(', 'type_text(', 'navigate(',
      'scroll(', 'press_key(', 'let me', 'next step', 'to proceed',
      'to continue', 'i should', 'i\'ll now', 'let\'s',
      'я буду', 'нужно', 'далее', 'следующий шаг', 'давайте',
      'я нажму', 'я кликну', 'я введу', 'перейду',
      '[ref:', 'ref:',
    ];
    return planIndicators.some((indicator) => lower.includes(indicator));
  }

  private async cleanup(): Promise<void> {
    try {
      if (this.context) await this.context.close().catch(() => {});
      if (this.browser) await this.browser.close().catch(() => {});
    } catch {
      // Ignore
    }
    this.toolExecutor = null;
    this.context = null;
    this.browser = null;
  }
}
