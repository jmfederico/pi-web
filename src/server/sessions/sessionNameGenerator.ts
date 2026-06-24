import type { Api, AssistantMessage, AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

const SESSION_NAME_TIMEOUT_MS = 10_000;
const SESSION_NAME_MAX_INPUT_CHARS = 4_000;
const SESSION_NAME_MAX_LENGTH = 60;
const FALLBACK_SESSION_NAME_MAX_WORDS = 6;
const PI_AI_COMPAT_MODULE = ["@earendil-works/pi-ai", "compat"].join("/");

interface SessionNameApiProvider {
  streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
}

interface PiAiProviderRegistryModule {
  getApiProvider?: (api: Api) => SessionNameApiProvider | undefined;
}

type ModuleImporter = (specifier: string) => Promise<unknown>;

let piAiProviderRegistryModulePromise: Promise<PiAiProviderRegistryModule> | undefined;

export async function generateShortSessionName<TApi extends Api>(modelRegistry: ModelRegistry, model: Model<TApi>, firstMessage: string): Promise<string | undefined> {
  const providerRegistry = await getPiAiProviderRegistryModule();
  const provider = providerRegistry.getApiProvider?.(model.api);
  if (provider === undefined) return undefined;

  const auth = await modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) return undefined;

  const stream = provider.streamSimple(
    model,
    {
      systemPrompt: "Generate a concise title for a coding-agent chat session. Return only the title, with no quotes or punctuation wrapper.",
      messages: [{
        role: "user",
        content: `Create a 2-6 word title for this request:\n\n${truncateInput(firstMessage)}`,
        timestamp: Date.now(),
      }],
    },
    {
      maxTokens: 24,
      reasoning: "minimal",
      signal: AbortSignal.timeout(SESSION_NAME_TIMEOUT_MS),
      ...(auth.apiKey === undefined ? {} : { apiKey: auth.apiKey }),
      ...(auth.headers === undefined ? {} : { headers: auth.headers }),
    },
  );

  let streamedText = "";
  let finalMessage: AssistantMessage | undefined;
  for await (const event of stream) {
    if (event.type === "text_delta") streamedText += event.delta;
    if (event.type === "done") finalMessage = event.message;
    if (event.type === "error") return undefined;
  }

  return cleanSessionName(finalMessage === undefined ? streamedText : textFromAssistant(finalMessage));
}

export function fallbackSessionName(firstMessage: unknown): string | undefined {
  if (typeof firstMessage !== "string") return undefined;

  return cleanSessionName(firstMessage
    .replace(/<skill name="[^"]+" location="[^"]+">[\s\S]*?<\/skill>/g, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[`*_#[\](){}<>]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, FALLBACK_SESSION_NAME_MAX_WORDS)
    .join(" "));
}

export function cleanSessionName(value: string): string | undefined {
  const title = (value.split("\n", 1)[0] ?? "")
    .replace(/^\s*(title|session title)\s*:\s*/i, "")
    .replace(/^\s*["'`]+|["'`.]+\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SESSION_NAME_MAX_LENGTH)
    .trim();
  return title === "" ? undefined : title;
}

async function getPiAiProviderRegistryModule(importer: ModuleImporter = (specifier) => import(specifier)): Promise<PiAiProviderRegistryModule> {
  piAiProviderRegistryModulePromise ??= loadPiAiProviderRegistryModule(importer);
  return piAiProviderRegistryModulePromise;
}

async function loadPiAiProviderRegistryModule(importer: ModuleImporter): Promise<PiAiProviderRegistryModule> {
  const compatModule = await importOptionalPiAiModule(PI_AI_COMPAT_MODULE, importer);
  if (hasGetApiProvider(compatModule)) return compatModule;

  const rootModule = await importer("@earendil-works/pi-ai");
  if (hasGetApiProvider(rootModule)) return rootModule;
  return {};
}

async function importOptionalPiAiModule(specifier: string, importer: ModuleImporter): Promise<unknown> {
  try {
    return await importer(specifier);
  } catch (error) {
    if (isModuleUnavailableError(error)) return undefined;
    throw error;
  }
}

function hasGetApiProvider(moduleValue: unknown): moduleValue is PiAiProviderRegistryModule {
  return typeof moduleValue === "object"
    && moduleValue !== null
    && "getApiProvider" in moduleValue
    && typeof moduleValue.getApiProvider === "function";
}

function isModuleUnavailableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = "code" in error ? error.code : undefined;
  return code === "ERR_MODULE_NOT_FOUND" || code === "ERR_PACKAGE_PATH_NOT_EXPORTED";
}

function textFromAssistant(message: AssistantMessage): string {
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function truncateInput(value: string): string {
  return value.length <= SESSION_NAME_MAX_INPUT_CHARS ? value : `${value.slice(0, SESSION_NAME_MAX_INPUT_CHARS)}…`;
}
