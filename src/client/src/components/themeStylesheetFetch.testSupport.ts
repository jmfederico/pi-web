/** Keep component tests offline while allowing the built-in themes' file boundary. */
export function themeStylesheetFetch(fallback: typeof fetch): typeof fetch {
  return (input, init) => {
    if (typeof input === "string" && /\/plugins\/themes\/(?:pi-web-dark|pi-web-light|classic)\.css\?no-inline$/.test(new URL(input).pathname + new URL(input).search)) {
      return Promise.resolve(new Response(":root { --test-theme-file: loaded; }", {
        headers: { "Content-Type": "text/css" },
      }));
    }
    return fallback(input, init);
  };
}
