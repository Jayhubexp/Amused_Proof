import OpenAI from 'openai';

export const MUSE_SPARK_DEFAULTS = {
  baseURL: 'https://api.meta.ai/v1',
  model: 'muse-spark-1.3',
  timeoutMs: 20000,
  maxRetries: 2,
};

const RETRY_BASE_DELAY_MS = 250;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Normalised Muse Spark failure. Never carries the API key or request bodies. */
export class MuseSparkError extends Error {
  constructor(message, { status = null, code = 'muse_spark_error', retryable = false } = {}) {
    super(message);
    this.name = 'MuseSparkError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

function statusOf(err) {
  const status = err?.status ?? err?.response?.status ?? err?.statusCode;
  return Number.isInteger(status) ? status : null;
}

function isRetryableStatus(status) {
  return status === 429 || status === 408 || (status !== null && status >= 500);
}

function isTimeout(err) {
  return err?.code === 'ETIMEDOUT' || err?.code === 'ECONNABORTED' || err?.name === 'TimeoutError';
}

/**
 * Client for Meta Muse Spark via its OpenAI-compatible API.
 *
 * - Key stays server-side; it is only ever passed to the SDK constructor.
 * - Per-request timeout + bounded retries (429/408/5xx/timeouts only).
 * - `requestFn` injection lets tests supply scripted responses without network.
 */
export class MuseSparkClient {
  constructor({
    apiKey,
    baseURL = MUSE_SPARK_DEFAULTS.baseURL,
    model = MUSE_SPARK_DEFAULTS.model,
    timeoutMs = MUSE_SPARK_DEFAULTS.timeoutMs,
    maxRetries = MUSE_SPARK_DEFAULTS.maxRetries,
    requestFn = null,
  } = {}) {
    if (!apiKey && !requestFn) {
      throw new MuseSparkError('Muse Spark API key is not configured.', {
        code: 'not_configured',
      });
    }
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.requestFn = requestFn ?? this.#defaultRequestFn(apiKey, baseURL);
  }

  #defaultRequestFn(apiKey, baseURL) {
    // SDK retries disabled: this class owns the bounded retry policy below so
    // behaviour is explicit, uniform, and unit-testable.
    const sdk = new OpenAI({ apiKey, baseURL, timeout: this.timeoutMs, maxRetries: 0 });
    return async ({ messages, tools }) =>
      sdk.chat.completions.create({
        model: this.model,
        messages,
        ...(tools?.length ? { tools } : {}),
        response_format: { type: 'json_object' },
      });
  }

  /**
   * One chat completion round.
   * @returns {{ content: string|null, toolCalls: Array<{id,name,args}> }}
   */
  async complete({ messages, tools = [] } = {}) {
    let attempt = 0;
    for (;;) {
      try {
        const response = await this.requestFn({ messages, tools });
        return normaliseResponse(response);
      } catch (err) {
        if (err instanceof MuseSparkError) throw err;
        const status = statusOf(err);
        const retryable = isRetryableStatus(status) || isTimeout(err);
        if (retryable && attempt < this.maxRetries) {
          attempt += 1;
          await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
          continue;
        }
        throw this.#normaliseError(err, status, retryable);
      }
    }
  }

  #normaliseError(err, status, retryable) {
    // Deliberately coarse messages: no URLs, bodies, headers, or key fragments.
    if (status === 401 || status === 403) {
      return new MuseSparkError('Muse Spark rejected the API credentials.', {
        status, code: 'auth_rejected', retryable: false,
      });
    }
    if (status === 429) {
      return new MuseSparkError('Muse Spark rate limit reached. Try again shortly.', {
        status, code: 'rate_limited', retryable: true,
      });
    }
    if (status === 404) {
      return new MuseSparkError('Muse Spark model or endpoint was not found.', {
        status, code: 'not_found', retryable: false,
      });
    }
    if (isTimeout(err)) {
      return new MuseSparkError('Muse Spark request timed out.', {
        status, code: 'timeout', retryable: true,
      });
    }
    if (status !== null && status >= 500) {
      return new MuseSparkError('Muse Spark service is temporarily unavailable.', {
        status, code: 'service_unavailable', retryable,
      });
    }
    return new MuseSparkError('Muse Spark request failed.', {
      status, code: 'request_failed', retryable,
    });
  }
}

function normaliseResponse(response) {
  const message = response?.choices?.[0]?.message ?? {};
  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls.map((call) => ({
        id: String(call?.id ?? ''),
        name: String(call?.function?.name ?? ''),
        args: safeParseArgs(call?.function?.arguments),
      }))
    : [];
  const content = typeof message.content === 'string' ? message.content : null;
  return { content, toolCalls };
}

function safeParseArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Build a client from app config, or null when no key is configured. */
export function createMuseClientFromConfig(config) {
  if (!config?.museSparkApiKey) return null;
  return new MuseSparkClient({
    apiKey: config.museSparkApiKey,
    baseURL: config.museSparkBaseUrl,
    model: config.museSparkModel,
    timeoutMs: config.museSparkTimeoutMs,
  });
}
