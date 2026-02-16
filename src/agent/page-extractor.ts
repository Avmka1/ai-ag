import type { Page } from 'playwright';

export interface ElementRef {
  ref: number;
  tag: string;
  type?: string;
  text: string;
  placeholder?: string;
  href?: string;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  ariaDisabled?: string;
  role?: string;
  testId?: string;
  selector: string;
  fallbackSelector?: string;
  ariaLabel?: string;
}

export interface PageState {
  url: string;
  title: string;
  elements: ElementRef[];
  visibleText: string;
  elementCount: number;
}

const selectorMap = new Map<number, string>();
const elementMap = new Map<number, ElementRef>();

export function resetRefs(): void {
  selectorMap.clear();
  elementMap.clear();
}

export function getSelectorForRef(ref: number): string | undefined {
  return selectorMap.get(ref);
}

export function getElementForRef(ref: number): ElementRef | undefined {
  return elementMap.get(ref);
}

/**
 * Safely extract page state with retry logic.
 * Handles "execution context destroyed" errors from redirects/navigations.
 */
export async function extractPageState(page: Page, retries = 2): Promise<PageState> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await _doExtract(page);
    } catch (err: any) {
      const msg = err.message || '';
      const isContextDestroyed =
        msg.includes('Execution context was destroyed') ||
        msg.includes('navigation') ||
        msg.includes('Target closed') ||
        msg.includes('frame was detached');

      if (isContextDestroyed && attempt < retries) {
        // Wait for new page to stabilize after redirect
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await page.waitForTimeout(1500);
        continue;
      }
      // Final attempt or non-retriable error — return empty state
      return {
        url: safeUrl(page),
        title: '',
        elements: [],
        visibleText: '',
        elementCount: 0,
      };
    }
  }
  // Should never reach here, but just in case
  return { url: safeUrl(page), title: '', elements: [], visibleText: '', elementCount: 0 };
}

function safeUrl(page: Page): string {
  try {
    return page.url();
  } catch {
    return 'unknown';
  }
}

async function _doExtract(page: Page): Promise<PageState> {
  resetRefs();

  const url = page.url();
  const title = await page.title();

  const rawElements: Array<{
    ref: number;
    tag: string;
    type: string;
    text: string;
    placeholder: string;
    href: string;
    value: string;
    checked: boolean | null;
    disabled: boolean;
    ariaDisabled: string;
    role: string;
    testId: string;
    ariaLabel: string;
    selector: string;
    fallbackSelector: string;
  }> = await page.evaluate(() => {
    const REF_ATTR = 'data-ai-agent-ref';
    const interactiveTags = 'a, button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [onclick], [tabindex]:not(body):not(html)';

    const results: Array<{
      ref: number;
      tag: string;
      type: string;
      text: string;
      placeholder: string;
      href: string;
      value: string;
      checked: boolean | null;
      disabled: boolean;
      ariaDisabled: string;
      role: string;
      testId: string;
      ariaLabel: string;
      selector: string;
      fallbackSelector: string;
    }> = [];

    const computeFallbackSelector = (htmlEl: HTMLElement, tagName: string): string => {
      // For attribute-based selectors that can repeat across a page (like data-testid on list items),
      // generate a Playwright selector using :nth-match() to keep it unique.
      const nthMatch = (selector: string): string => {
        try {
          const nodes = Array.from(document.querySelectorAll(selector));
          const idx = nodes.indexOf(htmlEl);
          if (idx >= 0 && nodes.length > 1) {
            return `:nth-match(${selector}, ${idx + 1})`;
          }
        } catch {
          // Ignore and fall back to the raw selector.
        }
        return selector;
      };

      if (htmlEl.id) {
        return '#' + CSS.escape(htmlEl.id);
      }
      const nameAttr = htmlEl.getAttribute('name');
      if (nameAttr) {
        return nthMatch(tagName + '[name="' + CSS.escape(nameAttr) + '"]');
      }
      const ariaLabel = htmlEl.getAttribute('aria-label');
      if (ariaLabel) {
        return nthMatch(tagName + '[aria-label="' + CSS.escape(ariaLabel) + '"]');
      }
      const placeholder = htmlEl.getAttribute('placeholder');
      if (placeholder) {
        return nthMatch(tagName + '[placeholder="' + CSS.escape(placeholder) + '"]');
      }
      const testId = htmlEl.getAttribute('data-testid');
      if (testId) {
        return nthMatch(tagName + '[data-testid="' + CSS.escape(testId) + '"]');
      }

      // Structural fallback: first class + :nth-of-type, optionally anchored by parent id.
      let nthOfType = 1;
      let sibling = htmlEl.previousElementSibling;
      while (sibling) {
        if (sibling.tagName === htmlEl.tagName) nthOfType++;
        sibling = sibling.previousElementSibling;
      }

      const className = htmlEl.className;
      let selector = '';
      if (typeof className === 'string' && className.trim()) {
        const firstClass = className.trim().split(/\\s+/)[0];
        selector = tagName + '.' + CSS.escape(firstClass) + ':nth-of-type(' + nthOfType + ')';
      } else {
        selector = tagName + ':nth-of-type(' + nthOfType + ')';
      }

      const parent = htmlEl.parentElement;
      if (parent && parent.id) {
        selector = '#' + CSS.escape(parent.id) + ' > ' + selector;
      }

      return selector;
    };

    // Clear any refs from a previous extraction pass to keep selectors unique.
    document.querySelectorAll(`[${REF_ATTR}]`).forEach((el) => el.removeAttribute(REF_ATTR));

    const allEls = document.querySelectorAll(interactiveTags);
    const maxElements = 200;
    let ref = 1;

    allEls.forEach((el) => {
      if (results.length >= maxElements) return;

      const htmlEl = el as HTMLElement;
      const rect = htmlEl.getBoundingClientRect();
      const style = window.getComputedStyle(htmlEl);

      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.opacity === '0' ||
        rect.width === 0 ||
        rect.height === 0
      ) {
        return;
      }

      let text = '';
      const tagName = htmlEl.tagName.toLowerCase();
      if (tagName === 'input' || tagName === 'textarea') {
        text = (htmlEl as HTMLInputElement).value || '';
      } else {
        text = (htmlEl.innerText || htmlEl.textContent || '').trim();
      }
      text = text.substring(0, 100).replace(/\s+/g, ' ');

      const ariaLabel = htmlEl.getAttribute('aria-label') || '';
      const placeholder = htmlEl.getAttribute('placeholder') || '';
      const role = htmlEl.getAttribute('role') || '';
      const testId = htmlEl.getAttribute('data-testid') || '';
      const ariaDisabled = htmlEl.getAttribute('aria-disabled') || '';
      const disabled = Boolean((htmlEl as any).disabled) || htmlEl.hasAttribute('disabled') || ariaDisabled === 'true';

      const href = tagName === 'a' ? (htmlEl as HTMLAnchorElement).href : '';
      // Skip elements without any meaningful label/identifier; reduces noise on complex SPAs.
      if (!text && !ariaLabel && !placeholder && !href && !testId) return;

      const currentRef = ref++;
      htmlEl.setAttribute(REF_ATTR, String(currentRef));
      const selector = `[${REF_ATTR}="${currentRef}"]`;
      const fallbackSelector = computeFallbackSelector(htmlEl, tagName);

      results.push({
        ref: currentRef,
        tag: tagName,
        type: htmlEl.getAttribute('type') || '',
        text,
        placeholder,
        href,
        value: (tagName === 'input' || tagName === 'select') ? (htmlEl as HTMLInputElement).value : '',
        checked: tagName === 'input' ? (htmlEl as HTMLInputElement).checked : null,
        disabled,
        ariaDisabled,
        role,
        testId,
        ariaLabel,
        selector,
        fallbackSelector,
      });
    });

    return results;
  });

  const elements: ElementRef[] = rawElements.map((raw) => {
    const ref = raw.ref;
    selectorMap.set(ref, raw.selector);

    const el: ElementRef = {
      ref,
      tag: raw.tag,
      type: raw.type || undefined,
      text: raw.text,
      placeholder: raw.placeholder || undefined,
      href: raw.href || undefined,
      value: raw.value || undefined,
      checked: raw.checked ?? undefined,
      disabled: raw.disabled ?? undefined,
      ariaDisabled: raw.ariaDisabled || undefined,
      role: raw.role || undefined,
      testId: raw.testId || undefined,
      selector: raw.selector,
      fallbackSelector: raw.fallbackSelector || undefined,
      ariaLabel: raw.ariaLabel || undefined,
    };
    elementMap.set(ref, el);
    return el;
  });

  const visibleText = await page.evaluate(() => {
    const body = document.body;
    if (!body) return '';
    return (body.innerText || '')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 12000);
  });

  return {
    url,
    title,
    elements,
    visibleText: visibleText.substring(0, 8000),
    elementCount: elements.length,
  };
}

export function formatPageState(state: PageState): string {
  const lines: string[] = [];
  lines.push(`URL: ${state.url}`);
  lines.push(`Title: ${state.title}`);
  lines.push(`Interactive elements (${state.elementCount}):`);

  const maxElementsToShow = 80;
  const shown = state.elements.slice(0, maxElementsToShow);
  if (state.elementCount > shown.length) {
    lines.push(`(showing ${shown.length}/${state.elementCount}. Use find_elements() or extract_items() to locate others.)`);
  }

  for (const el of shown) {
    let desc = `[ref:${el.ref}] <${el.tag}`;
    if (el.type) desc += ` type="${el.type}"`;
    desc += '>';

    const label = (el.text || el.ariaLabel || el.placeholder || '').replace(/\s+/g, ' ').trim();
    if (label) desc += ` "${label}"`;

    // Keep output compact; include only the most helpful attributes.
    if (el.href) {
      const shortHref = el.href.length > 70 ? el.href.substring(0, 67) + '...' : el.href;
      desc += ` href="${shortHref}"`;
    }
    if (el.role) desc += ` role="${el.role}"`;
    if (el.testId) desc += ` data-testid="${el.testId}"`;
    if (el.disabled) desc += ` disabled=true`;
    if (el.checked !== undefined) desc += ` checked=${el.checked}`;
    lines.push(desc);
  }

  if (state.visibleText) {
    lines.push('');
    lines.push(`Page text: ${state.visibleText}`);
  }

  return lines.join('\n');
}
