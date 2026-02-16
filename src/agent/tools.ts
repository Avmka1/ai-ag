import type { ChatCompletionTool } from 'openai/resources/chat/completions';

export const AGENT_TOOLS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'navigate',
      description: 'Navigate the browser to a URL. Use this to go to websites.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The URL to navigate to (must include protocol, e.g. https://)',
          },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'click',
      description: 'Click an interactive element on the page by its reference number from the page content.',
      parameters: {
        type: 'object',
        properties: {
          ref: {
            type: 'number',
            description: 'The reference number of the element to click (e.g. 3 for [ref:3])',
          },
        },
        required: ['ref'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'type_text',
      description: 'Type text into an input field by its reference number. Clears existing content first.',
      parameters: {
        type: 'object',
        properties: {
          ref: {
            type: 'number',
            description: 'The reference number of the input element',
          },
          text: {
            type: 'string',
            description: 'The text to type',
          },
        },
        required: ['ref', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'press_key',
      description: 'Press a keyboard key. Useful for Enter, Tab, Escape, ArrowDown, Backspace, etc.',
      parameters: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: 'The key to press (e.g. "Enter", "Tab", "Escape", "ArrowDown")',
          },
        },
        required: ['key'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'scroll',
      description: 'Scroll the page up or down.',
      parameters: {
        type: 'object',
        properties: {
          direction: {
            type: 'string',
            enum: ['up', 'down'],
            description: 'Direction to scroll',
          },
          amount: {
            type: 'number',
            description: 'Pixels to scroll (default 500)',
          },
        },
        required: ['direction'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_back',
      description: 'Go back in browser history. Useful to return from a detail page (email/item) back to a list.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_page_content',
      description: 'Re-extract the current page state. Call this when you need fresh element references, e.g. after waiting for content to load.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'extract_items',
      description:
        'Extract a structured list of visible "items" from the current page (emails, vacancies, news, products). Returns up to maxItems items with their text and relevant clickable refs found inside each item. Use this to read lists without opening each item.',
      parameters: {
        type: 'object',
        properties: {
          maxItems: {
            type: 'number',
            description: 'Maximum number of items to return (default 10, max 20).',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_elements',
      description:
        'Find interactive elements on the current page that match a text query (matches text/aria-label/placeholder/testid/href). Returns a short list of matching [ref:N] elements. Use this to locate specific buttons/options like "без соуса", "корзина", "оформить".',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Text to search for (case-insensitive). You can include multiple words.',
          },
          maxResults: {
            type: 'number',
            description: 'Maximum number of results to return (default 12, max 30).',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'screenshot',
      description: 'Take a screenshot of the current page for visual analysis. Use when text extraction is insufficient to understand the layout.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'wait',
      description: 'Wait for a specified time. Use after navigation or actions that trigger page loads.',
      parameters: {
        type: 'object',
        properties: {
          ms: {
            type: 'number',
            description: 'Milliseconds to wait (max 10000)',
          },
        },
        required: ['ms'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'done',
      description: 'Signal that the task is FULLY complete. ONLY call this when the entire task has been accomplished (item added to cart, email deleted, etc). NEVER call this if you are still planning next steps. The result must describe what was DONE, not what you PLAN to do.',
      parameters: {
        type: 'object',
        properties: {
          result: {
            type: 'string',
            description: 'Summary of what was accomplished',
          },
        },
        required: ['result'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_user',
      description: 'Ask the user a clarifying question. Use when you need information not provided (e.g. login credentials, preferences).',
      parameters: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: 'The question to ask the user',
          },
        },
        required: ['question'],
      },
    },
  },
];

export function buildSystemPrompt(task: string): string {
  return `You are an AI browser automation agent. You control a web browser to complete tasks for the user.

TASK: ${task}

RULES:
1. You observe the current page state, reason about what to do next, then take ONE action using a tool call.
2. After each action, you receive updated page content with interactive elements labeled [ref:N].
3. Use reference numbers to click or type into elements (e.g. click ref 5, type into ref 3).
4. NEVER guess or hardcode CSS selectors. Always use the reference numbers provided.
5. DO NOT click elements that are marked disabled (disabled=true or aria-disabled="true"). If a needed button is disabled, figure out what prerequisite is missing (address, login, required option) and resolve that first.
   - For ordering/shopping flows this often means: selecting a delivery address, picking an available branch, choosing required options/modifiers, or logging in.
6. When you need to read/collect multiple items from a list (emails, vacancies, news, products), prefer calling extract_items() to get a structured list instead of randomly clicking around.
   - If the task asks for "latest N items" (e.g. last 10 emails / 3 vacancies / news for today), your first action should usually be extract_items(maxItems=N).
7. If a page is loading or content seems incomplete, call wait(2000) then get_page_content().
8. If page content is confusing or you need visual context, use screenshot() for visual analysis.
9. Use find_elements(query) to quickly locate specific UI controls/options (e.g. "без соуса", "не нужен", "корзина", "оформить").
   - If the page has a search input (placeholder contains "Искать" / "Search"), prefer typing the item name there to locate it instead of randomly clicking.
10. NEVER ask the user to paste passwords, 2FA codes, or payment details. If login is required, ask the user to log in manually in the browser window and then type "done".
11. If you need non-sensitive information from the user (preferences, confirmations), call ask_user().
12. Be methodical. Navigate step by step. Examine the page carefully before acting.
13. If an action fails, call get_page_content() to refresh references before retrying.
14. If the same action fails twice, try a completely different approach (e.g. search, scroll, browser_back, close modal, change filters).
15. For search/navigation: start by going to the relevant website, then use the site's UI.
16. Maximum 50 steps. Be efficient.

SHOPPING / FOOD DELIVERY SAFETY:
- Do NOT add extras/modifiers (sauces, add-ons) unless the user explicitly asked.
- If the user requested "without sauce / без соуса", do NOT select any sauce. If a sauce choice is required, look for "без соуса/не нужен/none".
- If adding an item opens a customization modal/page: select required options first (size, etc). For "без соуса" tasks, use find_elements("без соуса") / find_elements("не нужен") to locate the correct option, then press the final "Добавить" / add-to-cart button.
- Avoid duplicate items: do not click "add to cart" multiple times unless the user requested multiple quantities.
- After adding the target item once, immediately open the cart (the button can be labeled "На корзину" / "Корзина" / cart icon). Use find_elements("корзина") or find_elements("корзин") if needed, then proceed to checkout.
- Do not click the delivery-address header repeatedly unless the task explicitly asks to change the address.
- For size-specific items (e.g. "Средний"), search/click the exact item label with size first (e.g. "Картофель Фри Средний"), then click add-to-cart once.
- When you reach the final step where payment is the next action, STOP and call done() with a report instead of paying.

CRITICAL — done() RULES:
- ONLY call done() when the task has been FULLY completed (e.g. item is in cart, email is deleted, form is submitted).
- NEVER call done() if you are still in the middle of the task.
- NEVER call done() just because you searched for something or found a page — that is NOT completion.
- If you cannot complete the task, call ask_user() to explain the problem instead of calling done().
- The "result" parameter of done() should be a short summary of what was actually accomplished, NOT your reasoning or next planned action.

CAPTCHA / ANTI-BOT DETECTION:
- If you see a CAPTCHA, "showcaptcha", "robot check", or "are you human" page, immediately call ask_user() and tell the user to solve the CAPTCHA manually in the browser. Then call wait(10000) followed by get_page_content() to check if it was solved.

THINKING: Before each action, briefly explain your reasoning. Then call exactly ONE tool.`;
}
