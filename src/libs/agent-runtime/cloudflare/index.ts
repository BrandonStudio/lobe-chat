import { ChatModelCard } from '@/types/llm';

import { LobeRuntimeAI } from '../BaseAI';
import { AgentRuntimeErrorType } from '../error';
import { ChatCompetitionOptions, ChatStreamPayload, ModelProvider } from '../types';
import { AgentRuntimeError } from '../utils/createError';
import { desensitizeUrl } from '../utils/desensitizeUrl';
import { StreamingResponse } from '../utils/response';

const DEFAULT_BASE_URL_PREFIX = 'https://api.cloudflare.com';

function fillUrl(accountID: string): string {
  return `${DEFAULT_BASE_URL_PREFIX}/client/v4/accounts/${accountID}/ai/run`;
}

function desensitizeAccountId(path: string): string {
  return path.replace(/\/[\dA-Fa-f]{32}\//, '/****/');
}

function desensitizeCloudflareUrl(url: string): string {
  const urlObj = new URL(url);
  let { protocol, hostname, port, pathname, search } = urlObj;
  if (url.startsWith(DEFAULT_BASE_URL_PREFIX)) {
    return `${protocol}//${hostname}${port ? `:${port}` : ''}${desensitizeAccountId(pathname)}${search}`;
  } else {
    const desensitizedUrl = desensitizeUrl(`${protocol}//${hostname}${port ? `:${port}` : ''}`);
    return `${desensitizedUrl}${desensitizeAccountId(pathname)}${search}`;
  }
}

function getModelBeta(model: any): boolean {
  try {
    const betaProperty = model['properties'].filter((property: any) => property['name'] === 'beta');
    if (betaProperty.length === 1) {
      // eslint-disable-next-line eqeqeq
      return betaProperty[0]['value'].toLowerCase() == true; // This is a string now.
    }
    return false;
  } catch {
    return false;
  }
}

function getModelDisplayName(model: any): string {
  const modelId = model['name'];
  let name = modelId.split('/').at(-1)!;
  const beta = getModelBeta(model);
  if (beta) {
    name += ' (Beta)';
  }
  return name;
}

function getModelFunctionCalling(model: any): boolean {
  try {
    const fcProperty = model['properties'].filter(
      (property: any) => property['name'] === 'function_calling',
    );
    if (fcProperty.length === 1) {
      // eslint-disable-next-line eqeqeq
      return fcProperty[0]['value'].toLowerCase() == true;
    }
    return false;
  } catch {
    return false;
  }
}

export class LobeCloudflareAI implements LobeRuntimeAI {
  baseURL: string;
  accountID: string;
  apiKey?: string;

  constructor({ baseURLOrAccountID, apiKey }: { apiKey?: string; baseURLOrAccountID: string }) {
    if (baseURLOrAccountID.startsWith('http')) {
      this.baseURL = baseURLOrAccountID;
      // Try get accountID from baseURL
      this.accountID = baseURLOrAccountID.replaceAll(/^.*\/([\dA-Fa-f]{32})\/.*$/g, '$1');
    } else {
      this.accountID = baseURLOrAccountID;
      this.baseURL = fillUrl(baseURLOrAccountID);
    }
    this.apiKey = apiKey;
  }

  async chat(payload: ChatStreamPayload, options?: ChatCompetitionOptions): Promise<Response> {
    try {
      const { model, tools, ...restPayload } = payload;
      const functions = tools?.map((tool) => tool.function);
      const headers = options?.headers || {};
      if (this.apiKey) {
        headers['Authorization'] = `Bearer ${this.apiKey}`;
      }
      const url = new URL(model, this.baseURL);
      const response = await fetch(url, {
        body: JSON.stringify({ tools: functions, ...restPayload }),
        headers: { 'Content-Type': 'application/json', ...headers },
        method: 'POST',
      });

      const desensitizedEndpoint = desensitizeCloudflareUrl(this.baseURL);

      switch (response.status) {
        case 401: {
          throw AgentRuntimeError.chat({
            endpoint: desensitizedEndpoint,
            error: response,
            errorType: AgentRuntimeErrorType.InvalidProviderAPIKey,
            provider: ModelProvider.Anthropic,
          });
        }
        case 403: {
          throw AgentRuntimeError.chat({
            endpoint: desensitizedEndpoint,
            error: response,
            errorType: AgentRuntimeErrorType.LocationNotSupportError,
            provider: ModelProvider.Anthropic,
          });
        }
      }

      return StreamingResponse(
        response.body!.pipeThrough(
          new TransformStream({
            // TODO: Decide whether to handle undefined body.
            async transform(chunk, controller) {
              // Assume that chunk is text in form of `data: {"response": <text>, ...}`.
              const textDecoder = new TextDecoder();
              let textChunk = textDecoder.decode(chunk);
              const dataPrefix = 'data: ';
              textChunk = textChunk.replace(dataPrefix, '');
              try {
                const parsedChunk = JSON.parse(textChunk);
                controller.enqueue(`event: text\n`);
                controller.enqueue(`data: ${JSON.stringify(parsedChunk.response)}\n\n`);
              } catch (e) {
                if (textChunk.toUpperCase().includes('[DONE]')) {
                  // Assume that chunk with "[DONE]" does not contain any other data.
                  // [DONE] is not needed
                  // controller.enqueue("data: [DONE]\n\n");
                  controller.terminate();
                  return;
                } else {
                  throw e;
                }
              }
            },
          }),
        ),
      );
    } catch (error) {
      const desensitizedEndpoint = desensitizeCloudflareUrl(this.baseURL);

      throw AgentRuntimeError.chat({
        endpoint: desensitizedEndpoint,
        error: error as any,
        errorType: AgentRuntimeErrorType.ProviderBizError,
        provider: ModelProvider.Anthropic,
      });
    }
  }

  async getModels(): Promise<ChatModelCard[]> {
    try {
      const url = `${DEFAULT_BASE_URL_PREFIX}/client/v4/accounts/${this.accountID}/ai/models/search`;
      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        method: 'GET',
      });
      const j = await response.json();
      const models: any[] = j['result'].filter(
        (model: any) => model['task']['name'] === 'Text Generation',
      );
      const chatModels: ChatModelCard[] = models.map((model) => {
        return {
          description: model['description'],
          displayName: getModelDisplayName(model),
          enabled: true,
          functionCall: getModelFunctionCalling(model),
          id: model['id'],
        };
      });
      return chatModels;
    } catch {
      return [];
    }
  }
}
