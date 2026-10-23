import type { PiWebPlugin } from "../types";

export const themePackPlugin: PiWebPlugin = {
  apiVersion: 5,
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
        {
          id: "paper",
          name: "Paper",
          description: "White and neutral grays with restrained status colors.",
          order: 40,
          colorScheme: "light",
          stylesheets: [{ id: "palette", url: new URL("./paper.css?no-inline", import.meta.url).href }],
        },
        {
          id: "graphite",
          name: "Graphite",
          description: "Charcoal and neutral grays with restrained status colors.",
          order: 50,
          colorScheme: "dark",
          stylesheets: [{ id: "palette", url: new URL("./graphite.css?no-inline", import.meta.url).href }],
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
        {
          id: "paper-graphite",
          name: "Paper / Graphite",
          description: "Follow the system light/dark preference with neutral gray themes.",
          order: 20,
          light: "paper",
          dark: "graphite",
        },
      ],
    },
  }),
};
