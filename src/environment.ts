export function ownEnvironmentValue(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  return Object.hasOwn(environment, name) ? environment[name] : undefined;
}
