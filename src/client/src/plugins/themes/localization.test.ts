import { expect, it } from "vitest";
import { LocalizationService } from "../../localization/service";
import { localizeBuiltInThemeMetadata } from "./index";
import definitions from "./themes.messages";

it("keeps static built-in theme and pair labels live without changing catalog identities", async () => {
  const localization = new LocalizationService({ development: true });
  const catalog = Object.fromEntries(Object.entries(definitions).map(([key, value]) => [key, `Translated ${value.message}`]));
  localization.registerCatalog({
    id: "themes-test", namespace: "plugin:themes:themes", locale: "de", load: () => Promise.resolve(catalog),
  });
  const ids = ["pi-web-dark", "pi-web-light", "classic", "paper", "graphite", "pi-web", "paper-graphite"];
  const contributions = ids.map((id) => localizeBuiltInThemeMetadata({
    id: `themes:${id}`, name: "Fallback", description: "Fallback", stylesheets: [{ id: "palette", url: `${id}.css` }],
  }, localization));
  const labels = Object.values(definitions).slice(0, -2).map(({ message }) => message);
  const identities = contributions.map(({ id, stylesheets }) => ({ id, stylesheets }));
  expect(contributions.flatMap(({ name, description }) => [name, description])).toEqual(labels);
  for (const language of ["de", "en-XA", "ar-XB", "en"]) {
    await localization.setPreferences({ language, formatLocale: "en" });
    const translated = contributions.flatMap(({ name, description }) => [name, description]);
    if (language === "en") expect(translated).toEqual(labels);
    else if (language === "de") expect(translated).toEqual(labels.map((label) => `Translated ${label}`));
    else for (const [index, label] of translated.entries()) expect(label).not.toBe(labels[index]);
    expect(contributions.map(({ id, stylesheets }) => ({ id, stylesheets }))).toEqual(identities);
  }
  const external = { id: "other:paper", name: "Other Paper" };
  expect(localizeBuiltInThemeMetadata(external, localization)).toBe(external);
});
