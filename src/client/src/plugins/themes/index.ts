import type { PiWebPlugin } from "../types";

export const themePackPlugin: PiWebPlugin = {
  apiVersion: 4,
  name: "PI WEB Themes",
  activate: () => ({
    contributions: {
      themes: [
        {
          id: "pi-web-dark",
          name: "PI WEB Dark",
          description: "Dark PI WEB palette.",
          order: 10,
          colorScheme: "dark",
          stylesheets: [{ id: "palette", url: new URL("./pi-web-dark.css?no-inline", import.meta.url).href }],
        },
        {
          id: "pi-web-light",
          name: "PI WEB Light",
          description: "Light PI WEB palette.",
          order: 20,
          colorScheme: "light",
          stylesheets: [{ id: "palette", url: new URL("./pi-web-light.css?no-inline", import.meta.url).href }],
        },
        {
          id: "classic",
          name: "PI WEB Classic",
          description: "The original PI WEB dark palette.",
          order: 30,
          colorScheme: "dark",
          stylesheets: [{ id: "palette", url: new URL("./classic.css?no-inline", import.meta.url).href }],
        },
      ],
      themePairs: [
        {
          id: "pi-web",
          name: "PI WEB",
          description: "Follow the system light/dark preference with PI WEB themes.",
          order: 10,
          light: "pi-web-light",
          dark: "pi-web-dark",
        },
      ],
    },
  }),
};
