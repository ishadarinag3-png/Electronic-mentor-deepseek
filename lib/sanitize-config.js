/* Shared, DOM-free configuration for the markdown pipeline.
   Kept in its own module so tests can assert the EXACT config the browser
   uses, without needing a DOM. (AUDIT.md M8 / §2) */

export const MARKED_OPTIONS = { gfm: true, breaks: true };

/* LLM output is untrusted input. Allow only safe HTML; strip event handlers,
   scriptable tags and inline styles. KaTeX runs AFTER this, on the live tree. */
export const PURIFY_CFG = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['form', 'input', 'button', 'select', 'textarea', 'style', 'link',
                'meta', 'base', 'iframe', 'object', 'embed', 'script', 'noscript',
                'svg', 'math'],
  FORBID_ATTR: ['onerror', 'onclick', 'onload', 'onmouseover', 'onfocus', 'onblur',
                'onkeydown', 'onkeyup', 'srcdoc', 'formaction', 'style', 'autofocus'],
};

/* Only these link schemes survive; everything else loses its href. */
export const SAFE_HREF = /^(https?:|mailto:|tel:)/i;
