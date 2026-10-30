/** Keep component tests offline while allowing the built-in themes' file boundary. */
export function themeStylesheetFetch(fallback: typeof fetch): typeof fetch {
  return (input, init) => {
    if (typeof input === "string" && /\/pi-web-theme-assets\/themes\/revisions\/[^/]+\/(?:pi-web-dark|pi-web-light|classic|paper|graphite)\.css$/.test(new URL(input).pathname)) {
      return Promise.resolve(new Response(":root { --test-theme-file: loaded; }", {
        headers: { "Content-Type": "text/css" },
      }));
    }
    return fallback(input, init);
  };
}
