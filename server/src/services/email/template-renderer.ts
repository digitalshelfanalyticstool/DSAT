import type { EmailTemplate } from './types';

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/**
 * Render a template with the given variables.
 *
 * - `{{var}}` HTML-escapes by default (safe for body_html).
 * - `{{{var}}}` raw insertion — caller takes responsibility for safety.
 * - subject and body_text never HTML-escape (they aren't HTML).
 * - Throws if `vars` contains a key not in `template.variables`, or if
 *   `template.variables` declares a key not in `vars`. Both directions —
 *   typo in caller and typo in template are equally loud.
 */
export function renderTemplate(template: EmailTemplate, vars: Record<string, string>): RenderedEmail {
  const expected = new Set(template.variables);
  const provided = new Set(Object.keys(vars));

  const missing = [...expected].filter((k) => !provided.has(k));
  if (missing.length > 0) {
    throw new Error(`Template "${template.slug}" missing required vars: ${missing.join(', ')}`);
  }

  const extra = [...provided].filter((k) => !expected.has(k));
  if (extra.length > 0) {
    throw new Error(`Template "${template.slug}" received unexpected vars: ${extra.join(', ')}`);
  }

  return {
    subject: substitute(template.subject, vars, /* escape */ false),
    html: substitute(template.body_html, vars, /* escape */ true),
    text: substitute(template.body_text, vars, /* escape */ false),
  };
}

function substitute(template: string, vars: Record<string, string>, escape: boolean): string {
  // {{{var}}} = raw, {{var}} = escaped (when escape=true). Order matters —
  // match the triple-brace form first so the double-brace form doesn't eat it.
  return template
    .replace(/\{\{\{(\w+)\}\}\}/g, (_, name: string) => String(vars[name] ?? ''))
    .replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
      const raw = String(vars[name] ?? '');
      return escape ? escapeHtml(raw) : raw;
    });
}
