import { readFileSync } from 'node:fs';
const routes = JSON.parse(readFileSync(new URL('./routes.json', import.meta.url), 'utf8'));
export function listProviders() {
  return [
    { id: 'local', label: '本地 4090', kinds: ['image', 'edit', 'video'], configured: true, local: true },
    ...Object.entries(routes).map(([id, route]) => ({
      id,
      label: route.label,
      kinds: route.kinds,
      configured: route.keys.every((k) => Boolean(process.env[k]?.trim())),
      model: process.env[route.modelEnv] || route.model,
      local: id === 'selfhost',
      mask: false,
    })),
  ];
}
