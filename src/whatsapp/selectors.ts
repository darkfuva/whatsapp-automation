export const WHATSAPP_SELECTORS = {
  loggedInIndicators: [
    "[data-testid='chat-list-search']",
    "[aria-label='Chat list']",
    "div[role='grid']",
    "div#pane-side"
  ],
  qrIndicators: [
    "canvas[aria-label*='Scan']",
    "canvas[aria-label*='QR']",
    "[data-ref] canvas",
    "div[data-testid='qrcode'] canvas"
  ],
  sidebarSearchInputs: [
    "div[aria-label='Search input textbox']",
    "div[contenteditable='true'][data-tab='3']",
    "div[contenteditable='true'][data-tab='10']",
    "div[role='textbox'][title*='Search']",
    "div[role='textbox'][aria-label*='Search']"
  ],
  chatHeaderTitle: [
    "header span[title]",
    "header h1",
    "header div[role='button'] span[dir='auto']"
  ],
  messageRowCandidates: [
    "div[data-pre-plain-text]",
    "div[data-testid='msg-container']",
    "div.message-in",
    "div.message-out",
    "div[role='row']"
  ],
  messageTextCandidates: [
    "span.selectable-text",
    "div.copyable-text span",
    "div[dir='auto'] span",
    "div[dir='ltr'] span",
    "div[dir='auto']"
  ],
  messageMetaCandidates: [
    "div[data-pre-plain-text]",
    "span[data-testid='msg-meta']",
    "span[aria-hidden='true']",
    "div.copyable-text"
  ],
  attachmentCandidates: [
    "[data-icon='audio-download']",
    "[data-icon='media-download']",
    "img",
    "video",
    "audio",
    "a[href]"
  ]
} as const;

