import { ChatModelCard } from '@/types/llm';

import { LobeRuntimeAI } from '../BaseAI';
import { AgentRuntimeErrorType } from '../error';
import { ChatCompetitionOptions, ChatStreamPayload, ModelProvider } from '../types';
import { AgentRuntimeError } from '../utils/createError';
import { desensitizeUrl } from '../utils/desensitizeUrl';
import { StreamingResponse } from '../utils/response';

const CF_PROPERTY_NAME = 'property_id';
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
    const betaProperty = model['properties'].filter(
      (property: any) => property[CF_PROPERTY_NAME] === 'beta',
    );
    if (betaProperty.length === 1) {
      // eslint-disable-next-line eqeqeq
      return betaProperty[0]['value'].toLowerCase() == true; // This is a string now.
    }
    return false;
  } catch {
    return false;
  }
}

function getModelDisplayName(model: any, beta: boolean): string {
  const modelId = model['name'];
  let name = modelId.split('/').at(-1)!;
  if (beta) {
    name += ' (Beta)';
  }
  return name;
}

function getModelFunctionCalling(model: any): boolean {
  try {
    const fcProperty = model['properties'].filter(
      (property: any) => property[CF_PROPERTY_NAME] === 'function_calling',
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

function getModelTokens(model: any): number | undefined {
  try {
    const tokensProperty = model['properties'].filter(
      (property: any) => property[CF_PROPERTY_NAME] === 'max_total_tokens',
    );
    if (tokensProperty.length === 1) {
      return parseInt(tokensProperty[0]['value']);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

class CloudflareStreamTransformer {
  private textDecoder = new TextDecoder();
  private buffer: string = '';

  private parseChunk(chunk: string, controller: TransformStreamDefaultController) {
    const dataPrefix = /^data: /;
    const json = chunk.replace(dataPrefix, '');
    const parsedChunk = JSON.parse(json);
    controller.enqueue(`event: text\n`);
    controller.enqueue(`data: ${JSON.stringify(parsedChunk.response)}\n\n`);
  }

  public async transform(chunk: Uint8Array, controller: TransformStreamDefaultController) {
    let textChunk = this.textDecoder.decode(chunk);
    if (this.buffer.trim() !== '') {
      textChunk = this.buffer + textChunk;
      this.buffer = '';
    }
    const splits = textChunk.split('\n\n');
    for (let i = 0; i < splits.length - 1; i++) {
      if (/\[DONE]/.test(splits[i].trim())) {
        // [DONE] is not needed
        return;
      }
      this.parseChunk(splits[i], controller);
    }
    const lastChunk = splits.at(-1)!;
    if (lastChunk.trim() !== '') {
      this.buffer += lastChunk; // does not need to be trimmed.
    } // else drop.
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
        case 400: {
          throw AgentRuntimeError.chat({
            endpoint: desensitizedEndpoint,
            error: response,
            errorType: AgentRuntimeErrorType.ProviderBizError,
            provider: ModelProvider.Cloudflare,
          });
        }
      }

      return StreamingResponse(
        response.body!.pipeThrough(new TransformStream(new CloudflareStreamTransformer())),
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

  async models(): Promise<ChatModelCard[]> {
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
        const modelBeta = getModelBeta(model);
        return {
          description: model['description'],
          displayName: getModelDisplayName(model, modelBeta),
          enabled: !modelBeta,
          functionCall: getModelFunctionCalling(model),
          id: model['name'],
          tokens: getModelTokens(model),
        };
      });
      return chatModels;
    } catch {
      return [];
    }
  }
}
