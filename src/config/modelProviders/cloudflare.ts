import { ModelProviderCard } from '@/types/llm';

// ref https://developers.cloudflare.com/workers-ai/models/#text-generation
// api https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility
const Cloudflare: ModelProviderCard = {
  chatModels: [
    {
      description:
        'Generation over generation, Meta Llama 3 demonstrates state-of-the-art performance on a wide range of industry benchmarks and offers new capabilities, including improved reasoning.\t',
      displayName: 'meta-llama-3-8b-instruct',
      enabled: true,
      functionCall: false,
      id: '@hf/meta-llama/meta-llama-3-8b-instruct',
    },
  ],
  checkModel: '@hf/meta-llama/meta-llama-3-8b-instruct',
  id: 'cloudflare',
  modelList: {
    showModelFetcher: true,
  },
  name: 'Cloudflare Workers AI',
};

export default Cloudflare;
