import type { QualifiedContributionId } from "./plugins/ids";

export type QueryValue = string | number | boolean | readonly (string | number | boolean)[];
export type ContributionQueryValue = string | readonly string[];
export type ContributionQuerySnapshot = Readonly<Record<string, ContributionQueryValue>>;
export type ContributionQueryRecord = Record<string, string | string[]>;

const qualifiedContributionIdPattern = /^[a-z][a-z0-9.-]*:[a-z][a-z0-9.-]*$/u;
const localQueryKeyPattern = /^[a-z][a-z0-9.-]*$/u;
const contributionQueryParameterPattern = /^[a-z][a-z0-9.-]*\.[a-z][a-z0-9.-]*--[a-z][a-z0-9.-]*$/u;
const MAX_CONTRIBUTION_QUERY_PARAMETERS = 64;
const MAX_CONTRIBUTION_QUERY_VALUES = 16;
const MAX_CONTRIBUTION_QUERY_PARAMETER_LENGTH = 256;
const MAX_CONTRIBUTION_QUERY_VALUE_LENGTH = 4_096;
const MAX_CONTRIBUTION_QUERY_RECORD_LENGTH = 65_536;

export function queryNamespace(contributionId: string): string {
  return contributionId.replaceAll(":", ".");
}

export function readNamespacedQuery(namespace: string): Record<string, string | string[]> {
  return readNamespacedQueryFromParams(new URLSearchParams(window.location.search), namespace);
}

export function readNamespacedString(namespace: string, key: string): string | undefined {
  const value = readNamespacedQuery(namespace)[key];
  if (Array.isArray(value)) return value[0];
  return value === "" ? undefined : value;
}

/** Read one contribution's canonical query snapshot, falling back to aliases per key. */
export function readContributionQuery(
  contributionId: QualifiedContributionId,
  aliases: readonly QualifiedContributionId[] = [],
): ContributionQuerySnapshot {
  return contributionQueryFromParams(new URLSearchParams(window.location.search), contributionId, aliases);
}

/** Project a bounded full contribution-query record into one contribution's canonical snapshot. */
export function contributionQueryFromRecord(
  record: Readonly<Record<string, ContributionQueryValue>>,
  contributionId: QualifiedContributionId,
  aliases: readonly QualifiedContributionId[] = [],
): ContributionQuerySnapshot {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(normalizeContributionQueryRecord(record))) {
    if (typeof value === "string") params.append(key, value);
    else for (const item of value) params.append(key, item);
  }
  return contributionQueryFromParams(params, contributionId, aliases);
}

function contributionQueryFromParams(
  params: URLSearchParams,
  contributionId: QualifiedContributionId,
  aliases: readonly QualifiedContributionId[],
): ContributionQuerySnapshot {
  const query = emptyQueryRecord<string | string[]>();
  const budget = { parameterCount: 0, recordLength: 0 };
  for (const id of uniqueContributionIds(contributionId, aliases)) {
    const namespace = queryNamespace(id);
    const candidate = readNamespacedQueryFromParams(params, namespace);
    for (const [key, value] of Object.entries(candidate)) {
      if (!isContributionQueryLocalKey(key) || Object.hasOwn(query, key)) continue;
      addBoundedQueryValue(query, key, value, `${namespace}--${key}`.length, budget);
    }
  }
  return freezeContributionQuery(query);
}

/** Capture only bounded, syntactically valid contribution-owned query parameters. */
export function readContributionQueryRecord(): ContributionQueryRecord {
  return readBoundedQueryFromParams(
    new URLSearchParams(window.location.search),
    (key) => isContributionQueryParameter(key) ? { key, parameterLength: key.length } : undefined,
  );
}

/** Validate and bound a record loaded from browser memory or another untyped boundary. */
export function normalizeContributionQueryRecord(value: unknown): ContributionQueryRecord {
  if (!isRecord(value)) return emptyQueryRecord<string | string[]>();
  const result = emptyQueryRecord<string | string[]>();
  let parameterCount = 0;
  let recordLength = 0;
  for (const [key, candidate] of Object.entries(value)) {
    if (parameterCount >= MAX_CONTRIBUTION_QUERY_PARAMETERS) break;
    if (!isContributionQueryParameter(key) || key.length > MAX_CONTRIBUTION_QUERY_PARAMETER_LENGTH) continue;
    const values = typeof candidate === "string"
      ? [candidate]
      : Array.isArray(candidate) && candidate.every((item) => typeof item === "string")
        ? candidate.slice(0, MAX_CONTRIBUTION_QUERY_VALUES)
        : undefined;
    if (values === undefined || values.length === 0 || values.some((item) => item.length > MAX_CONTRIBUTION_QUERY_VALUE_LENGTH)) continue;
    const candidateLength = key.length + values.reduce((total, item) => total + item.length, 0);
    if (recordLength + candidateLength > MAX_CONTRIBUTION_QUERY_RECORD_LENGTH) break;
    result[key] = values.length === 1 ? values[0] ?? "" : values;
    parameterCount += 1;
    recordLength += candidateLength;
  }
  return result;
}

/** Replace all contribution-owned parameters while preserving route, unrelated query, path, and hash. */
export function writeContributionQueryRecord(
  record: Readonly<Record<string, string | readonly string[]>>,
  options?: { replace?: boolean | undefined },
): boolean {
  const normalized = normalizeContributionQueryRecord(record);
  const url = new URL(window.location.href);
  replaceContributionQueryParams(url.searchParams, normalized);
  return commitUrl(url, options);
}

/** Canonicalize one key by removing canonical and alias values, then writing canonical only. */
export function setContributionQueryKey(
  contributionId: QualifiedContributionId,
  aliases: readonly QualifiedContributionId[],
  key: string,
  value: QueryValue | undefined | null,
  options?: { replace?: boolean | undefined },
): boolean {
  assertQualifiedContributionId(contributionId);
  for (const alias of aliases) assertQualifiedContributionId(alias);
  if (!isContributionQueryLocalKey(key)) throw new Error(`Invalid contribution navigation key: ${key}`);

  const serializedValues = value === undefined || value === null ? [] : serializeContributionQueryValue(key, value);
  const parameterKeys = uniqueContributionIds(contributionId, aliases).map((id) => `${queryNamespace(id)}--${key}`);
  const canonicalKey = parameterKeys[0];
  if (canonicalKey === undefined) throw new Error("Contribution navigation requires a canonical contribution id");
  if (canonicalKey.length > MAX_CONTRIBUTION_QUERY_PARAMETER_LENGTH) {
    throw new Error(`Contribution navigation parameter is too long for key: ${key}`);
  }
  const callerParams = new URLSearchParams();
  for (const item of serializedValues) callerParams.append(canonicalKey, item);
  // Validate only caller-owned input. Restored URL state is an untyped boundary
  // and is normalized below instead of being allowed to poison this write.
  assertContributionQueryParamsWithinLimits(callerParams);

  const replacedParameterKeys = new Set(parameterKeys);
  const candidates = new URLSearchParams(callerParams);
  const url = new URL(window.location.href);
  for (const [parameter, existingValue] of url.searchParams) {
    if (isContributionQueryParameter(parameter) && !replacedParameterKeys.has(parameter)) {
      candidates.append(parameter, existingValue);
    }
  }
  const normalized = readBoundedQueryFromParams(
    candidates,
    (parameter) => isContributionQueryParameter(parameter) ? { key: parameter, parameterLength: parameter.length } : undefined,
  );
  replaceContributionQueryParams(url.searchParams, normalized);
  return commitUrl(url, options);
}

export function setNamespacedQueryKey(namespace: string, key: string, value: QueryValue | undefined | null, options?: { replace?: boolean | undefined }): void {
  const url = new URL(window.location.href);
  const namespacedKey = `${namespace}--${key}`;
  url.searchParams.delete(namespacedKey);
  if (value !== undefined && value !== null && value !== "") {
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(namespacedKey, String(item));
    } else {
      url.searchParams.set(namespacedKey, String(value));
    }
  }
  commitUrl(url, options);
}

export function isContributionQueryParameter(value: string): boolean {
  return contributionQueryParameterPattern.test(value);
}

export function isContributionQueryLocalKey(value: string): boolean {
  return localQueryKeyPattern.test(value);
}

function readNamespacedQueryFromParams(params: URLSearchParams, namespace: string): Record<string, string | string[]> {
  const prefix = `${namespace}--`;
  return readBoundedQueryFromParams(params, (parameter) => {
    if (!parameter.startsWith(prefix)) return undefined;
    const key = parameter.slice(prefix.length);
    return isContributionQueryLocalKey(key) ? { key, parameterLength: parameter.length } : undefined;
  });
}

function uniqueContributionIds(
  contributionId: QualifiedContributionId,
  aliases: readonly QualifiedContributionId[],
): QualifiedContributionId[] {
  return [...new Set([contributionId, ...aliases])];
}

function freezeContributionQuery(query: Record<string, string | string[]>): ContributionQuerySnapshot {
  const snapshot = emptyQueryRecord<string | readonly string[]>();
  for (const [key, value] of Object.entries(query)) {
    snapshot[key] = Array.isArray(value) ? Object.freeze([...value]) : value;
  }
  return Object.freeze(snapshot);
}

function assertQualifiedContributionId(value: string): asserts value is QualifiedContributionId {
  if (!qualifiedContributionIdPattern.test(value)) throw new Error(`Invalid qualified contribution id: ${value}`);
}

function serializeContributionQueryValue(key: string, value: unknown): string[] {
  const values: unknown[] = Array.isArray(value) ? value : [value];
  if (values.length > MAX_CONTRIBUTION_QUERY_VALUES) throw new Error(`Contribution navigation value has too many items for key: ${key}`);
  const serialized = values.map((item) => {
    if (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") {
      throw new Error(`Invalid contribution navigation value for key: ${key}`);
    }
    return String(item);
  });
  if (serialized.some((item) => item.length > MAX_CONTRIBUTION_QUERY_VALUE_LENGTH)
    || serialized.reduce((total, item) => total + item.length, 0) > MAX_CONTRIBUTION_QUERY_RECORD_LENGTH) {
    throw new Error(`Contribution navigation value is too long for key: ${key}`);
  }
  return serialized;
}

function commitUrl(url: URL, options?: { replace?: boolean | undefined }): boolean {
  const next = `${url.pathname}${url.search}${url.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next === current) return false;
  if (options?.replace === true) window.history.replaceState({}, "", url);
  else window.history.pushState({}, "", url);
  return true;
}

interface QueryBudget {
  parameterCount: number;
  recordLength: number;
}

function readBoundedQueryFromParams(
  params: URLSearchParams,
  acceptParameter: (parameter: string) => { key: string; parameterLength: number } | undefined,
): ContributionQueryRecord {
  const result = emptyQueryRecord<string | string[]>();
  const budget: QueryBudget = { parameterCount: 0, recordLength: 0 };
  for (const [parameter, value] of params) {
    const accepted = acceptParameter(parameter);
    if (accepted === undefined
      || accepted.parameterLength > MAX_CONTRIBUTION_QUERY_PARAMETER_LENGTH
      || value.length > MAX_CONTRIBUTION_QUERY_VALUE_LENGTH) continue;
    appendBoundedQueryParam(result, accepted.key, value, accepted.parameterLength, budget);
  }
  return result;
}

function addBoundedQueryValue(
  result: Record<string, string | string[]>,
  key: string,
  value: string | readonly string[],
  parameterLength: number,
  budget: QueryBudget,
): boolean {
  if (Object.hasOwn(result, key)) return false;
  const values = typeof value === "string" ? [value] : [...value];
  if (values.length === 0
    || values.length > MAX_CONTRIBUTION_QUERY_VALUES
    || values.some((item) => item.length > MAX_CONTRIBUTION_QUERY_VALUE_LENGTH)
    || budget.parameterCount >= MAX_CONTRIBUTION_QUERY_PARAMETERS) return false;
  const candidateLength = parameterLength + values.reduce((total, item) => total + item.length, 0);
  if (budget.recordLength + candidateLength > MAX_CONTRIBUTION_QUERY_RECORD_LENGTH) return false;
  result[key] = values.length === 1 ? values[0] ?? "" : values;
  budget.parameterCount += 1;
  budget.recordLength += candidateLength;
  return true;
}

function appendBoundedQueryParam(
  result: ContributionQueryRecord,
  key: string,
  value: string,
  parameterLength: number,
  budget: QueryBudget,
): void {
  if (!Object.hasOwn(result, key)) {
    addBoundedQueryValue(result, key, value, parameterLength, budget);
    return;
  }
  const existing = result[key];
  const existingValues = Array.isArray(existing) ? existing : [existing ?? ""];
  if (existingValues.length >= MAX_CONTRIBUTION_QUERY_VALUES
    || budget.recordLength + value.length > MAX_CONTRIBUTION_QUERY_RECORD_LENGTH) return;
  result[key] = [...existingValues, value];
  budget.recordLength += value.length;
}

function replaceContributionQueryParams(
  params: URLSearchParams,
  record: Readonly<Record<string, string | readonly string[]>>,
): void {
  for (const key of [...params.keys()]) {
    if (isContributionQueryParameter(key)) params.delete(key);
  }
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string") {
      params.set(key, value);
      continue;
    }
    for (const item of value) params.append(key, item);
  }
}

function assertContributionQueryParamsWithinLimits(params: URLSearchParams): void {
  const valueCounts = new Map<string, number>();
  let parameterCount = 0;
  let recordLength = 0;
  for (const [key, value] of params) {
    if (!isContributionQueryParameter(key)) continue;
    if (key.length > MAX_CONTRIBUTION_QUERY_PARAMETER_LENGTH) throw new Error(`Contribution navigation parameter is too long: ${key}`);
    if (value.length > MAX_CONTRIBUTION_QUERY_VALUE_LENGTH) throw new Error(`Contribution navigation value is too long for parameter: ${key}`);
    const previousCount = valueCounts.get(key) ?? 0;
    if (previousCount === 0) {
      parameterCount += 1;
      recordLength += key.length;
      if (parameterCount > MAX_CONTRIBUTION_QUERY_PARAMETERS) throw new Error("Contribution navigation has too many parameters");
    }
    const nextCount = previousCount + 1;
    if (nextCount > MAX_CONTRIBUTION_QUERY_VALUES) throw new Error(`Contribution navigation parameter has too many values: ${key}`);
    valueCounts.set(key, nextCount);
    recordLength += value.length;
    if (recordLength > MAX_CONTRIBUTION_QUERY_RECORD_LENGTH) throw new Error("Contribution navigation record is too long");
  }
}

function emptyQueryRecord<Value>(): Record<string, Value> {
  // Contribution-owned local keys may be named `constructor` or `toString`;
  // a null prototype keeps absent and present values inside the published type.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Object.create(null) has the intended string-record runtime shape without a typed overload.
  return Object.create(null) as Record<string, Value>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
