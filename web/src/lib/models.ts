export interface ModelMeta {
  id: string;
  name: string;
  sub?: string;
  tier: 'free' | 'pro' | 'ultra' | 'auto';
}

export const MODELS: ModelMeta[] = [
  { id: 'auto', name: 'Chad MoE', sub: 'auto', tier: 'auto' },
  { id: 'fast', name: 'ChadGPT Fast', sub: 'Llama 3.1 8B', tier: 'free' },
  { id: 'small', name: 'ChadGPT Small', sub: 'Llama 3.2 3B', tier: 'free' },
  { id: 'tiny', name: 'ChadGPT Tiny', sub: 'Llama 3.2 1B', tier: 'free' },
  { id: 'mistral', name: 'Mistral 7B', tier: 'free' },
  { id: 'gemma', name: 'Gemma 7B', tier: 'free' },
  { id: 'openchat', name: 'OpenChat 3.5', tier: 'free' },
  { id: 'phi', name: 'Phi-2', tier: 'free' },
  { id: 'llama-3', name: 'Llama 3 8B', tier: 'pro' },
  { id: 'hermes', name: 'Hermes 2 Pro', tier: 'pro' },
  { id: 'qwen-14b', name: 'Qwen 1.5 14B', tier: 'pro' },
  { id: 'gemma-12b', name: 'Gemma 3 12B', tier: 'pro' },
  { id: 'mistral-24b', name: 'Mistral 24B', tier: 'pro' },
  { id: 'llama-70b', name: 'Llama 3.3 70B', tier: 'ultra' },
  { id: 'deepseek-r1', name: 'DeepSeek R1 32B', tier: 'ultra' },
  { id: 'qwen-coder', name: 'Qwen 2.5 Coder 32B', tier: 'ultra' },
];

export function modelById(id: string) { return MODELS.find(m => m.id === id) || MODELS[0]; }
